/**
 * Global session discovery and durable index (parent design §2.3–§2.4, §3).
 *
 * `UsageStore` combines the durable `RecordStore` with a defensive session
 * scanner built on Pi's `SessionManager`:
 *
 * - `SessionManager.listAll()` discovers every local session file;
 * - `SessionManager.open(path)` + `getEntries()` reads entries per session;
 * - every entry is decoded defensively — one malformed line or file is
 *   skipped and counted in a non-fatal diagnostic summary (SC1);
 * - scans are single-flight and coalesced: concurrent `refresh()` calls share
 *   one in-flight scan, and events arriving during a scan set a dirty flag
 *   that triggers exactly one follow-up pass (SC6);
 * - live `message_end` records and scanned history share the domain
 *   `recordId`, so upsert semantics never double-count (SC2).
 *
 * Pi session files are the authoritative source; the local index is a
 * rebuildable cache (SC3/SC4).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager, getAgentDir, type SessionEntry, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { PricingTable, UsageFilters, UsageQueryResult, UsageRecord, SessionContext } from "../domain";
import {
  BUILTIN_PRICE_TABLE,
  applyCostPolicy,
  assistantMessageEntryId,
  mergePricingTables,
  normalizeAssistantMessage,
  normalizeSummaryUsage,
  parsePricingTableJson,
} from "../domain";
import { RecordStore, STORE_SCHEMA_VERSION } from "./record-store";

/** Optional local price override filename under the store directory. */
export const PRICING_FILE = "pricing.json";

/** Directory name for the plugin's durable state under the agent dir. */
export const STORE_DIR_NAME = "token-usage-statistics";

export type ScanSummary = {
  /** Total sessions discovered by listAll(). */
  sessionsFound: number;
  /** Sessions that produced at least one canonical record. */
  sessionsScanned: number;
  /** Sessions that failed to open/read entirely (non-fatal). */
  sessionErrors: number;
  /** Individual malformed/unusable entries skipped. */
  entryErrors: number;
  /** Records merged into the store after this scan. */
  recordsMerged: number;
  /** True when the scan was a full rebuild vs incremental. */
  rebuilt: boolean;
  /** Epoch ms when the scan completed. */
  finishedAtMs: number;
};

export type StoreDependencies = {
  /** Store directory; defaults to `<agent-dir>/token-usage-statistics`. */
  storeDir?: string;
  /** Session directory override (tests). */
  sessionDir?: string;
  /** Progress callback, invoked with (done, total) during discovery. */
  progress?: (done: number, total: number) => void;
};

/**
 * Defensive decoder: one session entry -> usage records. Assistant messages
 * normalize via the domain `normalizeAssistantMessage`; compaction and
 * branch-summary entries carry optional summary usage. Returns an empty array
 * for entries that carry no countable usage; never throws.
 *
 * Cost policy (recorded → estimated → unavailable) is applied here so scanned
 * history matches the live collector path.
 */
export function decodeSessionEntry(
  entry: SessionEntry,
  ctx: Omit<SessionContext, "entryId">,
  priceTable: PricingTable = BUILTIN_PRICE_TABLE,
): UsageRecord[] {
  if (!entry || typeof entry !== "object") return [];
  const entryTs = parseStrictTimestampMs(entry.timestamp);
  const timestampMs = entryTs ?? Date.now();
  switch (entry.type) {
    case "message": {
      // Prefer the message's own epoch-ms timestamp; fall back to the entry
      // timestamp (ISO) so old entries keep their true time instead of
      // drifting to "now" on every rescan (SC2).
      const message = withEntryTimestampFallback(entry.message, timestampMs);
      // Same identity rule as the live message_end collector (responseId,
      // else timestamp+content fingerprint). When the persisted message lacks
      // a timestamp but the entry has a real one, identity uses the backfilled
      // message so live+scan share one recordId (SC2). Only when the entry
      // timestamp itself is unparseable do we fall back to entry.id.
      const messageForId =
        entryTs !== null ? withEntryTimestampFallback(entry.message, entryTs) : entry.message;
      const record = normalizeAssistantMessage(message, {
        ...ctx,
        entryId: assistantMessageEntryId(messageForId, entry.id ?? ""),
      });
      return record ? [applyCostPolicy(record, priceTable)] : [];
    }
    case "compaction":
    case "branch_summary": {
      const entryId = entry.id ?? "";
      if (!entryId) return [];
      const usage = (entry as { usage?: unknown }).usage;
      if (usage === undefined || usage === null) return [];
      const record = normalizeSummaryUsage(usage, { ...ctx, entryId, timestampMs });
      return record ? [applyCostPolicy(record, priceTable)] : [];
    }
    default:
      return [];
  }
}

/**
 * Parse a session-entry timestamp strictly. Returns null when unparseable so
 * identity logic never invents a Date.now() fingerprint that would change
 * across rescans.
 */
const parseStrictTimestampMs = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

/**
 * Assistant messages carry their own epoch-ms `timestamp` when present.
 * Older/incomplete sessions may omit it; backfill from the entry-level
 * timestamp so scanned history keeps a stable, correct time (SC2).
 */
const withEntryTimestampFallback = (message: unknown, entryTimestampMs: number): unknown => {
  if (!message || typeof message !== "object") return message;
  const msg = message as { timestamp?: unknown };
  if (typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)) return message;
  return { ...msg, timestamp: entryTimestampMs };
};

export class UsageStore {
  private readonly store: RecordStore;
  private readonly sessionDir: string | undefined;
  private readonly progress: ((done: number, total: number) => void) | undefined;

  /** Single in-flight scan; concurrent refresh() calls await the same promise (SC6). */
  private inflight: Promise<ScanSummary> | null = null;
  /** Set when a new record/event arrives while a scan is running. */
  private dirtyDuringScan = false;
  /** A rebuild queued behind an in-flight scan (runs once the pending pass drains). */
  private queuedRebuild: Promise<ScanSummary> | null = null;
  /** Records upserted live (message_end path) that a scan must reconcile. */
  private liveRecords = new Map<string, UsageRecord>();
  /** True after a scan completed at least once; queries may serve cached state. */
  private scannedOnce = false;
  /** Active price table (builtin merged with optional local override). */
  private priceTable: PricingTable = BUILTIN_PRICE_TABLE;
  /** Serialize scans, reloads, and persistence without overlapping disk work. */
  private operationTail: Promise<unknown> = Promise.resolve();
  /** Coalesced live persistence state. */
  private persistPending = false;
  private persistPromise: Promise<void> | null = null;
  private acceptingRuntimeWork = true;
  private stopPromise: Promise<void> | null = null;

  constructor(deps: StoreDependencies = {}) {
    const agentDir = getAgentDir();
    this.store = new RecordStore({
      storeDir: deps.storeDir ?? join(agentDir, STORE_DIR_NAME),
    });
    this.sessionDir = deps.sessionDir;
    this.progress = deps.progress;
  }

  /** Initialize: load the durable index + optional pricing.json (non-fatal). */
  async init(): Promise<void> {
    this.acceptingRuntimeWork = true;
    this.stopPromise = null;
    await this.enqueueOperation(async () => {
      await this.store.load();
      await this.loadPricingOverride();
    });
  }

  /**
   * Load `<storeDir>/pricing.json` when present. Invalid/missing files leave
   * the built-in table unchanged (DC4: overrides are all-or-nothing).
   */
  private async loadPricingOverride(): Promise<void> {
    try {
      const text = await readFile(join(this.store.directory, PRICING_FILE), "utf8");
      const override = parsePricingTableJson(text);
      if (override) {
        this.priceTable = mergePricingTables(override, BUILTIN_PRICE_TABLE);
      }
    } catch {
      // Absent or unreadable override is fine — keep builtin.
    }
  }

  /** Current price table (tests / live collector). */
  getPricingTable(): PricingTable {
    return this.priceTable;
  }

  /** Path of the durable records file (disk-polling / tests). */
  get recordsFilePath(): string {
    return this.store.recordsFilePath;
  }

  /** Number of live (message_end) records not yet reconciled by a scan (diagnostics/tests). */
  get liveRecordCount(): number {
    return this.liveRecords.size;
  }

  query(filters: UsageFilters, refreshedAtMs?: number): UsageQueryResult {
    return this.store.query(filters, refreshedAtMs);
  }

  /**
   * Live event path (message_end): apply cost policy and update memory first.
   * The caller separately schedules `persistLiveRecord()` so this method stays
   * synchronous and never waits for disk I/O (R1).
   */
  upsertRecord(record: UsageRecord): UsageRecord {
    const priced = applyCostPolicy(record, this.priceTable);
    this.store.upsertRecord(priced);
    this.liveRecords.set(priced.recordId, priced);
    if (this.inflight) this.dirtyDuringScan = true;
    return priced;
  }

  /**
   * Schedule a single-flight, coalesced live flush. The returned promise is
   * useful to tests and shutdown; message_end intentionally does not await it.
   * A failed pass keeps the store dirty so a later event or stop() can retry.
   */
  persistLiveRecord(): Promise<void> {
    if (!this.acceptingRuntimeWork) return Promise.resolve();
    this.persistPending = true;
    if (!this.persistPromise) {
      this.persistPromise = Promise.resolve()
        .then(async () => {
          while (this.persistPending) {
            this.persistPending = false;
            try {
              await this.enqueueOperation(async () => {
                // Keep the live overlay authoritative even if an overlapping
                // load replaced the RecordStore's private snapshot before
                // this queued persistence pass started.
                const live = [...this.liveRecords.values()];
                if (live.length > 0) this.store.merge(live);
                if (this.store.isDirty) await this.store.flush();
              });
            } catch (error) {
              this.persistPending = true;
              throw error;
            }
          }
        })
        .finally(() => {
          this.persistPromise = null;
        });
    }
    return this.persistPromise;
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** One coalesced scan pass with optional per-call progress (design contract). */
  scanAll(opts: { progress?: (done: number, total: number) => void } = {}): Promise<ScanSummary> {
    return this.startScan(false, opts.progress);
  }

  /** Coalesced background rescan (single-flight + one follow-up pass). */
  refresh(): Promise<ScanSummary> {
    // A concurrent refresh just joins the in-flight scan; it is not a new
    // event, so it must not arm the dirty-flag follow-up pass (SC6).
    return this.startScan(false);
  }

  /** Single-flight start: concurrent requests share the in-flight promise. */
  private startScan(rebuilt: boolean, progress?: (done: number, total: number) => void): Promise<ScanSummary> {
    if (this.inflight) return this.inflight;
    const scan = this.enqueueOperation(() => this.runScan(rebuilt, progress)).finally(() => {
      if (this.inflight === scan) this.inflight = null;
    });
    this.inflight = scan;
    return scan;
  }

  /**
   * Full rebuild from session files (ignores cached index state).
   *
   * When a scan is already in flight, this queues exactly one rebuild to run
   * after the pending pass drains — a rebuild is a stronger contract than a
   * refresh and must actually purge stale records, not silently degrade to an
   * incremental merge (SC4).
   */
  rebuild(): Promise<ScanSummary> {
    if (this.inflight) {
      if (!this.queuedRebuild) {
        this.queuedRebuild = this.inflight
          .then(() => this.rebuild())
          .finally(() => {
            this.queuedRebuild = null;
          });
      }
      return this.queuedRebuild;
    }
    return this.startScan(true);
  }

  /** Flush pending writes and release resources. */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.acceptingRuntimeWork = false;
    this.stopPromise = (async () => {
      // Drain queued rebuild chains too: the in-flight scan can hand off to a
      // follow-up rebuild before resolving. A failed scan must not skip the
      // final persistence pass required by normal shutdown.
      while (this.inflight || this.queuedRebuild) {
        const pendingScan = this.queuedRebuild ?? this.inflight;
        if (!pendingScan) break;
        await pendingScan.catch(() => undefined);
      }
      // A live pass may be queued behind the scan. Its failure is retried by
      // the final flush below; shutdown must not abandon dirty data.
      await this.persistPromise?.catch(() => undefined);
      await this.enqueueOperation(async () => {
        if (this.store.isDirty) await this.store.flush();
        this.persistPending = false;
      });
    })();
    return this.stopPromise;
  }

  /**
   * Reload all records from disk, picking up writes from other pi processes
   * (multi-window use): flush this process's pending memory first so no live
   * record is lost, then load the merged file, then drop the live overlay map
   * (its records are now part of the durable file). Failures are non-fatal:
   * on error the in-memory state is kept as-is.
   */
  async reloadFromDisk(): Promise<boolean> {
    try {
      // Persistence is already serialized with this operation. If a live
      // record arrives while load() is awaiting I/O, overlay it afterwards and
      // merge it under the same lock before clearing the live set.
      await this.persistPromise?.catch(() => undefined);
      await this.enqueueOperation(async () => {
        if (this.store.isDirty) await this.store.flush();
        await this.store.load();
        const live = [...this.liveRecords.values()];
        if (live.length > 0) {
          this.store.merge(live);
          await this.store.flush();
        }
        // A message_end may arrive while the final flush is awaiting I/O.
        // Clear only the exact overlay values included in this durable pass.
        for (const record of live) {
          if (this.liveRecords.get(record.recordId) === record) this.liveRecords.delete(record.recordId);
        }
        this.scannedOnce = true;
      });
      return true;
    } catch {
      // Non-fatal: keep whatever in-memory state we have and let the poller
      // retry the same baseline on its next tick.
      return false;
    }
  }

  private async runScan(rebuilt: boolean, progress?: (done: number, total: number) => void): Promise<ScanSummary> {
    const summary: ScanSummary = {
      sessionsFound: 0,
      sessionsScanned: 0,
      sessionErrors: 0,
      entryErrors: 0,
      recordsMerged: 0,
      rebuilt,
      finishedAtMs: Date.now(),
    };
    try {
      let sessions: SessionInfo[];
      try {
        sessions = await SessionManager.listAll(this.sessionDir, (done, total) => {
          summary.sessionsFound = total;
          (progress ?? this.progress)?.(done, total);
        });
      } catch {
        // listAll failed entirely: non-fatal, keep whatever the store has.
        summary.sessionErrors = 1;
        await this.store.flush();
        return summary;
      }
      summary.sessionsFound = sessions.length;

      const scanned: UsageRecord[] = [];
      for (const info of sessions) {
        let manager: SessionManager;
        try {
          manager = SessionManager.open(info.path, this.sessionDir, info.cwd);
        } catch {
          summary.sessionErrors += 1;
          continue;
        }
        let entries: SessionEntry[];
        try {
          entries = manager.getEntries();
        } catch {
          summary.sessionErrors += 1;
          continue;
        }
        summary.sessionsScanned += 1;
        const ctx: Omit<SessionContext, "entryId"> = {
          sessionId: info.id || info.path,
          sessionPath: info.path,
          projectCwd: info.cwd ?? "",
        };
        for (const entry of entries) {
          try {
            const records = decodeSessionEntry(entry, ctx, this.priceTable);
            scanned.push(...records);
          } catch {
            summary.entryErrors += 1; // one bad entry never stops the session
          }
        }
      }

      const live = [...this.liveRecords.values()];
      if (rebuilt) {
        // Full rebuild: scanned sessions are authoritative for everything we
        // could see; live records from the running session merge on top so an
        // event recorded mid-scan is not lost.
        const merged = new Map<string, UsageRecord>();
        for (const record of scanned) merged.set(record.recordId, record);
        for (const record of live) merged.set(record.recordId, record);
        const rebuiltRecords = [...merged.values()];
        summary.recordsMerged = rebuiltRecords.length;
        this.store.replaceAll(rebuiltRecords);
      } else {
        // Incremental: merge scanned records into the cached index (upsert by
        // recordId), then overlay live records so the running session is
        // always current.
        this.store.merge(scanned);
        this.store.merge(live);
        summary.recordsMerged = scanned.length + live.length;
      }
      // Drop only the exact live overlay values reconciled by this pass. A
      // newer message_end with the same recordId may arrive while the scan or
      // its flush is awaiting I/O and must remain available for the follow-up.
      const scannedIds = new Set(scanned.map((r) => r.recordId));
      for (const record of live) {
        if (scannedIds.has(record.recordId) && this.liveRecords.get(record.recordId) === record) {
          this.liveRecords.delete(record.recordId);
        }
      }
      this.scannedOnce = true;
      await this.store.flush({ replaceDisk: rebuilt });
    } finally {
      summary.finishedAtMs = Date.now();
    }

    // Follow-up pass: a record arrived while we were scanning (SC6).
    if (this.dirtyDuringScan && !rebuilt) {
      this.dirtyDuringScan = false;
      return this.runScan(false);
    }
    this.dirtyDuringScan = false;
    return summary;
  }

  get schemaVersion(): number {
    return STORE_SCHEMA_VERSION;
  }

  get hasScanned(): boolean {
    return this.scannedOnce;
  }
}
