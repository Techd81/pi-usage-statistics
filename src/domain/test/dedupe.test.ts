import { describe, expect, it } from "vitest";
import { indexByRecordId, makeRecordId, mergeRecords, upsertRecord } from "../dedupe";
import { queryUsage } from "../aggregate";
import type { UsageFilters } from "../types";
import { makeRecord } from "./helpers";

const allFilters: UsageFilters = { fromMs: 0, toMs: Number.POSITIVE_INFINITY, bucketMs: 30_000, includeSummaryUsage: false };

describe("makeRecordId", () => {
  it("builds the stable `${sessionId}:${entryId}` identity", () => {
    expect(makeRecordId("sess-1", "entry-2")).toBe("sess-1:entry-2");
    expect(makeRecordId("sess-1", "entry-2")).toBe(makeRecordId("sess-1", "entry-2"));
  });
});

describe("upsertRecord", () => {
  it("appends a new record and replaces on recordId collision", () => {
    const first = makeRecord({ sourceEntryId: "e1", inputTokens: 10 });
    const second = makeRecord({ sourceEntryId: "e2", inputTokens: 20 });
    const updated = makeRecord({ sourceEntryId: "e1", inputTokens: 99 });

    let records = upsertRecord([], first);
    records = upsertRecord(records, second);
    records = upsertRecord(records, updated);

    expect(records).toHaveLength(2);
    expect(records.find((r) => r.recordId === "session-1:e1")!.inputTokens).toBe(99);
    expect(records.find((r) => r.recordId === "session-1:e2")!.inputTokens).toBe(20);
  });

  it("does not mutate the input array", () => {
    const first = makeRecord({ sourceEntryId: "e1" });
    const input = [first];
    upsertRecord(input, makeRecord({ sourceEntryId: "e1", inputTokens: 5 }));
    expect(input).toHaveLength(1);
    expect(input[0]!.inputTokens).toBe(0);
  });
});

describe("mergeRecords", () => {
  it("unions by recordId with later records winning", () => {
    const base = [makeRecord({ sourceEntryId: "e1", inputTokens: 1 }), makeRecord({ sourceEntryId: "e2", inputTokens: 2 })];
    const incoming = [
      makeRecord({ sourceEntryId: "e1", inputTokens: 10 }), // replaces
      makeRecord({ sourceEntryId: "e3", inputTokens: 3 }), // adds
    ];
    const merged = mergeRecords(base, incoming);
    expect(merged).toHaveLength(3);
    expect(merged.find((r) => r.recordId === "session-1:e1")!.inputTokens).toBe(10);
  });
});

describe("indexByRecordId", () => {
  it("indexes records with last occurrence winning", () => {
    const index = indexByRecordId([
      makeRecord({ sourceEntryId: "e1", inputTokens: 1 }),
      makeRecord({ sourceEntryId: "e2", inputTokens: 2 }),
      makeRecord({ sourceEntryId: "e1", inputTokens: 3 }),
    ]);
    expect(index.size).toBe(2);
    expect(index.get("session-1:e1")!.inputTokens).toBe(3);
  });
});

describe("upsert + aggregation (DC7)", () => {
  it("re-inserting the same recordId never increments totals twice", () => {
    const record = makeRecord({ sourceEntryId: "e1", inputTokens: 100, timestampMs: 1_700_000_000_000 });
    let records = upsertRecord([], record);
    records = upsertRecord(records, record);
    records = upsertRecord(records, record);

    const first = queryUsage(records, allFilters, 1);
    expect(first.totals.inputTokens).toBe(100);
    expect(first.totals.requestCount).toBe(1);

    // A live event and a later scan produce the same recordId: replace, never add.
    const scannedCopy = makeRecord({ sourceEntryId: "e1", inputTokens: 100, timestampMs: 1_700_000_000_000 });
    records = upsertRecord(records, scannedCopy);
    const second = queryUsage(records, allFilters, 1);
    expect(second.totals.inputTokens).toBe(100);
    expect(second.totals.requestCount).toBe(1);
  });

  it("updated records replace stale totals entirely", () => {
    const stale = makeRecord({ sourceEntryId: "e1", inputTokens: 5000, timestampMs: 1_700_000_000_000 });
    const fresh = makeRecord({ sourceEntryId: "e1", inputTokens: 25, timestampMs: 1_700_000_000_000 });
    const records = upsertRecord(upsertRecord([], stale), fresh);
    const result = queryUsage(records, allFilters, 1);
    expect(result.totals.inputTokens).toBe(25);
  });
});
