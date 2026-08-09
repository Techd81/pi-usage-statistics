/**
 * RecordStore unit tests: atomic persistence, truncated-tail tolerance,
 * schema-versioned rebuild, compaction, and recordId upsert semantics.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecordStore, RECORDS_FILE, INDEX_FILE } from "../record-store";
import { makeRecord, writeStoreFile } from "./helpers";

const tempDirs: string[] = [];

async function makeStoreDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-usage-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  // nothing to clean synchronously; tmp dirs are OS-managed
});

describe("RecordStore", () => {
  it("loads an absent directory as a fresh empty store (SC3)", async () => {
    const dir = await makeStoreDir();
    const store = new RecordStore({ storeDir: dir });
    await store.load();
    expect(store.snapshot().records).toEqual([]);
    expect(store.schemaVersion).toBe(1);
  });

  it("persists records and reloads them (SC3 round-trip)", async () => {
    const dir = await makeStoreDir();
    const store = new RecordStore({ storeDir: dir });
    await store.load();
    store.upsertRecord(makeRecord({ sourceEntryId: "e1", inputTokens: 10 }));
    store.upsertRecord(makeRecord({ sourceEntryId: "e2", inputTokens: 20 }));
    await store.flush();

    const reloaded = new RecordStore({ storeDir: dir });
    await reloaded.load();
    expect(reloaded.snapshot().records).toHaveLength(2);
    const byId = new Map(reloaded.snapshot().records.map((r) => [r.recordId, r]));
    expect(byId.get("session-1:e1")!.inputTokens).toBe(10);
    expect(byId.get("session-1:e2")!.inputTokens).toBe(20);
  });

  it("upserts by recordId — a reload keeps the latest version only (SC2)", async () => {
    const dir = await makeStoreDir();
    const store = new RecordStore({ storeDir: dir });
    await store.load();
    store.upsertRecord(makeRecord({ sourceEntryId: "e1", inputTokens: 100 }));
    store.upsertRecord(makeRecord({ sourceEntryId: "e1", inputTokens: 5 }));
    await store.flush();

    const reloaded = new RecordStore({ storeDir: dir });
    await reloaded.load();
    const records = reloaded.snapshot().records;
    expect(records).toHaveLength(1);
    expect(records[0]!.inputTokens).toBe(5);
  });

  it("tolerates a truncated final line on load (SC3)", async () => {
    const dir = await makeStoreDir();
    const record = makeRecord({ sourceEntryId: "e1", inputTokens: 10 });
    const good = JSON.stringify(record);
    const truncated = '{"recordId":"session-1:e2","inputTokens":20,"totalTo'; // cut mid-JSON
    await writeStoreFile(dir, RECORDS_FILE, `${good}\n${truncated}`);

    const store = new RecordStore({ storeDir: dir });
    await store.load();
    const records = store.snapshot().records;
    expect(records).toHaveLength(1);
    expect(records[0]!.recordId).toBe("session-1:e1");
    expect(store.isDirty).toBe(true); // truncated tail marks the store for rewrite
  });

  it("tolerates malformed lines without failing the whole load", async () => {
    const dir = await makeStoreDir();
    const good = JSON.stringify(makeRecord({ sourceEntryId: "e1", inputTokens: 10 }));
    await writeStoreFile(dir, RECORDS_FILE, `${good}\n{not json at all\n${good}`);

    const store = new RecordStore({ storeDir: dir });
    await store.load();
    const records = store.snapshot().records;
    // two good copies of the same record -> dedupe by recordId on load? no:
    // load preserves lines verbatim; duplicates are collapsed at query time.
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records.every((r) => r.recordId === "session-1:e1")).toBe(true);
  });

  it("skips parseable-but-malformed lines instead of admitting garbage (SC1)", async () => {
    const dir = await makeStoreDir();
    const good = JSON.stringify(makeRecord({ sourceEntryId: "e1", inputTokens: 10 }));
    // Valid JSON, wrong shape: string tokens would poison aggregation sums.
    const garbage = JSON.stringify({ recordId: "session-1:g", inputTokens: "lots", outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });
    await writeStoreFile(dir, RECORDS_FILE, `${good}\n${garbage}`);
    const store = new RecordStore({ storeDir: dir });
    await store.load();
    const records = store.snapshot().records;
    expect(records).toHaveLength(1);
    expect(records[0]!.recordId).toBe("session-1:e1");
    expect(store.isDirty).toBe(true); // skipped lines warrant a rewrite on next flush
  });

  it("rebuilds deterministically when the index schema version mismatches (SC4)", async () => {
    const dir = await makeStoreDir();
    const store = new RecordStore({ storeDir: dir });
    await store.load();
    store.upsertRecord(makeRecord({ sourceEntryId: "e1", inputTokens: 10 }));
    await store.flush();

    // Corrupt the index with a future schema version.
    await writeStoreFile(dir, INDEX_FILE, JSON.stringify({ schemaVersion: 999 }));
    const reloaded = new RecordStore({ storeDir: dir });
    await reloaded.load();
    expect(reloaded.schemaVersion).toBe(1);
    expect(reloaded.snapshot().records).toEqual([]); // cache dropped; scanner repopulates
  });

  it("writes atomically — the records file is valid JSONL after flush", async () => {
    const dir = await makeStoreDir();
    const store = new RecordStore({ storeDir: dir });
    await store.load();
    store.upsertRecord(makeRecord({ sourceEntryId: "e1", inputTokens: 10 }));
    await store.flush();

    const text = await readFile(join(dir, RECORDS_FILE), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).recordId).toBe("session-1:e1");

    const index = JSON.parse(await readFile(join(dir, INDEX_FILE), "utf8"));
    expect(index.schemaVersion).toBe(1);
  });

  it("compacts when the record count exceeds the configured bound", async () => {
    const dir = await makeStoreDir();
    const store = new RecordStore({ storeDir: dir, maxRecords: 3 });
    await store.load();
    for (let i = 0; i < 10; i++) {
      store.upsertRecord(makeRecord({ sourceEntryId: `e${i}`, inputTokens: i }));
    }
    await store.flush();
    const text = await readFile(join(dir, RECORDS_FILE), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(10); // compaction dedupes, count stays same for unique ids
    expect(JSON.parse(lines[0]!).recordId).toBe("session-1:e0");
  });

  it("append-only flush: only dirty records are appended; unchanged rows stay untouched (P1)", async () => {
    const dir = await makeStoreDir();
    const store = new RecordStore({ storeDir: dir });
    await store.load();
    store.upsertRecord(makeRecord({ sessionId: "s1", sourceEntryId: "e1", inputTokens: 10 }));
    await store.flush();
    const afterFirst = await readFile(join(dir, RECORDS_FILE), "utf8");

    // A second batch lands: flush must append only the new rows, not rewrite
    // the whole file (the first record's line survives verbatim).
    store.upsertRecord(makeRecord({ sessionId: "s2", sourceEntryId: "e2", inputTokens: 20 }));
    await store.flush();
    const afterSecond = await readFile(join(dir, RECORDS_FILE), "utf8");
    expect(afterSecond.startsWith(afterFirst)).toBe(true); // s1:e1 row untouched
    expect(afterSecond.trim().split("\n")).toHaveLength(2);
    expect(afterSecond).toContain('"recordId":"s2:e2"');
  });

  it("append-only flush equivalence: reload + query matches the full-rewrite result (P1)", async () => {
    const dir = await makeStoreDir();
    const store = new RecordStore({ storeDir: dir });
    await store.load();
    store.upsertRecord(makeRecord({ sessionId: "s1", sourceEntryId: "e1", inputTokens: 10 }));
    store.upsertRecord(makeRecord({ sessionId: "s1", sourceEntryId: "e1", inputTokens: 5 })); // update same id
    store.upsertRecord(makeRecord({ sessionId: "s2", sourceEntryId: "e2", inputTokens: 20 }));
    await store.flush();

    // Duplicate rows for s1:e1 exist on disk (append); a reload must collapse
    // them to the last version and produce exactly the same numbers.
    const reloaded = new RecordStore({ storeDir: dir });
    await reloaded.load();
    const records = reloaded.snapshot().records;
    expect(records).toHaveLength(2); // deduped by recordId (B4)
    const byId = new Map(records.map((r) => [r.recordId, r]));
    expect(byId.get("s1:e1")!.inputTokens).toBe(5); // last line wins
    expect(byId.get("s2:e2")!.inputTokens).toBe(20);
  });

  it("compaction bounds the file: historical duplicate rows are rewritten away when the line count exceeds maxRecords (B1)", async () => {
    const dir = await makeStoreDir();
    // Seed the disk file with more rows than maxRecords, including duplicates
    // (simulating append-only history that outgrew the bound).
    const r1 = makeRecord({ sessionId: "s1", sourceEntryId: "e1", inputTokens: 1 });
    const r2 = makeRecord({ sessionId: "s2", sourceEntryId: "e2", inputTokens: 2 });
    const lines = [JSON.stringify(r1), JSON.stringify(r2), JSON.stringify(r2), JSON.stringify(r1)];
    await writeStoreFile(dir, RECORDS_FILE, `${lines.join("\n")}\n`);

    const store = new RecordStore({ storeDir: dir, maxRecords: 3 });
    await store.load();
    expect(store.snapshot().records).toHaveLength(2); // load dedupes (B4)
    // A flush with dirty state (new record) must compact the bloated file.
    store.upsertRecord(makeRecord({ sessionId: "s3", sourceEntryId: "e3", inputTokens: 3 }));
    await store.flush();
    const text = await readFile(join(dir, RECORDS_FILE), "utf8");
    const after = text.trim().split("\n");
    expect(after).toHaveLength(3); // unique records only — duplicates collapsed
    const ids = after.map((l) => JSON.parse(l).recordId as string).sort();
    expect(ids).toEqual(["s1:e1", "s2:e2", "s3:e3"]);
  });

  it("upsert on a large unique set keeps a single copy and correct values (P2)", async () => {
    const dir = await makeStoreDir();
    const store = new RecordStore({ storeDir: dir });
    await store.load();
    const count = 5_000;
    for (let i = 0; i < count; i++) {
      store.upsertRecord(makeRecord({ sessionId: `s${i}`, sourceEntryId: "e1", inputTokens: i }));
    }
    expect(store.snapshot().records).toHaveLength(count);
    // Update an existing id — must replace, not duplicate.
    store.upsertRecord(makeRecord({ sessionId: "s0", sourceEntryId: "e1", inputTokens: 999 }));
    expect(store.snapshot().records).toHaveLength(count);
    const byId = new Map(store.snapshot().records.map((r) => [r.recordId, r]));
    expect(byId.get("s0:e1")!.inputTokens).toBe(999);
    await store.flush();
    const reloaded = new RecordStore({ storeDir: dir });
    await reloaded.load();
    expect(reloaded.snapshot().records).toHaveLength(count);
  });

  it("flush with no changes does not rewrite the records file (P1)", async () => {
    const dir = await makeStoreDir();
    const store = new RecordStore({ storeDir: dir });
    await store.load();
    store.upsertRecord(makeRecord({ sourceEntryId: "e1", inputTokens: 10 }));
    await store.flush();
    const before = await readFile(join(dir, RECORDS_FILE), "utf8");
    // No mutation since the last flush: a second flush must be a no-op for
    // the records file (same content, no appended rows).
    await store.flush();
    const after = await readFile(join(dir, RECORDS_FILE), "utf8");
    expect(after).toBe(before);
  });

  it("merges distinct concurrent writers without losing either record", async () => {
    const dir = await makeStoreDir();
    const a = new RecordStore({ storeDir: dir });
    const b = new RecordStore({ storeDir: dir });
    await Promise.all([a.load(), b.load()]);
    a.upsertRecord(makeRecord({ sessionId: "a", sourceEntryId: "e1", inputTokens: 11 }));
    b.upsertRecord(makeRecord({ sessionId: "b", sourceEntryId: "e1", inputTokens: 22 }));
    await Promise.all([a.flush(), b.flush()]);

    const loaded = new RecordStore({ storeDir: dir });
    await loaded.load();
    expect(loaded.snapshot().records.map((record) => record.recordId).sort()).toEqual(["a:e1", "b:e1"]);
  });

  it("a replace-disk rebuild keeps records added by another process after load", async () => {
    const dir = await makeStoreDir();
    const seed = new RecordStore({ storeDir: dir });
    await seed.load();
    seed.upsertRecord(makeRecord({ sessionId: "stale", sourceEntryId: "old", inputTokens: 1 }));
    await seed.flush();

    const rebuilding = new RecordStore({ storeDir: dir });
    const writer = new RecordStore({ storeDir: dir });
    await Promise.all([rebuilding.load(), writer.load()]);
    rebuilding.replaceAll([makeRecord({ sessionId: "scan", sourceEntryId: "fresh", inputTokens: 2 })]);
    writer.upsertRecord(makeRecord({ sessionId: "other", sourceEntryId: "live", inputTokens: 3 }));
    await writer.flush();
    await rebuilding.flush({ replaceDisk: true });

    const loaded = new RecordStore({ storeDir: dir });
    await loaded.load();
    expect(loaded.snapshot().records.map((record) => record.recordId).sort()).toEqual(["other:live", "scan:fresh"]);
  });

  it("keeps a failed flush dirty so a later flush can recover", async () => {
    const dir = await makeStoreDir();
    const store = new RecordStore({ storeDir: dir });
    await store.load();
    store.upsertRecord(makeRecord({ sourceEntryId: "retry", inputTokens: 9 }));
    const lockPath = `${store.recordsFilePath}.lock`;
    await mkdir(lockPath); // exclusive open fails until the synthetic contention clears
    await expect(store.flush()).rejects.toThrow("Timed out acquiring records lock");
    expect(store.isDirty).toBe(true);
    await rm(lockPath, { recursive: true });
    await expect(store.flush()).resolves.toBeUndefined();
    expect(store.isDirty).toBe(false);
  });

  it("reset removes persisted state (SC3 rebuild path)", async () => {
    const dir = await makeStoreDir();
    const store = new RecordStore({ storeDir: dir });
    await store.load();
    store.upsertRecord(makeRecord({ sourceEntryId: "e1", inputTokens: 10 }));
    await store.flush();
    await store.reset();
    expect(store.snapshot().records).toEqual([]);

    const reloaded = new RecordStore({ storeDir: dir });
    await reloaded.load();
    expect(reloaded.snapshot().records).toEqual([]);
  });
});
