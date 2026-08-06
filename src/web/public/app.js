/**
 * 使用统计 dashboard (vanilla JS, no framework, no CDN).
 *
 * Consumes only the loopback API (`/api/filters`, `/api/usage`) and renders
 * the reference hierarchy: header/subtitle, provider/model/project/session
 * filters, interval + date-range controls, overview card, five cards, and a
 * responsive dual-axis SVG trend chart with a legend.
 *
 * States: loading / empty / error / estimated (cost marker) / unavailable
 * (`--`). Polling runs only while the page is open (default 30s) and pauses
 * when the tab is hidden; in-flight requests never overlap.
 */

"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  provider: "",
  model: "",
  project: "",
  session: "",
  rangeKey: "today",
  intervalMs: 30_000,
  data: null, // UsageQueryResult | null
  error: null,
};

let pollTimer = null;
let inflight = false;

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

/** SVG namespace: createElement() yields an HTML element that never renders as SVG. */
const SVG_NS = "http://www.w3.org/2000/svg";

function applyAttrs(node, attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.setAttribute("class", value);
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  for (const child of children) node.appendChild(child);
  return node;
}

/** Create an SVG-namespace element (required for svg/line/polyline/text to render). */
function elNS(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  applyAttrs(node, attrs);
  for (const child of children) node.appendChild(child);
  return node;
}

// ---------------------------------------------------------------------------
// Formatting (mirrors runtime/format.ts semantics)
// ---------------------------------------------------------------------------

const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

function formatTokens(value) {
  return numberFormat.format(value);
}

/** Cost follows the TUI convention: fixed 4 decimals, `--` when unavailable. */
function formatCost(cost) {
  if (cost === null || cost.amount === null) return "--";
  const base = `$${cost.amount.toFixed(4)}`;
  if (cost.status === "estimated") return `~${base}（估算）`;
  if (cost.status === "mixed") return `${base}（混合）`;
  return base;
}

function formatHitRate(rate) {
  return rate === null ? "--" : `${rate.toFixed(1)}%`;
}

/** Compact tick labels for the token axis: 1.2k / 3.4M / 1.1B. */
function formatCompact(value) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

/** Compact tick labels for the cost axis (small USD values). */
function formatCompactCost(value) {
  if (value >= 1e3) return `$${formatCompact(value)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

/** Round a maximum up to a "nice" 1/2/5 × 10^k step for axis scaling. */
function niceMax(value) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const factor = value / power;
  if (factor <= 1) return power;
  if (factor <= 2) return 2 * power;
  if (factor <= 5) return 5 * power;
  return 10 * power;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function apiJson(path) {
  const res = await fetch(path);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = body && typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}

function currentRange() {
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  switch (state.rangeKey) {
    case "today":
      return { fromMs: startOfToday.getTime(), toMs: now };
    case "24h":
      return { fromMs: now - 24 * 3_600_000, toMs: now };
    case "7d":
      return { fromMs: now - 7 * 24 * 3_600_000, toMs: now };
    default: // "all"
      return { fromMs: 0, toMs: now };
  }
}

function usageUrl() {
  const params = new URLSearchParams();
  const range = currentRange();
  params.set("fromMs", String(range.fromMs));
  params.set("toMs", String(range.toMs));
  params.set("bucketMs", String(state.intervalMs));
  if (state.provider) params.set("providers", state.provider);
  if (state.model) params.set("models", state.model);
  if (state.project) params.set("projects", state.project);
  if (state.session) params.set("sessions", state.session);
  return `/api/usage?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function setStatus(kind, message) {
  const node = $("status");
  node.className = `status ${kind}`;
  node.textContent = message ?? "";
  if (kind === "error") {
    // Never stack retry buttons across repeated failures.
    node.querySelector("#retry")?.remove();
    const retry = el("button", { id: "retry", type: "button", text: "重试" });
    retry.addEventListener("click", loadData);
    node.appendChild(retry);
  }
}

/** Populate a filter select from dimensions, preserving the current value. */
function fillSelect(select, values, placeholder, current) {
  // The placeholder option's value is "" so selecting it means "all" — the
  // empty string is exactly what the API treats as an absent filter.
  const options = [{ value: "", text: placeholder }];
  for (const value of values) options.push({ value, text: value });
  if (current && !values.includes(current)) options.push({ value: current, text: current });
  select.innerHTML = "";
  for (const { value, text } of options) {
    select.appendChild(el("option", { value, text }));
  }
  select.value = current;
}

function populateFilters(dimensions) {
  fillSelect($("filter-provider"), dimensions.providers, "全部来源", state.provider);
  fillSelect($("filter-model"), dimensions.models, "全部模型", state.model);
  fillSelect($("filter-project"), dimensions.projects, "全部项目", state.project);
  fillSelect($("filter-session"), dimensions.sessions, "全部会话", state.session);
}

function renderOverview() {
  const totals = state.data.totals;
  $("stat-tokens").textContent = formatTokens(totals.totalTokens);
  $("stat-requests").textContent = formatTokens(totals.requestCount);
  $("stat-cost").textContent = formatCost(totals.cost);
}

function renderCards() {
  const totals = state.data.totals;
  $("card-input").textContent = formatTokens(totals.inputTokens);
  $("card-output").textContent = formatTokens(totals.outputTokens);
  $("card-cache-write").textContent = formatTokens(totals.cacheWriteTokens);
  $("card-cache-read").textContent = formatTokens(totals.cacheReadTokens);
  $("card-hit-rate").textContent = formatHitRate(totals.cacheHitRate);
}

function renderRefreshedAt() {
  $("refreshed-at").textContent = new Date(state.data.refreshedAtMs).toLocaleTimeString("zh-CN", { hour12: false });
}

function renderChartNote() {
  const cost = state.data.totals.cost;
  const note = $("chart-cost-note");
  if (cost.amount === null) {
    note.textContent = "成本数据不可用（--）";
  } else if (cost.status === "estimated" || cost.status === "mixed") {
    note.textContent = "成本为估算值（~）";
  } else {
    note.textContent = "";
  }
}

// --- Trend chart (SVG, dual axis) -------------------------------------------

const SERIES = [
  { key: "inputTokens", color: "#10b981", axis: "token" },
  { key: "outputTokens", color: "#3b82f6", axis: "token" },
  { key: "cacheWriteTokens", color: "#8b5cf6", axis: "token" },
  { key: "cacheReadTokens", color: "#f97316", axis: "token" },
];

const CHART_HEIGHT = 280;
const PAD = { top: 16, right: 64, bottom: 30, left: 56 };

function formatTimeLabel(ms, spanMs) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  if (spanMs <= 3_600_000) return `${hh}:${mm}:${ss}`;
  if (spanMs <= 7 * 86_400_000) return `${d.getMonth() + 1}-${d.getDate()} ${hh}:${mm}`;
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Split a series into runs of consecutive indexes (breaks cost at nulls). */
function consecutiveRuns(points) {
  const runs = [];
  let run = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point === null) {
      if (run.length > 0) {
        runs.push(run);
        run = [];
      }
      continue;
    }
    if (run.length > 0 && point.index !== run[run.length - 1].index + 1) {
      runs.push(run);
      run = [];
    }
    run.push(point);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

function renderChart() {
  const container = $("chart");
  const trend = state.data.trend;

  if (trend.length === 0) {
    container.innerHTML = "";
    container.appendChild(el("div", { class: "chart-empty", text: "暂无趋势数据" }));
    return;
  }

  const width = Math.max(container.clientWidth || 800, 320);
  const plotW = width - PAD.left - PAD.right;
  const plotH = CHART_HEIGHT - PAD.top - PAD.bottom;

  const spanMs = (trend[trend.length - 1].startMs - trend[0].startMs) + state.intervalMs;
  const maxToken = niceMax(Math.max(...trend.map((p) => p.totalTokens), 1));
  const maxCost = niceMax(Math.max(...trend.map((p) => (p.cost.amount === null ? 0 : p.cost.amount)), 1));

  const x = (i) => (trend.length === 1 ? PAD.left + plotW / 2 : PAD.left + (i / (trend.length - 1)) * plotW);
  const yToken = (v) => PAD.top + plotH - (v / maxToken) * plotH;
  const yCost = (v) => PAD.top + plotH - (v / maxCost) * plotH;

  const svg = elNS("svg", {
    viewBox: `0 0 ${width} ${CHART_HEIGHT}`,
    xmlns: SVG_NS,
    role: "img",
    "aria-label": "使用趋势图",
  });

  // Token-axis gridlines + ticks (left).
  for (let i = 0; i <= 4; i++) {
    const value = (maxToken * i) / 4;
    const y = yToken(value);
    svg.appendChild(elNS("line", { x1: PAD.left, y1: y, x2: width - PAD.right, y2: y, stroke: "#eef0f3", "stroke-width": 1 }));
    svg.appendChild(elNS("text", { class: "tick-text", x: PAD.left - 6, y: y + 3, "text-anchor": "end", text: formatCompact(value) }));
  }
  svg.appendChild(elNS("text", { class: "axis-label", x: 10, y: PAD.top + 8, text: "Tokens" }));

  // Cost-axis ticks (right).
  for (let i = 0; i <= 4; i++) {
    const value = (maxCost * i) / 4;
    const y = yCost(value);
    svg.appendChild(elNS("text", { class: "tick-text", x: width - PAD.right + 6, y: y + 3, text: formatCompactCost(value) }));
  }
  svg.appendChild(elNS("text", { class: "axis-label", x: width - 10, y: PAD.top + 8, "text-anchor": "end", text: "Cost ($)" }));

  // Time-axis labels.
  const step = Math.max(1, Math.ceil(trend.length / 6));
  for (let i = 0; i < trend.length; i += step) {
    const point = trend[i];
    svg.appendChild(
      elNS("text", {
        class: "tick-text",
        x: x(i),
        y: CHART_HEIGHT - 8,
        "text-anchor": "middle",
        text: formatTimeLabel(point.startMs, spanMs),
      }),
    );
  }

  // Token series lines.
  for (const series of SERIES) {
    const points = trend.map((p, i) => ({ index: i, x: x(i), y: yToken(p[series.key]) }));
    for (const run of consecutiveRuns(points)) {
      const polyline = elNS("polyline", {
        points: run.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "),
        fill: "none",
        stroke: series.color,
        "stroke-width": 1.6,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      });
      svg.appendChild(polyline);
    }
  }

  // Cost series (right axis); segments break where cost is unavailable.
  const costPoints = trend.map((p, i) => {
    if (p.cost.amount === null) return null;
    return { index: i, x: x(i), y: yCost(p.cost.amount) };
  });
  for (const run of consecutiveRuns(costPoints)) {
    const polyline = elNS("polyline", {
      points: run.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "),
      fill: "none",
      stroke: "#ef4444",
      "stroke-width": 1.6,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    });
    svg.appendChild(polyline);
  }

  container.innerHTML = "";
  container.appendChild(svg);
}

// ---------------------------------------------------------------------------
// Data loading + polling
// ---------------------------------------------------------------------------

async function loadData() {
  if (inflight) return;
  inflight = true;
  if (!state.data) setStatus("loading");
  try {
    const [dimensions, usage] = await Promise.all([apiJson("/api/filters"), apiJson(usageUrl())]);
    state.data = usage;
    state.error = null;
    populateFilters(dimensions);
    renderAll();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    if (state.data) {
      setStatus("stale", `刷新失败：${state.error}`);
    } else {
      setStatus("error", `加载失败：${state.error}`);
    }
  } finally {
    inflight = false;
    if (!state.error) {
      const totals = state.data.totals;
      if (totals.requestCount === 0 && totals.totalTokens === 0) {
        setStatus("empty", "暂无数据：开始使用 Pi 后，这里会显示 Token 统计。");
      } else {
        setStatus("ok", "");
      }
    }
  }
}

function renderAll() {
  renderOverview();
  renderCards();
  renderChartNote();
  renderChart();
  renderRefreshedAt();
}

function schedulePoll() {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!document.hidden) loadData();
  }, state.intervalMs);
}

function onFilterChange() {
  state.provider = $("filter-provider").value;
  state.model = $("filter-model").value;
  state.project = $("filter-project").value;
  state.session = $("filter-session").value;
  state.rangeKey = $("filter-range").value;
  state.intervalMs = Number($("filter-interval").value);
  schedulePoll();
  loadData();
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

$("filter-provider").addEventListener("change", onFilterChange);
$("filter-model").addEventListener("change", onFilterChange);
$("filter-project").addEventListener("change", onFilterChange);
$("filter-session").addEventListener("change", onFilterChange);
$("filter-range").addEventListener("change", onFilterChange);
$("filter-interval").addEventListener("change", onFilterChange);

// Redraw the chart (not the data) on resize, debounced.
let resizeTimer = null;
window.addEventListener("resize", () => {
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.data) renderChart();
  }, 150);
});

// Refresh immediately when the tab becomes visible again.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    loadData();
    schedulePoll();
  }
});

schedulePoll();
loadData();
