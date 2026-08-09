/**
 * R5 性能压力测试：模拟 5 万条上限记录，跑插件 queryUsage（today / all + 趋势），
 * 记录耗时基准。通过 vitest 运行以获得与生产一致的类型/导入路径。
 *
 * 数据为确定性合成记录（不依赖用户真实数据文件，CI 可复现）。当环境变量
 * PI_USAGE_REAL_FILE 指向真实 records.jsonl 时，额外输出真实数据基准日志
 * （仅日志，不做断言——真实文件并非测试环境的一部分）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { queryUsage, DEFAULT_BUCKET_MS } from "../aggregate";
import type { UsageRecord } from "../types";

const DAY_MS = 86_400_000;
const now = Date.now();

/**
 * Deterministic synthetic records: unique recordIds, provider/model drawn from
 * a small pool, timestamps spread over the last 30 days (so both the today
 * window and the all-time trend carry data). Same shape as real normalized
 * records — enough to exercise the full aggregation path.
 */
function synthRecords(count: number): UsageRecord[] {
  const providers = ["anthropic", "openai", "google", "deepseek"];
  const models = ["claude-sonnet-4-5", "claude-opus-4-1", "gpt-4o", "gpt-4o-mini", "gemini-2.5-pro", "deepseek-chat"];
  const records: UsageRecord[] = [];
  for (let i = 0; i < count; i++) {
    const inputTokens = (i % 5000) + 100;
    const outputTokens = (i % 2000) + 50;
    const cacheReadTokens = i % 4 === 0 ? i % 3000 : 0;
    const totalTokens = inputTokens + outputTokens + cacheReadTokens;
    records.push({
      recordId: `s${i % 50}:e${i}`,
      sessionId: `s${i % 50}`,
      sessionPath: `/sessions/s${i % 50}.jsonl`,
      projectCwd: `/projects/p${i % 7}`,
      // 0–29 天前 + 亚秒级偏移：today 窗口内保留 (i % 30 === 0) 的记录。
      timestampMs: now - (i % 30) * DAY_MS - (i % 1000),
      provider: providers[i % providers.length]!,
      model: models[i % models.length]!,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      totalTokens,
      requestCount: 1,
      costKind: "recorded",
      recordedCost: {
        input: inputTokens * 0.000003,
        output: outputTokens * 0.000015,
        cacheRead: cacheReadTokens * 0.0000003,
        cacheWrite: 0,
        total: inputTokens * 0.000003 + outputTokens * 0.000015 + cacheReadTokens * 0.0000003,
      },
      sourceEntryId: `e${i}`,
      sourceKind: "assistant",
    });
  }
  return records;
}

const filters = (fromMs: number) => ({
  providers: [],
  models: [],
  projects: [],
  sessions: [],
  fromMs,
  toMs: now,
  bucketMs: DEFAULT_BUCKET_MS,
  includeSummaryUsage: false,
});

describe("R5: 5 万条上限性能基准", () => {
  it("today + all 查询（含趋势/模型表）均 < 50ms（D2 阈值，取 5 次最小值消除抖动）", () => {
    const records = synthRecords(50_000);
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);

    // 基准方法：多次运行取最小值，规避 GC/并发抖动（测量不稳定性不代表生产性能）。
    const bestOf = (fn: () => void, runs = 5) => {
      let best = Infinity;
      for (let i = 0; i < runs; i++) {
        const t = performance.now();
        fn();
        best = Math.min(best, performance.now() - t);
      }
      return best;
    };

    let today!: ReturnType<typeof queryUsage>;
    const todayMs = bestOf(() => {
      today = queryUsage(records, filters(dayStart.getTime()), now);
    });

    let all!: ReturnType<typeof queryUsage>;
    const allMs = bestOf(() => {
      all = queryUsage(records, filters(0), now);
    });

    console.log(`50k 记录 → today: ${todayMs.toFixed(1)}ms (req=${today!.totals.requestCount}, trend=${today!.trend.length}点) | all: ${allMs.toFixed(1)}ms (req=${all!.totals.requestCount}, trend=${all!.trend.length}点)`);
    expect(todayMs).toBeLessThan(50);
    expect(allMs).toBeLessThan(50);
    expect(today!.totals.requestCount).toBeGreaterThan(0);

    // 可选：真实数据基准（仅日志，不做断言）。
    const realFile = process.env.PI_USAGE_REAL_FILE;
    if (realFile) {
      const real = readFileSync(realFile, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      const realTodayMs = bestOf(() => queryUsage(real, filters(dayStart.getTime()), now));
      const realAllMs = bestOf(() => queryUsage(real, filters(0), now));
      console.log(`真实数据 (${real.length} 条) → today: ${realTodayMs.toFixed(1)}ms | all: ${realAllMs.toFixed(1)}ms`);
    }
  });
});
