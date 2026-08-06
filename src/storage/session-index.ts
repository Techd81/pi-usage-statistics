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
import { join } from "node:path";
import { SessionManager, getAgentDir, type SessionEntry, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { UsageFilters, UsageQueryResult, UsageRecord, SessionContext } from "../domain";
import { normalizeAssistantMessage, normalizeSummaryUsage } from "../domain";
import { RecordStore, STORE_SCHEMA_VERSION } from "./record-store";

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
 */
export function decodeSessionEntry(entry: SessionEntry, ctx: Omit<SessionContext, "entryId">): UsageRecord[] {
  if (!entry || typeof entry !== "object") return [];
  const sessionCtx: SessionContext = { ...ctx, entryId: entry.id ?? "" };
  if (!sessionCtx.entryId) return [];
  const timestampMs = readTimestampMs(entry.timestamp);
  switch (entry.type) {
    case "message": {
      // Prefer the message's own epoch-ms timestamp; fall back to the entry
      // timestamp (ISO, parsed above) so old entries keep their true time
      // instead of drifting to "now" on every rescan (SC2).
      const record = normalizeAssistantMessage(withEntryTimestampFallback(entry.message, timestampMs), sessionCtx);
      return record ? [record] : [];
    }
    case "compaction":
    case "branch_summary": {
      const usage = (entry as { usage?: unknown }).usage;
      if (usage === undefined || usage === null) return [];
      const record = normalizeSummaryUsage(usage, { ...sessionCtx, timestampMs });
      return record ? [record] : [];
    }
    default:
      return [];
  }
}

/**
 * Parse a session-entry timestamp. Entries store ISO strings; assistant
 * messages embed epoch-ms numbers. Anything unparseable falls back to "now"
 * so a record is never dropped for a missing clock value.
 */
const readTimestampMs = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
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

  constructor(deps: StoreDependencies = {}) {
    const agentDir = getAgentDir();
    this.store = new RecordStore({
      storeDir: deps.storeDir ?? join(agentDir, STORE_DIR_NAME),
    });
    this.sessionDir = deps.sessionDir;
    this.progress = deps.progress;
  }

  /** Initialize: load the durable index from disk (non-fatal on corruption). */
  async init(): Promise<void> {
    await this.store.load();
  }

  query(filters: UsageFilters, refreshedAtMs?: number): UsageQueryResult {
    return this.store.query(filters, refreshedAtMs);
  }

  /**
   * Live event path (message_end): upsert immediately so the current session
   * reflects the record, then mark the store dirty so the next scan
   * reconciles rather than double-counting (SC2).
   */
  upsertRecord(record: UsageRecord): void {
    this.store.upsertRecord(record);
    this.liveRecords.set(record.recordId, record);
    if (this.inflight) this.dirtyDuringScan = true;
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
    const scan = this.runScan(rebuilt, progress).finally(() => {
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
    // Drain queued rebuild chains too: the in-flight scan can hand off to a
    // follow-up rebuild before resolving.
    while (this.inflight) await this.inflight;
    await this.store.flush();
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
            const records = decodeSessionEntry(entry, ctx);
            scanned.push(...records);
          } catch {
            summary.entryErrors += 1; // one bad entry never stops the session
          }
        }
      }

      if (rebuilt) {
        // Full rebuild: scanned sessions are authoritative for everything we
        // could see; live records from the running session merge on top so an
        // event recorded mid-scan is not lost.
        const merged = new Map<string, UsageRecord>();
        for (const record of scanned) merged.set(record.recordId, record);
        for (const record of this.liveRecords.values()) merged.set(record.recordId, record);
        const rebuiltRecords = [...merged.values()];
        summary.recordsMerged = rebuiltRecords.length;
        this.store.replaceAll(rebuiltRecords);
      } else {
        // Incremental: merge scanned records into the cached index (upsert by
        // recordId), then overlay live records so the running session is
        // always current.
        this.store.merge(scanned);
        this.store.merge([...this.liveRecords.values()]);
        summary.recordsMerged = scanned.length + this.liveRecords.size;
      }
      this.scannedOnce = true;
      await this.store.flush();
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
