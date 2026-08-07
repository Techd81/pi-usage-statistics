/**
 * R1 统计正确性对比测试：独立参考实现（scripts/verify-stats.mjs，不 import
 * 插件聚合代码）vs 插件 queryUsage()，在真实 records.jsonl 上逐项对比。
 *
 * 覆盖：totals（tokens 分解 / requestCount / cacheHitRate / cost）、
 * byModel、trend、dimensions；范围：today / 7d / 30d / all × global / project。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { queryUsage, DEFAULT_BUCKET_MS } from "../aggregate";
import { independentQuery } from "../../../scripts/verify-stats.mjs";

const STORE_FILE = join(homedir(), ".pi/agent/token-usage-statistics/records.jsonl");

const records = readFileSync(STORE_FILE, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const DAY_MS = 86_400_000;

const mkFilters = (range: string, projects: string[], now: number) => {
  let fromMs = 0;
  if (range === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    fromMs = start.getTime();
  } else if (range === "7d") fromMs = now - 7 * DAY_MS;
  else if (range === "30d") fromMs = now - 30 * DAY_MS;
  return {
    providers: [] as string[],
    models: [] as string[],
    projects,
    sessions: [] as string[],
    fromMs,
    toMs: now,
    bucketMs: DEFAULT_BUCKET_MS,
    includeSummaryUsage: false,
  };
};

const expectClose = (a: unknown, b: unknown, path: string) => {
  if (typeof a === "number" && typeof b === "number") {
    expect(Math.abs(a - b), `${path}: ${a} vs ${b}`).toBeLessThan(1e-6);
    return;
  }
  expect(a, path).toEqual(b);
};

const compareResults = (label: string, plugin: ReturnType<typeof queryUsage>, independent: ReturnType<typeof independentQuery>) => {
  // totals
  const t1 = plugin.totals, t2 = independent.totals;
  for (const key of ["totalTokens", "requestCount", "inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"] as const) {
    expectClose(t1[key], t2[key], `${label} totals.${key}`);
  }
  expectClose(t1.cacheHitRate, t2.cacheHitRate, `${label} totals.cacheHitRate`);
  expectClose(t1.cost.amount, t2.cost.amount, `${label} totals.cost.amount`);
  expect(t1.cost.status, `${label} totals.cost.status`).toBe(t2.cost.status);
  // byModel
  expect(plugin.byModel.length, `${label} byModel.length`).toBe(independent.byModel.length);
  for (let i = 0; i < plugin.byModel.length; i++) {
    const a = plugin.byModel[i]!, b = independent.byModel[i]!;
    expect(a.model, `${label} byModel[${i}].model`).toBe(b.model);
    expectClose(a.requestCount, b.requestCount, `${label} byModel[${i}].requestCount`);
    expectClose(a.totalTokens, b.totalTokens, `${label} byModel[${i}].totalTokens`);
    expectClose(a.cost.amount, b.cost.amount, `${label} byModel[${i}].cost.amount`);
    expect(a.cost.status, `${label} byModel[${i}].cost.status`).toBe(b.cost.status);
    expectClose(a.avgCost.amount, b.avgCost.amount, `${label} byModel[${i}].avgCost.amount`);
  }
  // trend
  expect(plugin.trend.length, `${label} trend.length`).toBe(independent.trend.length);
  for (let i = 0; i < plugin.trend.length; i++) {
    const a = plugin.trend[i]!, b = independent.trend[i]!;
    expect(a.startMs, `${label} trend[${i}].startMs`).toBe(b.startMs);
    for (const key of ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens", "totalTokens"] as const) {
      expectClose(a[key], b[key], `${label} trend[${i}].${key}`);
    }
    expectClose(a.cost.amount, b.cost.amount, `${label} trend[${i}].cost.amount`);
  }
  // dimensions
  expect(plugin.dimensions, `${label} dimensions`).toEqual(independent.dimensions);
};

describe("R1: 插件 queryUsage vs 独立参考实现（真实数据）", () => {
  it("today / 7d / 30d / all × global / project 全部一致", () => {
    const now = Date.now();
    const ranges = ["today", "7d", "30d", "all"] as const;
    const scopes = [
      { name: "global", projects: [] as string[] },
      { name: "project", projects: ["D:\\pi-usage-statistics"] as string[] },
    ];
    for (const range of ranges) {
      for (const scope of scopes) {
        const filters = mkFilters(range, scope.projects, now);
        const plugin = queryUsage(records, filters, now);
        const independent = independentQuery(records, filters);
        compareResults(`${range}/${scope.name}`, plugin, independent);
      }
    }
    expect(true).toBe(true);
  });

  it("project 正斜杠变体与反斜杠等价（归一化生效前的预期行为对比）", () => {
    const now = Date.now();
    const back = queryUsage(records, mkFilters("all", ["D:\\pi-usage-statistics"], now));
    // 独立实现已含归一化；插件当前为精确匹配（本测试在 R3 修复后应保持一致）
    const indepBack = independentQuery(records, mkFilters("all", ["D:\\pi-usage-statistics"], now));
    const indepFwd = independentQuery(records, mkFilters("all", ["D:/pi-usage-statistics"], now));
    expectClose(indepFwd.totals.requestCount, indepBack.totals.requestCount, "独立实现正斜杠等价");
    expectClose(indepFwd.totals.totalTokens, back.totals.totalTokens, "独立实现与插件反斜杠结果一致");
  });
});
