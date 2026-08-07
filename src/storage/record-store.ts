/**
 * Durable record store: plugin-owned cache of normalized usage records.
 *
 * Pi session files remain the authoritative source; this index is a
 * rebuildable acceleration layer (parent design §3). Writes are atomic
 * (temp file + rename), the final truncated line is tolerated on read,
 * the schema is versioned, and compaction keeps the file bounded.
 */
import { mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CostBreakdown, UsageFilters, UsageQueryResult, UsageRecord } from "../domain";
import { indexByRecordId, mergeRecords, queryUsage, upsertRecord } from "../domain";

/** Schema version of the durable index; bump on incompatible format changes. */
export const STORE_SCHEMA_VERSION = 1;

/** Default file names inside the store directory. */
export const RECORDS_FILE = "records.jsonl";
export const INDEX_FILE = "index.json";

/** Bounded retention: when the records file exceeds this many lines, compact. */
export const DEFAULT_MAX_RECORDS = 50_000;

export type StoreOptions = {
  /** Directory that holds records.jsonl / index.json (defaults to storeDir). */
  storeDir: string;
  /** Above this record count the file is compacted on the next write. */
  maxRecords?: number;
};

export type StoreSnapshot = {
  records: readonly UsageRecord[];
  schemaVersion: number;
  compactedCount: number;
};

/**
 * Atomic write: write to a temp file in the same directory, then rename over
 * the target. A crash mid-write leaves the previous file intact.
 */
async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(tempPath, contents, "utf8");
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

const LOCK_RETRY_COUNT = 40;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_STALE_AFTER_MS = 10_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialize writers from independent Pi processes. Exclusive lock creation is
 * supported by Node on all platforms; stale artifacts are removed so a killed
 * process cannot permanently disable persistence.
 */
async function withWriteLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  await mkdir(dirname(filePath), { recursive: true });
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let acquired = false;
  let wroteToken = false;
  try {
    for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
      try {
        handle = await open(lockPath, "wx");
        acquired = true;
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAtMs: Date.now() }), "utf8");
        wroteToken = true;
        heartbeat = setInterval(() => {
          void utimes(lockPath, new Date(), new Date()).catch(() => undefined);
        }, Math.max(1000, Math.floor(LOCK_STALE_AFTER_MS / 3)));
        heartbeat.unref?.();
        break;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        handle = null;
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > LOCK_STALE_AFTER_MS) {
            await rm(lockPath, { force: true, recursive: true });
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
        }
        if (attempt === LOCK_RETRY_COUNT - 1) {
          throw new Error(`Timed out acquiring records lock: ${lockPath}`);
        }
        await delay(LOCK_RETRY_DELAY_MS);
      }
    }
    return await operation();
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat);
    await handle?.close().catch(() => undefined);
    // A stale-lock recovery can race with the original owner. Never remove a
    // successor's lock when releasing this one.
    const currentToken = await readFile(lockPath, "utf8")
      .then((text) => {
        try {
          const value = JSON.parse(text) as { token?: unknown };
          return typeof value.token === "string" ? value.token : null;
        } catch {
          return null;
        }
      })
      .catch(() => null);
    if (currentToken === token || (acquired && !wroteToken && currentToken === null)) {
      await rm(lockPath, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isCostBreakdown = (value: unknown): value is CostBreakdown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cost = value as Record<string, unknown>;
  return (
    isFiniteNonNegative(cost.input) &&
    isFiniteNonNegative(cost.output) &&
    isFiniteNonNegative(cost.cacheRead) &&
    isFiniteNonNegative(cost.cacheWrite) &&
    isFiniteNonNegative(cost.total)
  );
};

/**
 * Structural guard for the store's own persisted format. Only lines carrying
 * the full normalized record shape are admitted; parseable-but-garbage lines
 * are skipped like any other malformed line so aggregation can never see
 * NaN/string token fields (SC1).
 */
const isUsageRecordLike = (value: unknown): value is UsageRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.recordId !== "string" || record.recordId === "") return false;
  for (const key of ["timestampMs", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const) {
    if (!isFiniteNonNegative(record[key])) return false;
  }
  if (record.requestCount !== 1) return false;
  if (record.costKind !== "recorded" && record.costKind !== "estimated" && record.costKind !== "unavailable") return false;
  if (record.sourceKind !== "assistant" && record.sourceKind !== "summary") return false;
  for (const key of ["sessionId", "sessionPath", "projectCwd", "provider", "model", "sourceEntryId"] as const) {
    if (typeof record[key] !== "string") return false;
  }
  if (record.recordedCost !== undefined && !isCostBreakdown(record.recordedCost)) return false;
  if (record.estimatedCost !== undefined && !isCostBreakdown(record.estimatedCost)) return false;
  return true;
};

/**
 * Read a JSONL file defensively: a malformed or truncated final line is
 * skipped (counted) instead of failing the whole read. Returns the parsed
 * records plus the number of skipped lines.
 */
function readRecordsJsonl(text: string): { records: UsageRecord[]; skipped: number } {
  const records: UsageRecord[] = [];
  let skipped = 0;
  const lines = text.split("\n");
  // A trailing newline produces an empty final element; drop it.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isUsageRecordLike(value)) {
        records.push(value);
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1; // malformed or truncated final line
    }
  }
  return { records, skipped };
}

export class RecordStore {
  private readonly storeDir: string;
  private readonly maxRecords: number;
  private records: UsageRecord[] = [];
  private currentSchemaVersion = STORE_SCHEMA_VERSION;
  private dirty = false;
  /** Changes made while an async flush is in progress must not be clobbered. */
  private mutationRevision = 0;
  /** IDs present when this instance last loaded/durably merged the file. */
  private loadedRecordIds = new Set<string>();

  constructor(options: StoreOptions) {
    this.storeDir = options.storeDir;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  }

  get directory(): string {
    return this.storeDir;
  }

  get recordsFilePath(): string {
    return join(this.storeDir, RECORDS_FILE);
  }

  get indexFilePath(): string {
    return join(this.storeDir, INDEX_FILE);
  }

  /** All in-memory records (immutable snapshot for readers). */
  snapshot(): StoreSnapshot {
    return { records: [...this.records], schemaVersion: this.currentSchemaVersion, compactedCount: 0 };
  }

  query(filters: UsageFilters, refreshedAtMs?: number): UsageQueryResult {
    return queryUsage(this.records, filters, refreshedAtMs);
  }

  /** Upsert one record by recordId and mark the store dirty for persistence. */
  upsertRecord(record: UsageRecord): void {
    this.records = upsertRecord(this.records, record);
    this.mutationRevision += 1;
    this.dirty = true;
  }

  /** Replace all in-memory records with a scanned set (dedupe by recordId). */
  replaceAll(records: readonly UsageRecord[]): void {
    this.records = [...indexByRecordId(records).values()];
    this.mutationRevision += 1;
    this.dirty = true;
  }

  /** Merge scanned records into the store; later records win per recordId. */
  merge(records: readonly UsageRecord[]): void {
    this.records = mergeRecords(this.records, records);
    this.mutationRevision += 1;
    // mergeRecords may have replaced values even when the length is unchanged,
    // so always mark the store dirty (conservative).
    this.dirty = true;
  }

  /**
   * Load persisted state from disk. Missing files are fine (fresh start);
   * a corrupt index.json falls back to a fresh schema (records.jsonl is the
   * durable payload; index.json only holds schema metadata). The records
   * file tolerates malformed/truncated lines (SC3).
   */
  async load(): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });
    let text = "";
    try {
      text = await readFile(this.recordsFilePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      text = ""; // absent file = fresh store
    }
    const { records, skipped } = readRecordsJsonl(text);
    this.records = records;
    this.loadedRecordIds = new Set(records.map((record) => record.recordId));
    this.mutationRevision += 1;
    this.dirty = skipped > 0; // a truncated tail warrants a rewrite on next flush

    let schemaVersion = STORE_SCHEMA_VERSION;
    try {
      const raw = JSON.parse(await readFile(this.indexFilePath, "utf8")) as unknown;
      if (raw && typeof raw === "object" && typeof (raw as { schemaVersion?: unknown }).schemaVersion === "number") {
        schemaVersion = (raw as { schemaVersion: number }).schemaVersion;
      }
    } catch {
      schemaVersion = STORE_SCHEMA_VERSION; // corrupt/absent index -> current schema
    }
    this.currentSchemaVersion = schemaVersion;
    if (schemaVersion !== STORE_SCHEMA_VERSION) {
      // Deterministic rebuild on schema mismatch (SC4): drop cached payload,
      // let the scanner repopulate from sessions.
      this.records = [];
      // Keep loadedRecordIds: replaceDisk can then discard this known-stale
      // cache while preserving distinct records another process adds later.
      this.currentSchemaVersion = STORE_SCHEMA_VERSION;
      this.mutationRevision += 1;
      this.dirty = true;
    }
  }

  /**
   * Persist the in-memory state atomically. Normal writes merge with the
   * current shared file under the lock; an explicit replacement is reserved
   * for full rebuilds, whose scanner contract purges stale cache records.
   */
  async flush(options: { replaceDisk?: boolean } = {}): Promise<void> {
    await withWriteLock(this.recordsFilePath, async () => {
      // Always merge under the lock. A process may have loaded an older
      // private snapshot while another Pi window has since appended records.
      // Replacing the file from that snapshot would lose the other window's
      // distinct recordIds.
      let diskRecords: UsageRecord[] = [];
      try {
        const text = await readFile(this.recordsFilePath, "utf8");
        diskRecords = readRecordsJsonl(text).records;
      } catch (error) {
        // Only a missing file is a normal first-write case. Permission and
        // other read failures must abort rather than replacing unknown data.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      const revision = this.mutationRevision;
      const localRecords = [...this.records];
      // A rebuild intentionally replaces this instance's old cache, but must
      // retain record IDs added by another process after our last load. This
      // avoids turning a full scan into a cross-process lost update.
      const rebuildExternal = diskRecords.filter((record) => !this.loadedRecordIds.has(record.recordId));
      const merged = options.replaceDisk ? mergeRecords(rebuildExternal, localRecords) : mergeRecords(diskRecords, localRecords);
      const durableRecords = merged.length > this.maxRecords ? [...indexByRecordId(merged).values()] : merged;
      const lines = durableRecords.map((record) => JSON.stringify(record)).join("\n") + (durableRecords.length > 0 ? "\n" : "");
      await atomicWrite(this.recordsFilePath, lines);
      await atomicWrite(
        this.indexFilePath,
        JSON.stringify({ schemaVersion: this.currentSchemaVersion, updatedAtMs: Date.now() }, null, 2),
      );
      if (this.mutationRevision === revision) {
        this.records = durableRecords;
        this.loadedRecordIds = new Set(durableRecords.map((record) => record.recordId));
        this.dirty = false;
      }
    });
  }

  /** Drop all persisted state and in-memory records; the store starts fresh. */
  async reset(): Promise<void> {
    this.records = [];
    this.loadedRecordIds.clear();
    this.currentSchemaVersion = STORE_SCHEMA_VERSION;
    this.mutationRevision += 1;
    this.dirty = false;
    await mkdir(this.storeDir, { recursive: true });
    await rm(this.recordsFilePath, { force: true });
    await rm(this.indexFilePath, { force: true });
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  get schemaVersion(): number {
    return this.currentSchemaVersion;
  }
}
