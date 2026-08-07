import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUCKET_MS,
  MAX_TREND_BUCKETS,
  cacheHitRate,
  costDisplay,
  normalizePath,
  pathsMatch,
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

describe("per-model aggregates (byModel)", () => {
  const unavailable = { amount: null, status: "unavailable" as const, currency: "USD" as const };

  it("aggregates requestCount and totalTokens per model", () => {
    const records = [
      makeRecord({ model: "claude-sonnet-4-5", sourceEntryId: "e1", inputTokens: 100, timestampMs: BASE_TS }),
      makeRecord({ model: "claude-sonnet-4-5", sourceEntryId: "e2", inputTokens: 50, timestampMs: BASE_TS }),
      makeRecord({ model: "gpt-5-mini", sourceEntryId: "e3", inputTokens: 30, outputTokens: 20, timestampMs: BASE_TS }),
    ];
    const result = queryUsage(records, filters(), 1);
    expect(result.byModel).toEqual([
      { model: "claude-sonnet-4-5", requestCount: 2, totalTokens: 150, cost: unavailable, avgCost: unavailable },
      { model: "gpt-5-mini", requestCount: 1, totalTokens: 50, cost: unavailable, avgCost: unavailable },
    ]);
  });

  it("counts summary tokens but never summary requests", () => {
    const records = [
      makeRecord({ model: "claude-sonnet-4-5", sourceEntryId: "a1", inputTokens: 100, timestampMs: BASE_TS }),
      makeRecord({ sourceKind: "summary", model: "claude-sonnet-4-5", sourceEntryId: "c1", inputTokens: 50, timestampMs: BASE_TS }),
    ];
    const result = queryUsage(records, filters({ includeSummaryUsage: true }), 1);
    expect(result.byModel).toEqual([
      { model: "claude-sonnet-4-5", requestCount: 1, totalTokens: 150, cost: unavailable, avgCost: unavailable },
    ]);
  });

  it("skips empty model names", () => {
    const records = [
      makeRecord({ model: "", sourceEntryId: "e1", inputTokens: 100, timestampMs: BASE_TS }),
      makeRecord({ model: "gpt-5", sourceEntryId: "e2", inputTokens: 10, timestampMs: BASE_TS }),
    ];
    const result = queryUsage(records, filters(), 1);
    expect(result.byModel).toEqual([
      { model: "gpt-5", requestCount: 1, totalTokens: 10, cost: unavailable, avgCost: unavailable },
    ]);
  });

  it("sorts by requestCount desc, then model name asc (deterministic)", () => {
    const records = [
      makeRecord({ model: "zzz", sourceEntryId: "e1", timestampMs: BASE_TS }),
      makeRecord({ model: "aaa", sourceEntryId: "e2", timestampMs: BASE_TS }),
      makeRecord({ model: "bbb", sourceEntryId: "e3", timestampMs: BASE_TS }),
      makeRecord({ model: "bbb", sourceEntryId: "e4", timestampMs: BASE_TS }),
    ];
    const result = queryUsage(records, filters(), 1);
    expect(result.byModel.map((entry) => entry.model)).toEqual(["bbb", "aaa", "zzz"]);
  });

  it("model sums match the overall totals (AC4)", () => {
    const records = [
      makeRecord({ model: "claude-sonnet-4-5", sourceEntryId: "e1", inputTokens: 100, outputTokens: 40, cacheReadTokens: 30, cacheWriteTokens: 5, timestampMs: BASE_TS }),
      makeRecord({ sourceKind: "summary", model: "claude-sonnet-4-5", sourceEntryId: "c1", inputTokens: 50, timestampMs: BASE_TS }),
      makeRecord({ model: "gpt-5-mini", sourceEntryId: "e2", inputTokens: 30, outputTokens: 20, timestampMs: BASE_TS }),
    ];
    const result = queryUsage(records, filters({ includeSummaryUsage: true }), 1);
    const sumRequests = result.byModel.reduce((sum, entry) => sum + entry.requestCount, 0);
    const sumTokens = result.byModel.reduce((sum, entry) => sum + entry.totalTokens, 0);
    expect(sumRequests).toBe(result.totals.requestCount);
    expect(sumTokens).toBe(result.totals.totalTokens);
  });

  it("aggregates per-model cost with recorded / estimated / mixed / unavailable", () => {
    const records = [
      makeRecord({ model: "rec-model", sourceEntryId: "r1", inputTokens: 10, timestampMs: BASE_TS, recordedCost: cost(1, 2, 0, 0) }),
      makeRecord({ model: "est-model", sourceEntryId: "e1", inputTokens: 10, timestampMs: BASE_TS, estimatedCost: cost(3, 4, 0, 0), costKind: "estimated" }),
      makeRecord({ model: "mix-model", sourceEntryId: "m1", inputTokens: 10, timestampMs: BASE_TS, recordedCost: cost(1, 0, 0, 0) }),
      makeRecord({ model: "mix-model", sourceEntryId: "m2", inputTokens: 10, timestampMs: BASE_TS, estimatedCost: cost(2, 0, 0, 0), costKind: "estimated" }),
      makeRecord({ model: "unavail-model", sourceEntryId: "u1", inputTokens: 10, timestampMs: BASE_TS }),
      makeRecord({ model: "unavail-model", sourceEntryId: "u2", inputTokens: 5, timestampMs: BASE_TS, recordedCost: cost(1, 0, 0, 0) }),
    ];
    const result = queryUsage(records, filters(), 1);
    const byName = Object.fromEntries(result.byModel.map((entry) => [entry.model, entry]));
    expect(byName["rec-model"]!.cost).toEqual({ amount: 3, status: "recorded", currency: "USD" });
    expect(byName["rec-model"]!.avgCost).toEqual({ amount: 3, status: "recorded", currency: "USD" });
    expect(byName["est-model"]!.cost).toEqual({ amount: 7, status: "estimated", currency: "USD" });
    expect(byName["est-model"]!.avgCost).toEqual({ amount: 7, status: "estimated", currency: "USD" });
    expect(byName["mix-model"]!.cost).toEqual({ amount: 3, status: "mixed", currency: "USD" });
    expect(byName["mix-model"]!.avgCost).toEqual({ amount: 1.5, status: "mixed", currency: "USD" });
    expect(byName["unavail-model"]!.cost).toEqual({ amount: null, status: "unavailable", currency: "USD" });
    expect(byName["unavail-model"]!.avgCost).toEqual({ amount: null, status: "unavailable", currency: "USD" });
    // Per-model costs do not change overall totals aggregation.
    expect(result.totals.totalTokens).toBe(55);
    expect(result.totals.requestCount).toBe(6);
  });

  it("avgCost is amount/requestCount when computable, else unavailable", () => {
    const records = [
      makeRecord({ model: "pair", sourceEntryId: "a", inputTokens: 10, timestampMs: BASE_TS, recordedCost: cost(2, 0, 0, 0) }),
      makeRecord({ model: "pair", sourceEntryId: "b", inputTokens: 10, timestampMs: BASE_TS, recordedCost: cost(4, 0, 0, 0) }),
      makeRecord({ sourceKind: "summary", model: "summary-only", sourceEntryId: "c", inputTokens: 50, timestampMs: BASE_TS, recordedCost: cost(9, 0, 0, 0) }),
    ];
    const result = queryUsage(records, filters({ includeSummaryUsage: true }), 1);
    const byName = Object.fromEntries(result.byModel.map((entry) => [entry.model, entry]));
    expect(byName["pair"]!.requestCount).toBe(2);
    expect(byName["pair"]!.cost.amount).toBe(6);
    expect(byName["pair"]!.avgCost).toEqual({ amount: 3, status: "recorded", currency: "USD" });
    // Summary tokens/cost without assistant requests → avg unavailable.
    expect(byName["summary-only"]!.requestCount).toBe(0);
    expect(byName["summary-only"]!.cost.amount).toBe(9);
    expect(byName["summary-only"]!.avgCost).toEqual({ amount: null, status: "unavailable", currency: "USD" });
  });
});

describe("pathsMatch / normalizePath (D3 路径归一化)", () => {
  it("归一化：反斜杠/正斜杠/大小写/尾斜杠收敛到同一形式", () => {
    expect(normalizePath("D:\\pi-usage-statistics")).toBe("d:/pi-usage-statistics");
    expect(normalizePath("D:/pi-usage-statistics")).toBe("d:/pi-usage-statistics");
    expect(normalizePath("d:\\PI-USAGE-STATISTICS\\")).toBe("d:/pi-usage-statistics");
    expect(normalizePath("D:/pi-usage-statistics/")).toBe("d:/pi-usage-statistics");
    expect(normalizePath("D:\\")).toBe("d:");
    expect(normalizePath("")).toBe("");
  });

  it("变体互相匹配，不同路径不误配", () => {
    expect(pathsMatch("D:\\pi-usage-statistics", "D:/pi-usage-statistics")).toBe(true);
    expect(pathsMatch("D:\\pi-usage-statistics", "d:\\pi-usage-statistics\\")).toBe(true);
    expect(pathsMatch("D:\\pi-usage-statistics", "D:\\pi-usage-statistics\\src")).toBe(false);
    expect(pathsMatch("D:\\pi-usage-statistics", "")).toBe(false);
    expect(pathsMatch("", "")).toBe(true);
  });

  it("project 过滤对路径变体不敏感（AC3）", () => {
    const record = makeRecord({ projectCwd: "D:\\pi-usage-statistics", inputTokens: 10, timestampMs: BASE_TS });
    const cases: string[][] = [
      ["D:\\pi-usage-statistics"],
      ["D:/pi-usage-statistics"],
      ["d:\\PI-USAGE-STATISTICS\\"],
      ["D:/pi-usage-statistics/"],
    ];
    for (const projects of cases) {
      const result = queryUsage([record], filters({ projects }), 1);
      expect(result.totals.totalTokens, `projects=${JSON.stringify(projects)}`).toBe(10);
      expect(result.totals.requestCount).toBe(1);
    }
  });

  it("project 过滤匹配根目录 D:\\ 变体", () => {
    const record = makeRecord({ projectCwd: "D:\\", inputTokens: 5, timestampMs: BASE_TS });
    for (const projects of [["D:\\"], ["D:/"], ["d:"]]) {
      const result = queryUsage([record], filters({ projects }), 1);
      expect(result.totals.totalTokens, `projects=${JSON.stringify(projects)}`).toBe(5);
    }
  });
});
