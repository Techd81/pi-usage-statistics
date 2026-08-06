import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUCKET_MS,
  MAX_TREND_BUCKETS,
  cacheHitRate,
  costDisplay,
  queryUsage,
  validateFilters,
} from "../aggregate";
import type { UsageFilters } from "../types";
import { cost, makeRecord } from "./helpers";

const filters = (overrides: Partial<UsageFilters> = {}): UsageFilters => ({
  fromMs: 0,
  toMs: Number.POSITIVE_INFINITY,
  bucketMs: DEFAULT_BUCKET_MS,
  includeSummaryUsage: false,
  ...overrides,
});

const BASE_TS = 1_700_000_000_000; // an exact multiple of 30_000

describe("cacheHitRate (DC2)", () => {
  it("computes cacheRead / (input + cacheRead + cacheWrite) * 100 as a percentage", () => {
    expect(cacheHitRate(100, 50, 50)).toBe(25);
    expect(cacheHitRate(0, 5, 0)).toBe(100);
    expect(cacheHitRate(10, 0, 0)).toBe(0);
  });

  it("returns null for a zero denominator", () => {
    expect(cacheHitRate(0, 0, 0)).toBeNull();
  });
});

describe("validateFilters", () => {
  it("rejects structurally invalid input", () => {
    expect(validateFilters(null)).toBeNull();
    expect(validateFilters(42)).toBeNull();
    expect(validateFilters("x")).toBeNull();
    expect(validateFilters({ providers: "openai" })).toBeNull();
    expect(validateFilters({ models: [1, 2] })).toBeNull();
    expect(validateFilters({ projects: {} })).toBeNull();
    expect(validateFilters({ sessions: [null] })).toBeNull();
    expect(validateFilters({ fromMs: "yesterday" })).toBeNull();
    expect(validateFilters({ toMs: Infinity })).toBeNull();
    expect(validateFilters({ bucketMs: 0 })).toBeNull();
    expect(validateFilters({ bucketMs: -1000 })).toBeNull();
    expect(validateFilters({ includeSummaryUsage: "yes" })).toBeNull();
  });

  it("fills documented defaults for missing fields", () => {
    const result = validateFilters({})!;
    expect(result.providers).toEqual([]);
    expect(result.models).toEqual([]);
    expect(result.projects).toEqual([]);
    expect(result.sessions).toEqual([]);
    expect(result.fromMs).toBe(0);
    expect(result.toMs).toBe(Number.POSITIVE_INFINITY);
    expect(result.bucketMs).toBe(DEFAULT_BUCKET_MS);
    expect(result.includeSummaryUsage).toBe(false);
  });

  it("passes through provided values", () => {
    const result = validateFilters({ providers: ["a"], models: ["m"], fromMs: 1, toMs: 2, bucketMs: 60_000, includeSummaryUsage: true })!;
    expect(result).toEqual({ providers: ["a"], models: ["m"], projects: [], sessions: [], fromMs: 1, toMs: 2, bucketMs: 60_000, includeSummaryUsage: true });
  });
});

describe("filtering happens before aggregation (DC5)", () => {
  const records = [
    makeRecord({ sessionId: "s1", projectCwd: "/p1", provider: "anthropic", model: "claude-sonnet-4-5", timestampMs: BASE_TS, inputTokens: 100, outputTokens: 100, sourceEntryId: "a1" }),
    makeRecord({ sessionId: "s1", projectCwd: "/p1", provider: "openai", model: "gpt-4o", timestampMs: BASE_TS + 30_000, inputTokens: 200, outputTokens: 100, sourceEntryId: "a2" }),
    makeRecord({ sessionId: "s2", projectCwd: "/p2", provider: "anthropic", model: "claude-3-5-haiku", timestampMs: BASE_TS + 60_000, inputTokens: 300, outputTokens: 100, sourceEntryId: "a3" }),
    makeRecord({ sessionId: "s2", projectCwd: "/p2", provider: "openai", model: "gpt-4o-mini", timestampMs: BASE_TS + 90_000, inputTokens: 400, outputTokens: 100, sourceEntryId: "a4" }),
  ];

  it("provider filter changes totals and dimensions consistently", () => {
    const result = queryUsage(records, filters({ providers: ["anthropic"] }), 1);
    expect(result.totals.inputTokens).toBe(400);
    expect(result.totals.requestCount).toBe(2);
    expect(result.dimensions.providers).toEqual(["anthropic"]);
    expect(result.dimensions.models).toEqual(["claude-3-5-haiku", "claude-sonnet-4-5"]);
  });

  it("model filter changes totals", () => {
    const result = queryUsage(records, filters({ models: ["gpt-4o"] }), 1);
    expect(result.totals.inputTokens).toBe(200);
    expect(result.totals.requestCount).toBe(1);
  });

  it("project filter changes totals", () => {
    const result = queryUsage(records, filters({ projects: ["/p2"] }), 1);
    expect(result.totals.inputTokens).toBe(700);
    expect(result.totals.requestCount).toBe(2);
  });

  it("session filter changes totals", () => {
    const result = queryUsage(records, filters({ sessions: ["s1"] }), 1);
    expect(result.totals.inputTokens).toBe(300);
    expect(result.totals.requestCount).toBe(2);
  });

  it("time-range filter changes totals and trend consistently (inclusive bounds)", () => {
    const result = queryUsage(records, filters({ fromMs: BASE_TS + 30_000, toMs: BASE_TS + 60_000 }), 1);
    // toMs is inclusive: the record at BASE_TS + 60_000 (input 300) is included.
    expect(result.totals.inputTokens).toBe(500);
    expect(result.totals.requestCount).toBe(2);
    const trendTokens = result.trend.reduce((sum, point) => sum + point.inputTokens, 0);
    expect(trendTokens).toBe(500);
  });

  it("combined filters interact", () => {
    const result = queryUsage(
      records,
      filters({ providers: ["anthropic", "openai"], projects: ["/p2"], models: ["gpt-4o-mini"] }),
      1,
    );
    expect(result.totals.inputTokens).toBe(400);
    expect(result.totals.requestCount).toBe(1);
  });
});

describe("trend buckets (DC6)", () => {
  it("emits epoch-aligned buckets covering the inclusive range, including empty ones", () => {
    const records = [
      makeRecord({ timestampMs: 0, inputTokens: 1, sourceEntryId: "e0" }),
      makeRecord({ timestampMs: 999, inputTokens: 1, sourceEntryId: "e1" }),
      makeRecord({ timestampMs: 1000, inputTokens: 1, sourceEntryId: "e2" }),
      makeRecord({ timestampMs: 2500, inputTokens: 1, sourceEntryId: "e3" }),
      makeRecord({ timestampMs: 3000, inputTokens: 1, sourceEntryId: "e4" }),
    ];
    const result = queryUsage(records, filters({ fromMs: 0, toMs: 3000, bucketMs: 1000 }), 1);
    expect(result.trend.map((point) => point.startMs)).toEqual([0, 1000, 2000, 3000]);
    expect(result.trend[0]!.inputTokens).toBe(2); // ts 0 and 999
    expect(result.trend[1]!.inputTokens).toBe(1); // ts 1000 (boundary goes to its own bucket)
    expect(result.trend[2]!.inputTokens).toBe(1); // ts 2500
    expect(result.trend[3]!.inputTokens).toBe(1); // ts 3000 (inclusive upper bound)
  });

  it("bucket starts are multiples of bucketMs regardless of fromMs", () => {
    const records = [makeRecord({ timestampMs: 2500, inputTokens: 1, sourceEntryId: "e1" })];
    const result = queryUsage(records, filters({ fromMs: 1500, toMs: 3500, bucketMs: 1000 }), 1);
    expect(result.trend.map((point) => point.startMs)).toEqual([1000, 2000, 3000]);
    expect(result.trend[1]!.inputTokens).toBe(1);
  });

  it("is deterministic — identical inputs produce identical results", () => {
    const records = [
      makeRecord({ timestampMs: BASE_TS, inputTokens: 5, sourceEntryId: "e1" }),
      makeRecord({ timestampMs: BASE_TS + 30_000, inputTokens: 7, sourceEntryId: "e2" }),
    ];
    const a = queryUsage(records, filters({ fromMs: BASE_TS, toMs: BASE_TS + 30_000 }), 123);
    const b = queryUsage(records, filters({ fromMs: BASE_TS, toMs: BASE_TS + 30_000 }), 123);
    expect(a).toEqual(b);
  });

  it("keeps the trend bounded for pathological ranges by scaling the bucket width on the same grid", () => {
    const result = queryUsage(
      [makeRecord({ timestampMs: 1, sourceEntryId: "e1" })],
      filters({ fromMs: 0, toMs: Number.POSITIVE_INFINITY, bucketMs: DEFAULT_BUCKET_MS }),
      1,
    );
    expect(result.trend.length).toBeLessThanOrEqual(MAX_TREND_BUCKETS);
    for (const point of result.trend) {
      expect(point.startMs % DEFAULT_BUCKET_MS).toBe(0);
    }
  });

  it("returns an empty trend for an inverted range", () => {
    const result = queryUsage(
      [makeRecord({ timestampMs: BASE_TS, sourceEntryId: "e1" })],
      filters({ fromMs: BASE_TS + 1000, toMs: BASE_TS }),
      1,
    );
    expect(result.trend).toEqual([]);
    expect(result.totals.inputTokens).toBe(0);
  });
});

describe("cost display (DC3)", () => {
  it("sums recorded cost as recorded", () => {
    const records = [
      makeRecord({ recordedCost: cost(1, 2, 0, 0), sourceEntryId: "e1" }),
      makeRecord({ recordedCost: cost(3, 4, 0, 0), sourceEntryId: "e2" }),
    ];
    const result = queryUsage(records, filters(), 1);
    expect(result.totals.cost).toEqual({ amount: 10, status: "recorded", currency: "USD" });
  });

  it("sums estimated cost as estimated", () => {
    const records = [
      makeRecord({ estimatedCost: cost(1, 2, 0, 0), costKind: "estimated", sourceEntryId: "e1" }),
      makeRecord({ estimatedCost: cost(3, 4, 0, 0), costKind: "estimated", sourceEntryId: "e2" }),
    ];
    const result = queryUsage(records, filters(), 1);
    expect(result.totals.cost).toEqual({ amount: 10, status: "estimated", currency: "USD" });
  });

  it("marks mixed recorded/estimated aggregates", () => {
    const records = [
      makeRecord({ recordedCost: cost(1, 2, 0, 0), sourceEntryId: "e1" }),
      makeRecord({ estimatedCost: cost(3, 4, 0, 0), costKind: "estimated", sourceEntryId: "e2" }),
    ];
    const result = queryUsage(records, filters(), 1);
    expect(result.totals.cost).toEqual({ amount: 10, status: "mixed", currency: "USD" });
  });

  it("shows unavailable (amount null) when any record lacks a price, keeping token series (DC3)", () => {
    const records = [
      makeRecord({ recordedCost: cost(1, 2, 0, 0), sourceEntryId: "e1", inputTokens: 100 }),
      makeRecord({ provider: "local", model: "ollama", sourceEntryId: "e2", inputTokens: 50 }),
    ];
    const result = queryUsage(records, filters(), 1);
    expect(result.totals.cost).toEqual({ amount: null, status: "unavailable", currency: "USD" });
    expect(result.totals.inputTokens).toBe(150);
    expect(result.totals.totalTokens).toBe(150);
  });

  it("returns $0 recorded for an empty aggregate", () => {
    expect(costDisplay([])).toEqual({ amount: 0, status: "recorded", currency: "USD" });
  });
});

describe("summary usage", () => {
  const records = [
    makeRecord({ sourceEntryId: "a1", inputTokens: 100, timestampMs: BASE_TS }),
    makeRecord({ sourceKind: "summary", sourceEntryId: "c1", inputTokens: 50, timestampMs: BASE_TS, estimatedCost: cost(1, 0, 0, 0), costKind: "estimated" }),
  ];

  it("excludes summary usage by default", () => {
    const result = queryUsage(records, filters(), 1);
    expect(result.totals.inputTokens).toBe(100);
    expect(result.totals.requestCount).toBe(1);
    expect(result.dimensions.models).toEqual(["claude-sonnet-4-5"]);
  });

  it("includes summary tokens/cost when requested, but requestCount stays assistant-only", () => {
    const result = queryUsage(records, filters({ includeSummaryUsage: true }), 1);
    expect(result.totals.inputTokens).toBe(150);
    expect(result.totals.requestCount).toBe(1);
  });
});

describe("duplicate recordId never double counts (DC7)", () => {
  it("collapses duplicate recordIds before aggregating (last wins)", () => {
    const records = [
      makeRecord({ sourceEntryId: "e1", inputTokens: 100, timestampMs: BASE_TS }),
      makeRecord({ sourceEntryId: "e1", inputTokens: 100, timestampMs: BASE_TS }), // duplicate
      makeRecord({ sourceEntryId: "e2", inputTokens: 50, timestampMs: BASE_TS }),
    ];
    const result = queryUsage(records, filters(), 1);
    expect(result.totals.inputTokens).toBe(150);
    expect(result.totals.requestCount).toBe(2);
  });

  it("a replaced record contributes only its latest version to totals", () => {
    const stale = makeRecord({ sourceEntryId: "e1", inputTokens: 1000, timestampMs: BASE_TS });
    const fresh = makeRecord({ sourceEntryId: "e1", inputTokens: 10, timestampMs: BASE_TS });
    const result = queryUsage([stale, fresh], filters(), 1);
    expect(result.totals.inputTokens).toBe(10);
    expect(result.totals.requestCount).toBe(1);
  });
});
