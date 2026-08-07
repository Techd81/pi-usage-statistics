/**
 * 独立统计验证脚本（R1）—— 不 import 任何插件代码的参考实现。
 *
 * 用途：
 * 1. 从 records.jsonl 用独立逻辑重算聚合（tokens / requestCount / cost /
 *    cacheHitRate / byModel / trend / dimensions），与插件 queryUsage()
 *    输出对比（vitest 测试 src/domain/test/probe-real-data.test.ts 消费）。
 * 2. 抽查会话文件：独立解析 assistant 消息 usage → 对比 records.jsonl 中
 *    对应 recordId 的 token 数与 recordedCost（验证 normalize 正确性）。
 * 3. 输出可归档的基准报告。
 *
 * 运行：node scripts/verify-stats.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const STORE_FILE = join(HOME, ".pi/agent/token-usage-statistics/records.jsonl");
const SESSIONS_DIR = join(HOME, ".pi/agent/sessions");

/* ------------------------------------------------------------------ */
/* 独立聚合（参考实现，逻辑独立于插件 src/domain/aggregate.ts）          */
/* ------------------------------------------------------------------ */

/** 归一化路径：小写 + 正斜杠 + 去尾斜杠（与插件 D3 设计一致，独立实现）。 */
export function normalizePath(p) {
  const s = String(p ?? "").replace(/\\/g, "/").toLowerCase();
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
}

export function pathsMatch(a, b) {
  return normalizePath(a) === normalizePath(b);
}

/** recordId 去重（last wins），与插件 upsert 语义一致。 */
export function dedupe(records) {
  const byId = new Map();
  for (const r of records) byId.set(r.recordId, r);
  return [...byId.values()];
}

export function matches(record, filters) {
  if (record.sourceKind === "summary" && !filters.includeSummaryUsage) return false;
  if (record.timestampMs < filters.fromMs || record.timestampMs > filters.toMs) return false;
  if (filters.providers?.length && !filters.providers.includes(record.provider)) return false;
  if (filters.models?.length && !filters.models.includes(record.model)) return false;
  if (filters.projects?.length && !filters.projects.some((p) => pathsMatch(p, record.projectCwd))) return false;
  if (filters.sessions?.length && !filters.sessions.includes(record.sessionId)) return false;
  return true;
}

/** 独立 cacheHitRate 实现：cacheRead / (input + cacheRead + cacheWrite) × 100。 */
export function cacheHitRate(inputTokens, cacheReadTokens, cacheWriteTokens) {
  const denominator = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (denominator === 0) return null;
  return (cacheReadTokens / denominator) * 100;
}

/** 独立成本聚合：recorded + estimated 求和，unavailable 计数。 */
export function aggregateCost(records) {
  let recorded = 0;
  let estimated = 0;
  let unavailableCount = 0;
  for (const r of records) {
    if (r.costKind === "recorded" && r.recordedCost) recorded += r.recordedCost.total;
    else if (r.costKind === "estimated" && r.estimatedCost) estimated += r.estimatedCost.total;
    else unavailableCount += 1;
  }
  return { recorded, estimated, unavailableCount };
}

/** 独立 costDisplay：空集 $0 recorded；有 unavailable 则 null；否则三态。 */
export function costDisplay(records) {
  if (records.length === 0) return { amount: 0, status: "recorded" };
  const { recorded, estimated, unavailableCount } = aggregateCost(records);
  if (unavailableCount > 0) return { amount: null, status: "unavailable" };
  const amount = recorded + estimated;
  if (recorded > 0 && estimated > 0) return { amount, status: "mixed" };
  if (estimated > 0) return { amount, status: "estimated" };
  return { amount, status: "recorded" };
}

const distinctSorted = (values) => [...new Set(values.filter((v) => v !== ""))].sort();

/** 独立按模型聚合（requestCount 只计 assistant，排序 requestCount desc + model asc）。 */
export function byModel(records) {
  const groups = new Map();
  for (const r of records) {
    if (r.model === "") continue;
    if (!groups.has(r.model)) groups.set(r.model, []);
    groups.get(r.model).push(r);
  }
  return [...groups.entries()]
    .map(([model, rs]) => {
      let requestCount = 0;
      let totalTokens = 0;
      for (const r of rs) {
        if (r.sourceKind === "assistant") requestCount += r.requestCount;
        totalTokens += r.totalTokens;
      }
      const cost = costDisplay(rs);
      const avgCost =
        cost.amount !== null && requestCount > 0
          ? { amount: cost.amount / requestCount, status: cost.status }
          : { amount: null, status: "unavailable" };
      return { model, requestCount, totalTokens, cost, avgCost };
    })
    .sort((a, b) => b.requestCount - a.requestCount || a.model.localeCompare(b.model));
}

/** 独立趋势桶：对齐到首个桶边界，空桶补零，边界含入；超 MAX_TREND_BUCKETS 时按倍数放大桶宽（与插件防护一致）。
 * 「全部」（fromMs <= 0）时窗口从最早一条过滤记录开始（而非 Unix epoch），
 * 与插件 buildTrend 同步——否则 1970→now 的巨型窗口会把真实历史压成少数 mega-bucket。 */
export function trend(records, filters) {
  if (filters.fromMs > filters.toMs) return [];
  const upper = Number.isFinite(filters.toMs) ? filters.toMs : Number.MAX_SAFE_INTEGER;
  let lower = Number.isFinite(filters.fromMs) ? filters.fromMs : 0;
  if (lower <= 0) {
    if (records.length === 0) return [];
    lower = records[0].timestampMs;
    for (let i = 1; i < records.length; i++) {
      const ts = records[i].timestampMs;
      if (ts < lower) lower = ts;
    }
  }
  const bucketMs = effectiveBucketMs(lower, upper, filters.bucketMs);
  const firstStart = Math.floor(lower / bucketMs) * bucketMs;
  const lastStart = Math.floor(upper / bucketMs) * bucketMs;
  if (lastStart < firstStart) return [];
  const buckets = new Map();
  for (const r of records) {
    const start = Math.floor(r.timestampMs / bucketMs) * bucketMs;
    if (start < firstStart || start > lastStart) continue;
    if (!buckets.has(start)) buckets.set(start, []);
    buckets.get(start).push(r);
  }
  const points = [];
  for (let i = 0; i <= Math.floor((lastStart - firstStart) / bucketMs); i++) {
    const startMs = firstStart + i * bucketMs;
    const rs = buckets.get(startMs) ?? [];
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
    for (const r of rs) {
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      cacheReadTokens += r.cacheReadTokens;
      cacheWriteTokens += r.cacheWriteTokens;
    }
    points.push({
      startMs,
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      cost: costDisplay(rs),
    });
  }
  return points;
}

/** 独立 effectiveBucketMs：桶数超过上限时放大到下一个倍数（与插件 DC6 一致）。 */
export function effectiveBucketMs(fromMs, toMs, bucketMs) {
  const lower = Number.isFinite(fromMs) ? fromMs : 0;
  const upper = Number.isFinite(toMs) ? toMs : Number.MAX_SAFE_INTEGER;
  if (upper <= lower) return bucketMs;
  const rawCount = Math.floor((upper - lower) / bucketMs) + 1;
  if (rawCount <= 10000) return bucketMs;
  const scale = Math.floor((upper - lower) / (bucketMs * 10000)) + 1;
  return bucketMs * scale;
}

/** 独立 queryUsage 参考实现。返回与插件 UsageQueryResult 相同形状。 */
export function independentQuery(records, filters) {
  const unique = dedupe(records);
  const filtered = unique.filter((r) => matches(r, filters));

  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, requestCount = 0;
  for (const r of filtered) {
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    cacheReadTokens += r.cacheReadTokens;
    cacheWriteTokens += r.cacheWriteTokens;
    if (r.sourceKind === "assistant") requestCount += r.requestCount;
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
    trend: trend(filtered, filters),
    byModel: byModel(filtered),
    dimensions: {
      providers: distinctSorted(filtered.map((r) => r.provider)),
      models: distinctSorted(filtered.map((r) => r.model)),
      projects: distinctSorted(filtered.map((r) => r.projectCwd)),
      sessions: distinctSorted(filtered.map((r) => r.sessionId)),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 会话文件抽查：独立解析 assistant usage → 对比存储记录                  */
/* ------------------------------------------------------------------ */

function parseJsonl(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // 截断/损坏行跳过
    }
  }
  return entries;
}

/** 抽查：选取 N 个会话文件，独立解析 assistant 消息 usage 并与 records 对比。 */
export function spotCheckSessions(records, maxFiles = 5) {
  const recordById = new Map(records.map((r) => [r.recordId, r]));
  const dirs = readdirSync(SESSIONS_DIR).filter((d) => !d.startsWith("."));
  const files = [];
  for (const d of dirs) {
    const dirPath = join(SESSIONS_DIR, d);
    for (const f of readdirSync(dirPath)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dirPath, f);
      if (statSync(p).size > 0) files.push(p);
    }
  }
  files.sort();
  const sample = files.slice(0, maxFiles);
  const mismatches = [];
  let checked = 0;

  for (const file of sample) {
    const entries = parseJsonl(file);
    const sessionId = entries.find((e) => e.type === "session")?.id ?? "";
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (!msg || typeof msg !== "object" || msg.role !== "assistant") continue;
      const usage = msg.usage;
      const timestamp = msg.timestamp;
      let entryId = "";
      if (typeof msg.responseId === "string" && msg.responseId) entryId = msg.responseId;
      else if (typeof timestamp === "number" && Number.isFinite(timestamp)) entryId = `msg:${timestamp}:${fnv1a(JSON.stringify(msg.content ?? ""))}`;
      else entryId = entry.id ?? "";
      if (!entryId || !sessionId) continue;
      const recordId = `${sessionId}:${entryId}`;
      const record = recordById.get(recordId);
      checked++;
      if (!record) {
        mismatches.push({ file, recordId, issue: "存储缺失该 recordId" });
        continue;
      }
      // 独立重算 token 数（与插件 tokenCount 相同的防御规则）
      const u = usage && typeof usage === "object" ? usage : {};
      const toInt = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
      const inputTokens = toInt(u.input);
      const outputTokens = toInt(u.output);
      const cacheReadTokens = toInt(u.cacheRead);
      const cacheWriteTokens = toInt(u.cacheWrite);
      if (
        record.inputTokens !== inputTokens ||
        record.outputTokens !== outputTokens ||
        record.cacheReadTokens !== cacheReadTokens ||
        record.cacheWriteTokens !== cacheWriteTokens
      ) {
        mismatches.push({
          file, recordId, issue: "token 数不一致",
          expected: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
          actual: { inputTokens: record.inputTokens, outputTokens: record.outputTokens, cacheReadTokens: record.cacheReadTokens, cacheWriteTokens: record.cacheWriteTokens },
        });
      }
      // cost 对比（recorded 时）
      if (record.costKind === "recorded" && usage?.cost && typeof usage.cost === "object") {
        const c = usage.cost;
        const valid = [c.input, c.output, c.cacheRead, c.cacheWrite, c.total].every(
          (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
        );
        if (valid && record.recordedCost && Math.abs(record.recordedCost.total - c.total) > 1e-9) {
          mismatches.push({ file, recordId, issue: "recordedCost.total 不一致", expected: c.total, actual: record.recordedCost.total });
        }
      }
    }
  }
  return { files: sample.length, checked, mismatches };
}

/** FNV-1a 32-bit hash（与插件 dedupe 侧 fingerprint 规则一致）。 */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/* ------------------------------------------------------------------ */
/* main：基准报告                                                       */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

function rangeFromMs(range, now) {
  switch (range) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start.getTime();
    }
    case "7d": return now - 7 * DAY_MS;
    case "30d": return now - 30 * DAY_MS;
    default: return 0;
  }
}

function main() {
  const t0 = Date.now();
  const text = readFileSync(STORE_FILE, "utf8");
  const records = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const loadMs = Date.now() - t0;
  const now = Date.now();
  const fmt = (n) => (n === null ? "--" : n.toFixed(4));

  const ranges = ["today", "7d", "30d", "all"];
  const scopeProject = ["D:\\pi-usage-statistics"];

  console.log(`records.jsonl: ${records.length} 条, 加载 ${loadMs}ms\n`);
  for (const range of ranges) {
    const fromMs = range === "all" ? 0 : rangeFromMs(range, now);
    const globalQ = independentQuery(records, { providers: [], models: [], projects: [], sessions: [], fromMs, toMs: now, bucketMs: 30000, includeSummaryUsage: false });
    const projectQ = independentQuery(records, { providers: [], models: [], projects: scopeProject, sessions: [], fromMs, toMs: now, bucketMs: 30000, includeSummaryUsage: false });
    const g = globalQ.totals, p = projectQ.totals;
    console.log(
      `${range.padEnd(6)} global: req=${g.requestCount} tokens=${g.totalTokens} cost=${fmt(g.cost.amount)} hit=${g.cacheHitRate?.toFixed(1) ?? "--"}% | ` +
      `project: req=${p.requestCount} tokens=${p.totalTokens} cost=${fmt(p.cost.amount)} hit=${p.cacheHitRate?.toFixed(1) ?? "--"}%`,
    );
  }

  // byModel top（all 全局）
  const allGlobal = independentQuery(records, { providers: [], models: [], projects: [], sessions: [], fromMs: 0, toMs: now, bucketMs: 30000, includeSummaryUsage: false });
  console.log("\nbyModel top10 (all/global):");
  for (const m of allGlobal.byModel.slice(0, 10)) {
    console.log(`  ${m.model.padEnd(32)} req=${m.requestCount} tokens=${m.totalTokens} cost=${fmt(m.cost.amount)} avg=${fmt(m.avgCost.amount)}`);
  }

  // 会话抽查
  const spot = spotCheckSessions(records, 5);
  console.log(`\n会话抽查: ${spot.files} 文件, ${spot.checked} 条 assistant 记录, 不一致 ${spot.mismatches.length}`);
  for (const m of spot.mismatches.slice(0, 5)) console.log("  MISMATCH:", JSON.stringify(m));

  console.log(`\n总耗时: ${Date.now() - t0}ms`);
}

// 直接运行（非 import 时）
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  main();
}
