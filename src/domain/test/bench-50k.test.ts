/**
 * R5 性能压力测试：模拟 5 万条上限记录，跑插件 queryUsage（today / all + 趋势），
 * 记录耗时基准。通过 vitest 运行以获得与生产一致的类型/导入路径。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { queryUsage, DEFAULT_BUCKET_MS } from "../aggregate";

const STORE_FILE = join(homedir(), ".pi/agent/token-usage-statistics/records.jsonl");
const DAY_MS = 86_400_000;

const now = Date.now();

/** 复制真实记录并重排 recordId/timestamp，合成 5 万条。 */
function synthRecords(count: number) {
  const base = readFileSync(STORE_FILE, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const records: typeof base = [];
  let i = 0;
  while (records.length < count) {
    const r = base[i % base.length]!;
    const copy = { ...r, recordId: `${r.recordId}#${i}`, timestampMs: r.timestampMs - (i % 30) * DAY_MS };
    records.push(copy);
    i++;
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
  });
});
