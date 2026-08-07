/**
 * Aggregation: filtering happens strictly before aggregation (DC5), totals
 * and cache-hit rate follow the documented formulas (DC2), trend buckets are
 * deterministic and epoch-aligned (DC6), and duplicate `recordId`s never
 * increment totals twice (DC7).
 *
 * Cost provenance is preserved per aggregate: recorded / estimated /
 * unavailable counts feed a `CostDisplay` where any unavailable record makes
 * the aggregate amount null ("--") while token series stay intact (DC3).
 */
import type { CostDisplay, ModelUsage, UsageFilters, UsageQueryResult, UsageRecord, TrendPoint } from "./types";
import { COST_CURRENCY } from "./types";

/** Default trend bucket width (ms); 30_000 is a supported value per the parent design. */
export const DEFAULT_BUCKET_MS = 30_000;

/** Upper bound on emitted trend points; wider ranges scale the bucket width. */
export const MAX_TREND_BUCKETS = 10_000;

/** Cost provenance sums for an aggregate (exposed for UI markers). */
export type AggregatedCost = {
  recorded: number;
  estimated: number;
  unavailableCount: number;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Validate and normalize untrusted query parameters (web API / TUI share this
 * single contract). Returns null for structurally invalid input; missing
 * fields get documented defaults.
 */
export function validateFilters(value: unknown): UsageFilters | null {
  if (!isObject(value)) return null;
  const providers = value.providers === undefined ? [] : isStringArray(value.providers) ? value.providers : null;
  const models = value.models === undefined ? [] : isStringArray(value.models) ? value.models : null;
  const projects = value.projects === undefined ? [] : isStringArray(value.projects) ? value.projects : null;
  const sessions = value.sessions === undefined ? [] : isStringArray(value.sessions) ? value.sessions : null;
  if (providers === null || models === null || projects === null || sessions === null) return null;
  const fromMs = value.fromMs === undefined ? 0 : isFiniteNumber(value.fromMs) ? value.fromMs : null;
  const toMs = value.toMs === undefined ? Number.POSITIVE_INFINITY : isFiniteNumber(value.toMs) ? value.toMs : null;
  if (fromMs === null || toMs === null) return null;
  const bucketMs =
    value.bucketMs === undefined ? DEFAULT_BUCKET_MS : isFiniteNumber(value.bucketMs) ? value.bucketMs : null;
  if (bucketMs === null || bucketMs <= 0) return null;
  const includeSummaryUsage =
    value.includeSummaryUsage === undefined ? false : typeof value.includeSummaryUsage === "boolean" ? value.includeSummaryUsage : null;
  if (includeSummaryUsage === null) return null;
  return { providers, models, projects, sessions, fromMs, toMs, bucketMs, includeSummaryUsage };
}

const matches = (record: UsageRecord, filters: UsageFilters): boolean => {
  if (record.sourceKind === "summary" && !filters.includeSummaryUsage) return false;
  if (record.timestampMs < filters.fromMs || record.timestampMs > filters.toMs) return false;
  if ((filters.providers?.length ?? 0) > 0 && !filters.providers!.includes(record.provider)) return false;
  if ((filters.models?.length ?? 0) > 0 && !filters.models!.includes(record.model)) return false;
  if ((filters.projects?.length ?? 0) > 0 && !filters.projects!.includes(record.projectCwd)) return false;
  if ((filters.sessions?.length ?? 0) > 0 && !filters.sessions!.includes(record.sessionId)) return false;
  return true;
};

/**
 * Cache-hit rate per the documented formula (parent design §4):
 * `cacheRead / (input + cacheRead + cacheWrite) * 100`, expressed as a
 * percentage. Returns null when the denominator is zero (DC2).
 */
export function cacheHitRate(inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number): number | null {
  const denominator = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (denominator === 0) return null;
  return (cacheReadTokens / denominator) * 100;
}

/** Cost provenance sums over a set of records; defensively treats missing costs as unavailable. */
export function aggregateCost(records: readonly UsageRecord[]): AggregatedCost {
  let recorded = 0;
  let estimated = 0;
  let unavailableCount = 0;
  for (const record of records) {
    if (record.costKind === "recorded" && record.recordedCost) {
      recorded += record.recordedCost.total;
    } else if (record.costKind === "estimated" && record.estimatedCost) {
      estimated += record.estimatedCost.total;
    } else {
      unavailableCount += 1;
    }
  }
  return { recorded, estimated, unavailableCount };
}

/**
 * Aggregate cost display policy:
 * - empty set -> $0 with "recorded" status (a zero-request aggregate is well defined);
 * - any unavailable record -> amount null ("--"), status "unavailable" (DC3);
 * - otherwise amount = recorded + estimated, status by provenance mix.
 */
export function costDisplay(records: readonly UsageRecord[]): CostDisplay {
  if (records.length === 0) return { amount: 0, status: "recorded", currency: COST_CURRENCY };
  const { recorded, estimated, unavailableCount } = aggregateCost(records);
  if (unavailableCount > 0) return { amount: null, status: "unavailable", currency: COST_CURRENCY };
  const amount = recorded + estimated;
  if (recorded > 0 && estimated > 0) return { amount, status: "mixed", currency: COST_CURRENCY };
  if (estimated > 0) return { amount, status: "estimated", currency: COST_CURRENCY };
  return { amount, status: "recorded", currency: COST_CURRENCY };
}

const distinctSorted = (values: string[]): string[] =>
  [...new Set(values.filter((value) => value !== ""))].sort();

/**
 * Per-model aggregates over the filtered set. `requestCount` counts finalized
 * assistant responses only (same semantics as `totals.requestCount`); summary
 * usage contributes tokens but never requests. `cost` reuses `costDisplay` on
 * that model's records (recorded / estimated / mixed / unavailable). Empty
 * model names are skipped (mirrors the `dimensions` filter). Sorted by
 * requestCount desc, then model name asc — deterministic for tests and stable
 * UI ordering.
 */
function buildByModel(records: readonly UsageRecord[]): ModelUsage[] {
  const byModel = new Map<string, UsageRecord[]>();
  for (const record of records) {
    if (record.model === "") continue;
    const list = byModel.get(record.model);
    if (list) list.push(record);
    else byModel.set(record.model, [record]);
  }
  return [...byModel.entries()]
    .map(([model, modelRecords]) => {
      let requestCount = 0;
      let totalTokens = 0;
      for (const record of modelRecords) {
        if (record.sourceKind === "assistant") requestCount += record.requestCount;
        totalTokens += record.totalTokens;
      }
      return { model, requestCount, totalTokens, cost: costDisplay(modelRecords) };
    })
    .sort((a, b) => b.requestCount - a.requestCount || a.model.localeCompare(b.model));
}

/**
 * Effective bucket width for the trend: the requested `bucketMs` unless the
 * range would exceed MAX_TREND_BUCKETS, in which case the width is scaled up
 * to the next larger multiple of `bucketMs` — every boundary stays on the
 * original epoch-aligned grid, deterministically.
 */
function effectiveBucketMs(fromMs: number, toMs: number, bucketMs: number): number {
  const lower = Number.isFinite(fromMs) ? fromMs : 0;
  const upper = Number.isFinite(toMs) ? toMs : Number.MAX_SAFE_INTEGER;
  if (upper <= lower) return bucketMs;
  const rawCount = Math.floor((upper - lower) / bucketMs) + 1;
  if (rawCount <= MAX_TREND_BUCKETS) return bucketMs;
  const scale = Math.floor((upper - lower) / (bucketMs * MAX_TREND_BUCKETS)) + 1;
  return bucketMs * scale;
}

const trendPoint = (startMs: number, records: readonly UsageRecord[]): TrendPoint => {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const record of records) {
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    cacheReadTokens += record.cacheReadTokens;
    cacheWriteTokens += record.cacheWriteTokens;
  }
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  return { startMs, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, totalTokens, cost: costDisplay(records) };
};

/**
 * Build the epoch-aligned trend. Every bucket start is a multiple of the
 * effective bucket width; empty buckets are emitted as zero points so the
 * time axis stays continuous. Time bounds are inclusive (DC6).
 */
function buildTrend(records: readonly UsageRecord[], filters: UsageFilters): TrendPoint[] {
  // Inverted range: fromMs > toMs means no records qualify (matches() also rejects every record).
  if (filters.fromMs > filters.toMs) return [];
  const bucketMs = effectiveBucketMs(filters.fromMs, filters.toMs, filters.bucketMs);
  const lower = Number.isFinite(filters.fromMs) ? filters.fromMs : 0;
  const upper = Number.isFinite(filters.toMs) ? filters.toMs : Number.MAX_SAFE_INTEGER;
  const firstStart = Math.floor(lower / bucketMs) * bucketMs;
  const lastStart = Math.floor(upper / bucketMs) * bucketMs;
  if (lastStart < firstStart) return [];
  const count = Math.floor((lastStart - firstStart) / bucketMs) + 1;
  const buckets = new Map<number, UsageRecord[]>();
  for (const record of records) {
    const start = Math.floor(record.timestampMs / bucketMs) * bucketMs;
    if (start < firstStart || start > lastStart) continue;
    const list = buckets.get(start);
    if (list) list.push(record);
    else buckets.set(start, [record]);
  }
  const points: TrendPoint[] = [];
  for (let i = 0; i < count; i++) {
    const startMs = firstStart + i * bucketMs;
    points.push(trendPoint(startMs, buckets.get(startMs) ?? []));
  }
  return points;
}

/**
 * Query usage records with the given filters.
 *
 * - Duplicate `recordId`s are collapsed before aggregation (last occurrence
 *   wins) so a record arriving from both a live event and a scan is never
 *   counted twice (DC7).
 * - `requestCount` counts finalized assistant responses only; summary usage
 *   contributes tokens/cost but not requests.
 * - Dimensions are derived from the filtered set.
 */
export function queryUsage(
  records: readonly UsageRecord[],
  filters: UsageFilters,
  refreshedAtMs?: number,
): UsageQueryResult {
  const byId = new Map<string, UsageRecord>();
  for (const record of records) byId.set(record.recordId, record);
  const unique = [...byId.values()];
  const filtered = unique.filter((record) => matches(record, filters));

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let requestCount = 0;
  for (const record of filtered) {
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    cacheReadTokens += record.cacheReadTokens;
    cacheWriteTokens += record.cacheWriteTokens;
    if (record.sourceKind === "assistant") requestCount += record.requestCount;
  }
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

  return {
    filters,
    totals: {
      totalTokens,
      requestCount,
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      cacheHitRate: cacheHitRate(inputTokens, cacheReadTokens, cacheWriteTokens),
      cost: costDisplay(filtered),
    },
    trend: buildTrend(filtered, filters),
    byModel: buildByModel(filtered),
    dimensions: {
      providers: distinctSorted(filtered.map((record) => record.provider)),
      models: distinctSorted(filtered.map((record) => record.model)),
      projects: distinctSorted(filtered.map((record) => record.projectCwd)),
      sessions: distinctSorted(filtered.map((record) => record.sessionId)),
    },
    refreshedAtMs: refreshedAtMs ?? Date.now(),
  };
}
