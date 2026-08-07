/**
 * 类型声明：scripts/verify-stats.mjs（R1 独立参考实现）。
 * 仅标注测试消费到的导出；实现为 .mjs，供 `node scripts/verify-stats.mjs` 直接运行。
 */

export type IndependentTotals = {
  totalTokens: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  cacheHitRate: number | null;
  cost: { amount: number | null; status: string };
};

export type IndependentQueryResult = {
  filters: unknown;
  totals: IndependentTotals;
  trend: Array<{
    startMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    cost: { amount: number | null; status: string };
  }>;
  byModel: Array<{
    model: string;
    requestCount: number;
    totalTokens: number;
    cost: { amount: number | null; status: string };
    avgCost: { amount: number | null; status: string };
  }>;
  dimensions: {
    providers: string[];
    models: string[];
    projects: string[];
    sessions: string[];
  };
};

export declare function normalizePath(p: string): string;
export declare function pathsMatch(a: string, b: string): boolean;
export declare function dedupe(records: readonly unknown[]): unknown[];
export declare function matches(record: unknown, filters: unknown): boolean;
export declare function cacheHitRate(inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number): number | null;
export declare function aggregateCost(records: readonly unknown[]): { recorded: number; estimated: number; unavailableCount: number };
export declare function costDisplay(records: readonly unknown[]): { amount: number | null; status: string };
export declare function byModel(records: readonly unknown[]): IndependentQueryResult["byModel"];
export declare function trend(records: readonly unknown[], filters: unknown): IndependentQueryResult["trend"];
export declare function effectiveBucketMs(fromMs: number, toMs: number, bucketMs: number): number;
export declare function independentQuery(records: readonly unknown[], filters: unknown): IndependentQueryResult;
export declare function spotCheckSessions(
  records: readonly unknown[],
  maxFiles?: number,
): { files: number; checked: number; mismatches: Array<Record<string, unknown>> };
