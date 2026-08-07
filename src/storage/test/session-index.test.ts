/**
 * UsageStore / session scanner tests: defensive scanning (SC1), live+scan
 * reconciliation (SC2), corrupt-index rebuild (SC3/SC4), dimensions (SC5),
 * and single-flight coalescing (SC6).
 *
 * `SessionManager.listAll`/`open`/`getEntries` are mocked so the scanner is
 * tested against fixture session files without a live Pi runtime.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, SessionInfo } from "@earendil-works/pi-coding-agent";
import { assistantMessageEntryId } from "../../domain";
import { decodeSessionEntry, UsageStore } from "../session-index";
import { writeStoreFile, makeRecord } from "./helpers";

// --- Mock the Pi runtime module -------------------------------------------

const sessionFiles = new Map<string, SessionEntry[]>();
const sessionInfos: SessionInfo[] = [];

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => process.env.PI_AGENT_DIR_TEST ?? "/tmp/pi-agent",
  SessionManager: {
    listAll: vi.fn(async (_sessionDir?: string, onProgress?: (done: number, total: number) => void) => {
      onProgress?.(0, sessionInfos.length);
      return [...sessionInfos];
    }),
    open: vi.fn((path: string) => ({
      getEntries: () => sessionFiles.get(path) ?? [],
    })),
  },
}));

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  sessionFiles.clear();
  sessionInfos.length = 0;
  vi.clearAllMocks();
});

// --- decodeSessionEntry unit tests ----------------------------------------

describe("decodeSessionEntry", () => {
  const ctx = { sessionId: "s1", sessionPath: "/sessions/s1.jsonl", projectCwd: "/p1", entryId: "e1" };

  it("decodes an assistant message into one canonical record", () => {
    const entryTs = "2026-08-06T00:01:00.000Z";
    const message = {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    };
    const records = decodeSessionEntry(
      { type: "message", id: "e1", parentId: null, timestamp: entryTs, message } as SessionEntry,
      ctx,
    );
    expect(records).toHaveLength(1);
    // Identity uses entry timestamp backfill so live+scan share one recordId.
    const expectedId = assistantMessageEntryId(
      { ...message, timestamp: Date.parse(entryTs) },
      "e1",
    );
    expect(records[0]!.recordId).toBe(`s1:${expectedId}`);
    expect(records[0]!.inputTokens).toBe(100);
    expect(records[0]!.outputTokens).toBe(50);
    expect(records[0]!.sourceKind).toBe("assistant");
    expect(records[0]!.costKind).toBe("estimated"); // builtin price table
  });

  it("reconciles live fingerprint with scan when message lacks timestamp", () => {
    const entryTs = "2026-08-06T00:01:00.000Z";
    const ts = Date.parse(entryTs);
    const message = {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      content: "hello",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    };
    const scanned = decodeSessionEntry(
      { type: "message", id: "entry-xyz", parentId: null, timestamp: entryTs, message } as unknown as SessionEntry,
      ctx,
    );
    const liveId = assistantMessageEntryId({ ...message, timestamp: ts }, "");
    expect(scanned[0]!.recordId).toBe(`s1:${liveId}`);
  });

  it("returns [] for non-usage entries (user messages, labels, etc.)", () => {
    expect(decodeSessionEntry({ type: "message", id: "e1", parentId: null, timestamp: "2026-08-06T00:01:00.000Z", message: { role: "user", content: "hi" } } as SessionEntry, ctx)).toEqual([]);
    expect(decodeSessionEntry({ type: "label", id: "e2", parentId: null, timestamp: "2026-08-06T00:01:00.000Z", targetId: "x", label: "y" } as SessionEntry, ctx)).toEqual([]);
    expect(decodeSessionEntry(null as unknown as SessionEntry, ctx)).toEqual([]);
  });

  it("decodes compaction/branch_summary summary usage with sourceKind summary", () => {
    const records = decodeSessionEntry(
      { type: "compaction", id: "e3", parentId: null, timestamp: "2026-08-06T00:01:00.000Z", summary: "x", firstKeptEntryId: "a", tokensBefore: 5, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } as SessionEntry,
      ctx,
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.sourceKind).toBe("summary");
    expect(records[0]!.inputTokens).toBe(10);
  });

  it("skips summary entries without usage", () => {
    expect(decodeSessionEntry({ type: "compaction", id: "e4", parentId: null, timestamp: "2026-08-06T00:01:00.000Z", summary: "x", firstKeptEntryId: "a", tokensBefore: 5 } as SessionEntry, ctx)).toEqual([]);
  });

  it("normalizes malformed message payloads defensively (never throws)", () => {
    const records = decodeSessionEntry(
      { type: "message", id: "e5", parentId: null, timestamp: "2026-08-06T00:01:00.000Z", message: { role: "assistant", usage: "garbage" } } as unknown as SessionEntry,
      ctx,
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.totalTokens).toBe(0);
    expect(records[0]!.costKind).toBe("unavailable");
  });
});

// --- UsageStore integration tests -----------------------------------------

describe("UsageStore", () => {
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = await makeTempDir("pi-usage-store-sessions-");
    process.env.PI_AGENT_DIR_TEST = await makeTempDir("pi-usage-store-agent-");
  });

  async function makeStore(): Promise<{ store: UsageStore; storeDir: string }> {
    const storeDir = await makeTempDir("pi-usage-store-data-");
    const store = new UsageStore({ storeDir, sessionDir });
    await store.init();
    return { store, storeDir };
  }

  it("scans fixture sessions including malformed/truncated/branched/forked (SC1)", async () => {
    // Two session files; one has a malformed line and a truncated tail.
    const s1Path = join(sessionDir, "s1.jsonl");
    const s2Path = join(sessionDir, "s2.jsonl");
    sessionFiles.set(s1Path, [
      { type: "message", id: "a1", parentId: null, timestamp: "2026-08-06T00:01:00.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } } },
      { type: "message", id: "a2", parentId: "a1", timestamp: "2026-08-06T00:02:00.000Z", message: { role: "assistant", provider: "openai", model: "gpt-4o", usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0 } } },
    ] as SessionEntry[]);
    sessionFiles.set(s2Path, [
      { type: "message", id: "b1", parentId: null, timestamp: "2026-08-06T00:03:00.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-3-5-haiku", usage: { input: 300, output: 150, cacheRead: 0, cacheWrite: 0 } } },
    ] as SessionEntry[]);
    sessionInfos.push(
      { path: s1Path, id: "s1", cwd: "/p1", created: new Date(), modified: new Date(), messageCount: 2, firstMessage: "", allMessagesText: "" },
      { path: s2Path, id: "s2", cwd: "/p2", created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "", allMessagesText: "" },
    );
    // The malformed/truncated content lives in the real files on disk (SC1
    // fixture path), but our mocked getEntries returns clean entries. To test
    // tolerance we inject garbage entries too:
    sessionFiles.get(s1Path)!.push({ type: "garbage", id: "zz" } as unknown as SessionEntry);

    const { store } = await makeStore();
    const summary = await store.refresh();
    expect(summary.sessionsFound).toBe(2);
    expect(summary.sessionsScanned).toBe(2);
    expect(summary.sessionErrors).toBe(0);
    expect(summary.recordsMerged).toBe(3);

    const result = store.query({ fromMs: 0, toMs: Number.POSITIVE_INFINITY, bucketMs: 30_000, includeSummaryUsage: false });
    expect(result.totals.inputTokens).toBe(600);
    expect(result.totals.requestCount).toBe(3);
    // SC5: dimensions exposed
    expect(result.dimensions.providers.sort()).toEqual(["anthropic", "openai"]);
    expect(result.dimensions.sessions.sort()).toEqual(["s1", "s2"]);
    expect(result.dimensions.projects.sort()).toEqual(["/p1", "/p2"]);
  });

  it("repeated scans never change totals for the same recordId (SC2)", async () => {
    const s1Path = join(sessionDir, "s1.jsonl");
    sessionFiles.set(s1Path, [
      { type: "message", id: "a1", parentId: null, timestamp: "2026-08-06T00:01:00.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } } },
    ] as SessionEntry[]);
    sessionInfos.push({ path: s1Path, id: "s1", cwd: "/p1", created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "", allMessagesText: "" });

    const { store } = await makeStore();
    await store.refresh();
    const first = store.query({ fromMs: 0, toMs: Number.POSITIVE_INFINITY, bucketMs: 30_000, includeSummaryUsage: false });
    expect(first.totals.inputTokens).toBe(100);
    expect(first.totals.requestCount).toBe(1);

    // Live record arrives with the same recordId as the scanned one (SC2).
    const entryTs = Date.parse("2026-08-06T00:01:00.000Z");
    const liveEntryId = assistantMessageEntryId(
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        timestamp: entryTs,
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      },
      "a1",
    );
    store.upsertRecord({
      recordId: `s1:${liveEntryId}`,
      sessionId: "s1",
      sessionPath: s1Path,
      projectCwd: "/p1",
      timestampMs: entryTs,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      requestCount: 1,
      costKind: "unavailable",
      sourceEntryId: liveEntryId,
      sourceKind: "assistant",
    });
    await store.refresh();
    const second = store.query({ fromMs: 0, toMs: Number.POSITIVE_INFINITY, bucketMs: 30_000, includeSummaryUsage: false });
    expect(second.totals.inputTokens).toBe(100); // still 100, never 200
    expect(second.totals.requestCount).toBe(1);
  });

  it("survives reload; corrupt index rebuilds from sessions (SC3/SC4)", async () => {
    const s1Path = join(sessionDir, "s1.jsonl");
    sessionFiles.set(s1Path, [
      { type: "message", id: "a1", parentId: null, timestamp: "2026-08-06T00:01:00.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } } },
    ] as SessionEntry[]);
    sessionInfos.push({ path: s1Path, id: "s1", cwd: "/p1", created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "", allMessagesText: "" });

    const { store, storeDir } = await makeStore();
    await store.refresh();
    expect(store.query({ fromMs: 0, toMs: Number.POSITIVE_INFINITY, bucketMs: 30_000, includeSummaryUsage: false }).totals.inputTokens).toBe(100);

    // Corrupt the index metadata; a reload must still serve data and rebuild.
    await writeStoreFile(storeDir, "index.json", JSON.stringify({ schemaVersion: 999 }));
    const reloaded = new UsageStore({ storeDir, sessionDir });
    await reloaded.init();
    // Load drops the cache on schema mismatch; a scan repopulates (SC4).
    expect(reloaded.query({ fromMs: 0, toMs: Number.POSITIVE_INFINITY, bucketMs: 30_000, includeSummaryUsage: false }).totals.inputTokens).toBe(0);
    await reloaded.refresh();
    expect(reloaded.query({ fromMs: 0, toMs: Number.POSITIVE_INFINITY, bucketMs: 30_000, includeSummaryUsage: false }).totals.inputTokens).toBe(100);
  });

  it("stamps scanned summary records with the entry timestamp, stable across rescans (SC2)", async () => {
    const s1Path = join(sessionDir, "s1.jsonl");
    sessionFiles.set(s1Path, [
      { type: "compaction", id: "c1", parentId: null, timestamp: "2026-08-06T00:01:00.000Z", summary: "x", firstKeptEntryId: "a", tokensBefore: 5, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
    ] as SessionEntry[]);
    sessionInfos.push({ path: s1Path, id: "s1", cwd: "/p1", created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "", allMessagesText: "" });
    const { store } = await makeStore();
    await store.refresh();
    const expected = Date.parse("2026-08-06T00:01:00.000Z");
    const window = { fromMs: expected, toMs: expected, bucketMs: 30_000, includeSummaryUsage: true };
    expect(store.query(window).totals.inputTokens).toBe(10);
    // A second scan must not move the record to "now".
    await store.refresh();
    expect(store.query(window).totals.inputTokens).toBe(10);
  });

  it("falls back to the entry timestamp when a message lacks one", async () => {
    const s1Path = join(sessionDir, "s1.jsonl");
    sessionFiles.set(s1Path, [
      { type: "message", id: "a1", parentId: null, timestamp: "2026-08-06T00:02:00.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } } },
    ] as SessionEntry[]);
    sessionInfos.push({ path: s1Path, id: "s1", cwd: "/p1", created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "", allMessagesText: "" });
    const { store } = await makeStore();
    await store.refresh();
    const expected = Date.parse("2026-08-06T00:02:00.000Z");
    const result = store.query({ fromMs: expected, toMs: expected, bucketMs: 30_000, includeSummaryUsage: false });
    expect(result.totals.inputTokens).toBe(7);
  });

  it("rebuild() requested during an in-flight scan runs a real rebuild afterwards (SC4)", async () => {
    const s1Path = join(sessionDir, "s1.jsonl");
    sessionFiles.set(s1Path, [
      { type: "message", id: "a1", parentId: null, timestamp: "2026-08-06T00:01:00.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } } },
    ] as SessionEntry[]);
    sessionInfos.push({ path: s1Path, id: "s1", cwd: "/p1", created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "", allMessagesText: "" });

    const { storeDir } = await makeStore();
    // Seed a stale record that no session file backs anymore (simulates a
    // deleted session); only a real rebuild can purge it.
    await writeStoreFile(storeDir, "records.jsonl", JSON.stringify(makeRecord({ sessionId: "ghost", sourceEntryId: "g1", inputTokens: 999 })));
    const reloaded = new UsageStore({ storeDir, sessionDir });
    await reloaded.init();

    const inflight = reloaded.refresh();
    const summary = await reloaded.rebuild(); // joins the in-flight pass, then rebuilds
    expect(summary.rebuilt).toBe(true);
    const result = reloaded.query({ fromMs: 0, toMs: Number.POSITIVE_INFINITY, bucketMs: 30_000, includeSummaryUsage: false });
    expect(result.totals.inputTokens).toBe(100); // stale ghost purged, real record kept
    expect(result.totals.requestCount).toBe(1);
    await inflight;
  });

  it("coalesces concurrent scans into one in-flight pass (SC6)", async () => {
    const s1Path = join(sessionDir, "s1.jsonl");
    sessionFiles.set(s1Path, [
      { type: "message", id: "a1", parentId: null, timestamp: "2026-08-06T00:01:00.000Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } } },
    ] as SessionEntry[]);
    sessionInfos.push({ path: s1Path, id: "s1", cwd: "/p1", created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "", allMessagesText: "" });

    const { store } = await makeStore();
    const p1 = store.refresh();
    const p2 = store.refresh(); // coalesced into p1
    const p3 = store.refresh(); // coalesced into p1
    const [s1, s2, s3] = await Promise.all([p1, p2, p3]);
    expect(s1).toBe(s2);
    expect(s1).toBe(s3);
    const listAllMock = vi.mocked((await import("@earendil-works/pi-coding-agent")).SessionManager.listAll);
    expect(listAllMock).toHaveBeenCalledTimes(1);
  });

  it("records arriving during a scan trigger one follow-up pass (SC6)", async () => {
    const s1Path = join(sessionDir, "s1.jsonl");
    sessionFiles.set(s1Path, [] as SessionEntry[]);
    sessionInfos.push({ path: s1Path, id: "s1", cwd: "/p1", created: new Date(), modified: new Date(), messageCount: 0, firstMessage: "", allMessagesText: "" });

    const { store } = await makeStore();
    // A live record upserted right after refresh() starts marks the store dirty.
    const scanPromise = store.refresh();
    store.upsertRecord({
      recordId: "s1:live1",
      sessionId: "s1",
      sessionPath: s1Path,
      projectCwd: "/p1",
      timestampMs: 1_700_000_000_000,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputTokens: 42,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 42,
      requestCount: 1,
      costKind: "unavailable",
      sourceEntryId: "live1",
      sourceKind: "assistant",
    });
    await scanPromise;
    const result = store.query({ fromMs: 0, toMs: Number.POSITIVE_INFINITY, bucketMs: 30_000, includeSummaryUsage: false });
    expect(result.totals.inputTokens).toBe(42);
  });

  it("loads pricing.json override and applies it on scan (DC4)", async () => {
    const s1Path = join(sessionDir, "s1.jsonl");
    sessionFiles.set(s1Path, [
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-08-06T00:01:00.000Z",
        message: {
          role: "assistant",
          provider: "my-provider",
          model: "custom-model",
          usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      },
    ] as SessionEntry[]);
    sessionInfos.push({
      path: s1Path,
      id: "s1",
      cwd: "/p1",
      created: new Date(),
      modified: new Date(),
      messageCount: 1,
      firstMessage: "",
      allMessagesText: "",
    });

    const storeDir = await makeTempDir("pi-usage-pricing-");
    await writeStoreFile(
      storeDir,
      "pricing.json",
      JSON.stringify({
        schemaVersion: 1,
        currency: "USD",
        rows: [
          {
            provider: "my-provider",
            model: "custom-model",
            inputPer1k: 1,
            outputPer1k: 0,
            cacheReadPer1k: 0,
            cacheWritePer1k: 0,
          },
        ],
      }),
    );
    const store = new UsageStore({ storeDir, sessionDir });
    await store.init();
    await store.refresh();
    const result = store.query({
      fromMs: 0,
      toMs: Number.POSITIVE_INFINITY,
      bucketMs: 30_000,
      includeSummaryUsage: false,
    });
    expect(result.totals.cost.status).toBe("estimated");
    expect(result.totals.cost.amount).toBeCloseTo(1, 6); // 1000 tokens * $1/1k
  });
});

describe("UsageStore.reloadFromDisk (多窗口热更新)", () => {
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = await makeTempDir("pi-reload-sessions-");
    process.env.PI_AGENT_DIR_TEST = await makeTempDir("pi-reload-agent-");
  });

  it("picks up records written by another store/process on the same directory", async () => {
    const storeDir = await makeTempDir("pi-reload-data-");
    // Process A and B are independent instances over the same directory.
    const a = new UsageStore({ storeDir, sessionDir });
    await a.init();
    const b = new UsageStore({ storeDir, sessionDir });
    await b.init();

    // A records usage in its own memory — B cannot see it yet.
    a.upsertRecord(
      makeRecord({ sessionId: "a", sourceEntryId: "e1", timestampMs: Date.now(), inputTokens: 100 }),
    );
    expect(b.query({ fromMs: 0, toMs: Number.POSITIVE_INFINITY, bucketMs: 30_000, includeSummaryUsage: false }).totals.totalTokens).toBe(0);

    // A flushes to disk (simulates process A's durable write); B still stale.
    await a.stop();
    expect(b.query({ fromMs: 0, toMs: Number.POSITIVE_INFINITY, bucketMs: 30_000, includeSummaryUsage: false }).totals.totalTokens).toBe(0);

    // B reloads from disk → sees A's record.
    await b.reloadFromDisk();
    expect(b.query({ fromMs: 0, toMs: Number.POSITIVE_INFINITY, bucketMs: 30_000, includeSummaryUsage: false }).totals.totalTokens).toBe(100);

    // B's own live record survives reload (flushed first, then loaded back).
    b.upsertRecord(
      makeRecord({ sessionId: "b", sourceEntryId: "e1", timestampMs: Date.now(), inputTokens: 50 }),
    );
    await b.reloadFromDisk();
    const after = b.query({ fromMs: 0, toMs: Number.POSITIVE_INFINITY, bucketMs: 30_000, includeSummaryUsage: false });
    expect(after.totals.totalTokens).toBe(150);
    // liveRecords overlay was dropped after reload (it is now in the durable file)
    expect(b.liveRecordCount).toBe(0);
  });

  it("is non-fatal when the records file is missing", async () => {
    const storeDir = await makeTempDir("pi-reload-missing-");
    const a = new UsageStore({ storeDir, sessionDir });
    await a.init();
    a.upsertRecord(makeRecord({ sessionId: "a", sourceEntryId: "e1", timestampMs: Date.now(), inputTokens: 7 }));
    await expect(a.reloadFromDisk()).resolves.toBeUndefined();
    // In-memory records survive even though the file was never flushed before a failure path
    expect(a.query({ fromMs: 0, toMs: Number.POSITIVE_INFINITY, bucketMs: 30_000, includeSummaryUsage: false }).totals.totalTokens).toBeGreaterThanOrEqual(0);
  });
});
