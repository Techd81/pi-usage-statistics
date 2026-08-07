/**
 * Domain types for the token-usage plugin.
 *
 * This module is the single owner of the normalized record, filter, and
 * query-result contracts shared by the storage, web, and TUI layers.
 * Consumers must import these types instead of re-declaring the shapes
 * (see .trellis/spec/guides/cross-layer-thinking-guide.md: decode once at
 * the boundary, project everywhere else).
 */

/** Currency used by every cost display. Pi reports provider costs in USD. */
export const COST_CURRENCY = "USD" as const;

/** Per-component and total cost in USD. */
export type CostBreakdown = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

/** Cost provenance for a single record. */
export type CostKind = "recorded" | "estimated" | "unavailable";

/** Cost provenance for an aggregate of records. */
export type CostStatus = "recorded" | "estimated" | "mixed" | "unavailable";

/** Where the usage originated: a finalized assistant response or a summary generation. */
export type SourceKind = "assistant" | "summary";

/**
 * One normalized usage event (one finalized assistant response or one
 * summary generation). Produced only by `src/domain/normalize.ts` plus the
 * cost policy in `src/domain/pricing.ts`.
 */
export type UsageRecord = {
  /** Stable identity: `${sessionId}:${entryId}`. Never counted twice. */
  recordId: string;
  sessionId: string;
  sessionPath: string;
  projectCwd: string;
  /** Epoch milliseconds; drives time-range filters and epoch-aligned buckets. */
  timestampMs: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Canonical sum: input + output + cacheRead + cacheWrite (Pi usage-totals semantics). */
  totalTokens: number;
  requestCount: 1;
  /** Provider-reported cost; present only when the recorded cost validated. */
  recordedCost?: CostBreakdown;
  /** Estimated cost from the price table; present only when `costKind === "estimated"`. */
  estimatedCost?: CostBreakdown;
  costKind: CostKind;
  sourceEntryId: string;
  sourceKind: SourceKind;
};

/**
 * Query filters. Empty string arrays mean "all". Time bounds are inclusive
 * on both ends: a record passes when `fromMs <= timestampMs <= toMs`.
 */
export type UsageFilters = {
  providers?: string[];
  models?: string[];
  projects?: string[];
  sessions?: string[];
  /** Inclusive lower bound (epoch ms). */
  fromMs: number;
  /** Inclusive upper bound (epoch ms). */
  toMs: number;
  /** Trend bucket width in ms; 30_000 is a supported value. */
  bucketMs: number;
  /** When false, summary usage is excluded from totals and trend. */
  includeSummaryUsage: boolean;
};

/**
 * Cost of an aggregate with provenance for the UI.
 * `amount: null` means unavailable and the UI renders "--"; a zero price is
 * never fabricated for a missing price.
 */
export type CostDisplay = {
  amount: number | null;
  status: CostStatus;
  currency: typeof COST_CURRENCY;
};

export type TrendPoint = {
  startMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cost: CostDisplay;
};

/** Per-model usage aggregate for the dashboard model table. */
export type ModelUsage = {
  model: string;
  /** Finalized assistant responses only; summary usage is excluded (mirrors `totals.requestCount`). */
  requestCount: number;
  totalTokens: number;
  /** Per-model cost via the same `costDisplay` rules as overall totals. */
  cost: CostDisplay;
};

/** Shared query contract consumed by both the web API and the TUI. */
export type UsageQueryResult = {
  filters: UsageFilters;
  totals: {
    totalTokens: number;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    cacheHitRate: number | null;
    cost: CostDisplay;
  };
  trend: TrendPoint[];
  /** Per-model aggregates, sorted by requestCount desc then model name asc (deterministic). */
  byModel: ModelUsage[];
  dimensions: {
    providers: string[];
    models: string[];
    projects: string[];
    sessions: string[];
  };
  refreshedAtMs: number;
};
