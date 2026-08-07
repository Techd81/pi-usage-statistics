/**
 * TUI dashboard surface (design §6): a `ctx.ui.custom()` embedded component
 * rendering the shared `UsageQueryResult` with terminal-safe formatting.
 *
 * - `/pi-usage-statistics` command opens this embedded dashboard; scope
 *   defaults to `global` and can be switched to `project` (records of the
 *   current cwd).
 * - Keys: `p`/`g` scope switch, `m` models-view toggle, `t` time-range
 *   cycle (今天 → 7天 → 30天 → 全部), `Esc` back (models → main first,
 *   then close).
 * - Dual views: the default main view shows a hero Total tokens + Requests/
 *   Cost summary, five metric slots (Input / Output / Cache write / Cache
 *   read / Cache hit with progress bar), and the Usage trend series below;
 *   `[m]` switches to a full-width per-model table (models / requests /
 *   tokens / cost) and back. Narrow terminals stack the main blocks
 *   vertically.
 * - Trend curves: one bar row per series (total, input, output, cache read,
 *   cache write, cost) with a per-series legend value; series visibility and
 *   time range both recompute from the same `store.query` path (TC1).
 * - Narrow widths truncate labels; render() never throws on overflow
 *   (TC2/TC3). Loading/error/empty/estimated/unavailable states render
 *   distinctly (TC3/TC4).
 *
 * The component satisfies Pi's `Component` structural interface
 * (`render(width): string[]`, `handleInput?`, `invalidate()`) with zero
 * runtime dependency on `pi-tui` — the extension lazily imports this module
 * only inside the TUI-mode command path.
 */
import type { UsageFilters, UsageQueryResult, TrendPoint } from "../domain";
import { DEFAULT_BUCKET_MS } from "../domain";
import type { UsageStore } from "../storage";
import {
  displayWidth,
  formatCompactTokens,
  formatCost,
  formatHitRate,
  formatTokens,
  hitRateBar,
  padStartToWidth,
  padToWidth,
  scopeLabel,
  timeRangeLabel,
  trendBar,
  truncateToWidth,
} from "./format";

/** Query scope: all sessions (global) or only the current working directory. */
export type Scope = "global" | "project";

/** Relative time window applied via `filters.fromMs`. */
export type TimeRange = "today" | "7d" | "30d" | "all";

/** Presentation view: hero+metrics+trend, or the per-model table. */
export type ViewMode = "main" | "models";

/** Color functions consumed by the component; injectable for tests. */
export type DashboardTheme = {
  normal: (text: string) => string;
  selected: (text: string) => string;
  error: (text: string) => string;
  muted: (text: string) => string;
};

/** No-op theme: plain text, safe in print/rpc modes and deterministic in tests. */
export const noopTheme: DashboardTheme = {
  normal: (text) => text,
  selected: (text) => text,
  error: (text) => text,
  muted: (text) => text,
};

/** Overlay dependencies: the shared store plus project context. */
export type OverlayDeps = {
  store: UsageStore;
  projectCwd: string;
  initialScope?: Scope;
};

/** Presentation state driving the overlay; the component owns data loading. */
export type OverlayState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; result: UsageQueryResult };

const DAY_MS = 86_400_000;

const rangeFromMs = (range: TimeRange, now: number): number => {
  switch (range) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start.getTime();
    }
    case "7d":
      return now - 7 * DAY_MS;
    case "30d":
      return now - 30 * DAY_MS;
    case "all":
      return 0;
  }
};

const NEXT_RANGE: Record<TimeRange, TimeRange> = { today: "7d", "7d": "30d", "30d": "all", all: "today" };

/** Build query filters from scope + time range; single decode point. */
export function filtersFor(scope: Scope, timeRange: TimeRange, projectCwd: string, now: number): UsageFilters {
  const filters: UsageFilters = {
    providers: [],
    models: [],
    projects: [],
    sessions: [],
    fromMs: rangeFromMs(timeRange, now),
    toMs: now,
    bucketMs: DEFAULT_BUCKET_MS,
    includeSummaryUsage: false,
  };
  if (scope === "project" && projectCwd !== "") filters.projects = [projectCwd];
  return filters;
}

const SERIES_KEYS = ["total", "input", "output", "cacheRead", "cacheWrite", "cost"] as const;
export type SeriesKey = (typeof SERIES_KEYS)[number];

const seriesValues = (trend: readonly TrendPoint[], key: SeriesKey): number[] => {
  switch (key) {
    case "total":
      return trend.map((point) => point.totalTokens);
    case "input":
      return trend.map((point) => point.inputTokens);
    case "output":
      return trend.map((point) => point.outputTokens);
    case "cacheRead":
      return trend.map((point) => point.cacheReadTokens);
    case "cacheWrite":
      return trend.map((point) => point.cacheWriteTokens);
    case "cost":
      return trend.map((point) => point.cost.amount ?? 0);
  }
};

const KEY_ESC = "\u001b";
const KEY_ESC_NAME = "escape";

/** Wide layout uses a side-by-side hero/summary + five metric slots. */
const WIDE_MIN_WIDTH = 60;

const METRIC_SLOTS = [
  { key: "input", label: "Input", value: (r: UsageQueryResult) => formatTokens(r.totals.inputTokens) },
  { key: "output", label: "Output", value: (r: UsageQueryResult) => formatTokens(r.totals.outputTokens) },
  { key: "cacheWrite", label: "Cache write", value: (r: UsageQueryResult) => formatTokens(r.totals.cacheWriteTokens) },
  { key: "cacheRead", label: "Cache read", value: (r: UsageQueryResult) => formatTokens(r.totals.cacheReadTokens) },
] as const;

/**
 * Embedded usage dashboard. Key bindings:
 * `p`/`g` scope, `m` models view, `t` time range, `Esc` back/close.
 */
export class UsageDashboardComponent {
  private state: OverlayState = { kind: "loading" };
  private scope: Scope;
  private timeRange: TimeRange = "today";
  private viewMode: ViewMode = "main";
  private completed = false;
  constructor(
    private readonly deps: OverlayDeps,
    private readonly theme: DashboardTheme = noopTheme,
    private readonly onDone: () => void = () => {},
    private readonly requestRender: () => void = () => {},
  ) {
    this.scope = deps.initialScope ?? "global";
    this.refresh();
  }

  get currentScope(): Scope {
    return this.scope;
  }

  get currentTimeRange(): TimeRange {
    return this.timeRange;
  }

  get currentViewMode(): ViewMode {
    return this.viewMode;
  }

  private refresh(): void {
    try {
      const now = Date.now();
      const result = this.deps.store.query(filtersFor(this.scope, this.timeRange, this.deps.projectCwd, now), now);
      this.state = { kind: "ready", result };
    } catch (error) {
      this.state = { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  handleInput(data: string): void {
    switch (data) {
      case "p":
        if (this.scope !== "project") {
          this.scope = "project";
          this.refresh();
          this.requestRender();
        }
        break;
      case "g":
        if (this.scope !== "global") {
          this.scope = "global";
          this.refresh();
          this.requestRender();
        }
        break;
      case "m":
        this.viewMode = this.viewMode === "main" ? "models" : "main";
        this.requestRender();
        break;
      case "t":
        this.timeRange = NEXT_RANGE[this.timeRange];
        this.refresh();
        this.requestRender();
        break;
      case KEY_ESC:
      case KEY_ESC_NAME:
        if (this.viewMode === "models") {
          this.viewMode = "main";
          this.requestRender();
          break;
        }
        if (!this.completed) {
          this.completed = true;
          this.onDone();
        }
        break;
    }
  }

  invalidate(): void {
    // No cached rendering state; nothing to invalidate.
  }

  render(width: number): string[] {
    const w = Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
    const lines: string[] = [];

    if (this.state.kind === "loading") {
      lines.push(this.theme.muted("Loading usage data…"));
    } else if (this.state.kind === "error") {
      lines.push(this.theme.error("⚠ Usage data unavailable"));
      lines.push(this.theme.muted(truncateToWidth(this.state.message, w)));
    } else {
      const result = this.state.result;
      if (this.viewMode === "models") {
        this.renderModelsView(lines, result, w);
      } else {
        if (result.totals.requestCount === 0 && result.totals.totalTokens === 0) {
          lines.push(this.theme.normal("No usage data in the selected range."));
        }
        this.renderMainView(lines, result, w);
      }
    }

    lines.push(this.theme.muted(truncateToWidth(this.statusLine(), w)));
    return lines.map((line) => truncateToWidth(line, w));
  }

  /** Default main view: hero + metric slots + usage trend (no model table). */
  private renderMainView(lines: string[], result: UsageQueryResult, width: number): void {
    if (width < WIDE_MIN_WIDTH) {
      this.renderMainNarrow(lines, result, width);
    } else {
      this.renderMainWide(lines, result, width);
    }
    lines.push(this.theme.selected(truncateToWidth("Usage trend", width)));
    this.renderSeries(lines, result, width);
  }

  /** Wide: hero left, Requests/Cost right, five equal metric slots below. */
  private renderMainWide(lines: string[], result: UsageQueryResult, width: number): void {
    const totals = result.totals;
    const heroLabel = "Total tokens";
    const heroValue = formatTokens(totals.totalTokens);
    const heroSub = `~ ${formatCompactTokens(totals.totalTokens)}`;
    const reqLabel = "Requests";
    const reqValue = formatTokens(totals.requestCount);
    const costLabel = "Cost";
    const costValue = formatCost(totals.cost);

    const rightReq = `${reqLabel}  ${reqValue}`;
    const rightCost = `${costLabel}  ${costValue}`;
    const rightW = Math.max(displayWidth(rightReq), displayWidth(rightCost), 12);
    const leftW = Math.max(0, width - rightW - 1);

    // Budget plain-text columns first; apply color only after truncation.
    const leftLabel = padToWidth(truncateToWidth(heroLabel, leftW), leftW);
    const rightReqCell = padStartToWidth(truncateToWidth(rightReq, rightW), rightW);
    lines.push(`${this.theme.muted(leftLabel)} ${this.theme.normal(rightReqCell)}`);

    const leftValue = padToWidth(truncateToWidth(heroValue, leftW), leftW);
    const rightCostCell = padStartToWidth(truncateToWidth(rightCost, rightW), rightW);
    lines.push(`${this.theme.selected(leftValue)} ${this.theme.normal(rightCostCell)}`);

    const leftSub = padToWidth(truncateToWidth(heroSub, leftW), leftW);
    const rightBlank = " ".repeat(rightW);
    lines.push(`${this.theme.muted(leftSub)} ${rightBlank}`);

    lines.push(...this.metricSlotRows(result, width));
  }

  /** Narrow: vertical stack — hero → Requests/Cost → metrics → (trend outside). */
  private renderMainNarrow(lines: string[], result: UsageQueryResult, width: number): void {
    const totals = result.totals;
    lines.push(this.theme.muted(truncateToWidth("Total tokens", width)));
    lines.push(this.theme.selected(truncateToWidth(formatTokens(totals.totalTokens), width)));
    lines.push(this.theme.muted(truncateToWidth(`~ ${formatCompactTokens(totals.totalTokens)}`, width)));
    lines.push(this.theme.normal(truncateToWidth(`Requests  ${formatTokens(totals.requestCount)}`, width)));
    lines.push(this.theme.normal(truncateToWidth(`Cost  ${formatCost(totals.cost)}`, width)));

    for (const slot of METRIC_SLOTS) {
      const row = `${slot.label}  ${slot.value(result)}`;
      lines.push(this.theme.normal(truncateToWidth(row, width)));
    }
    const hitPct = formatHitRate(totals.cacheHitRate);
    const hitPrefix = `Cache hit  ${hitPct} `;
    const barW = Math.max(0, width - displayWidth(hitPrefix));
    const bar = hitRateBar(totals.cacheHitRate, barW);
    lines.push(this.theme.normal(truncateToWidth(`${hitPrefix}${bar}`.trimEnd(), width)));
  }

  /**
   * Five equal-width metric slots on one or two rows. Cache hit includes a
   * percent + block progress bar; column widths differ by at most 1.
   */
  private metricSlotRows(result: UsageQueryResult, width: number): string[] {
    const slots = 5;
    const base = Math.floor(width / slots);
    const rem = width - base * slots;
    const widths = Array.from({ length: slots }, (_, i) => base + (i < rem ? 1 : 0));

    const totals = result.totals;
    const labels = ["Input", "Output", "Cache write", "Cache read", "Cache hit"];
    const values = [
      formatTokens(totals.inputTokens),
      formatTokens(totals.outputTokens),
      formatTokens(totals.cacheWriteTokens),
      formatTokens(totals.cacheReadTokens),
      formatHitRate(totals.cacheHitRate),
    ];

    const labelRow = labels
      .map((label, i) => padToWidth(truncateToWidth(label, widths[i]!), widths[i]!))
      .join("");
    const valueCells = values.map((value, i) => {
      const w = widths[i]!;
      if (i < 4) return padToWidth(truncateToWidth(value, w), w);
      // Cache hit: percent + bar in the remaining slot width.
      const pct = value;
      const gap = " ";
      const prefixW = displayWidth(pct) + displayWidth(gap);
      const barW = Math.max(0, w - prefixW);
      const cell = `${pct}${gap}${hitRateBar(totals.cacheHitRate, barW)}`;
      return padToWidth(truncateToWidth(cell, w), w);
    });
    const valueRow = valueCells.join("");
    return [this.theme.muted(labelRow), this.theme.normal(valueRow)];
  }

  /** Full-width per-model table (four columns). */
  private renderModelsView(lines: string[], result: UsageQueryResult, width: number): void {
    const modelRows = this.modelLines(result, width, true);
    if (modelRows.length === 0) {
      lines.push(this.theme.muted(truncateToWidth("No models in the selected range.", width)));
      return;
    }
    for (const row of modelRows) {
      lines.push(this.theme.normal(row));
    }
  }

  /** Per-model table rows; `withHeader` adds the four-column header. */
  private modelLines(result: UsageQueryResult, width: number, withHeader: boolean): string[] {
    const models = result.byModel;
    const lines: string[] = [];
    if (models.length === 0) return lines;
    const reqMax = Math.max(8, ...models.map((entry) => displayWidth(formatTokens(entry.requestCount))));
    const tokMax = Math.max(6, ...models.map((entry) => displayWidth(formatTokens(entry.totalTokens))));
    const costMax = Math.max(4, ...models.map((entry) => displayWidth(formatCost(entry.cost))));
    const reserved = reqMax + tokMax + costMax + 6;
    const longestName = Math.max(6, ...models.map((entry) => displayWidth(entry.model)));
    const nameMax = Math.max(6, Math.min(longestName, Math.max(6, width - reserved)));
    if (withHeader) {
      const header =
        padToWidth("models", nameMax) +
        padStartToWidth("requests", reqMax + 2) +
        padStartToWidth("tokens", tokMax + 2) +
        padStartToWidth("cost", costMax + 2);
      lines.push(truncateToWidth(header, width));
    }
    for (const entry of models) {
      const name = truncateToWidth(entry.model, nameMax);
      const rowText =
        padToWidth(name, nameMax) +
        padStartToWidth(formatTokens(entry.requestCount), reqMax + 2) +
        padStartToWidth(formatTokens(entry.totalTokens), tokMax + 2) +
        padStartToWidth(formatCost(entry.cost), costMax + 2);
      lines.push(truncateToWidth(rowText, width));
    }
    return lines;
  }

  private renderSeries(lines: string[], result: UsageQueryResult, width: number): void {
    // All six series on every width; the bar span shrinks on narrow terminals
    // and truncateToWidth keeps the row in bounds (no series filtering).
    // Budget plain columns first (label + sum + 1-col gap + bars = width), then color.
    const labelWidth = 11;
    const sumWidth = 14;
    const barWidth = Math.max(1, width - labelWidth - sumWidth - 1);
    for (const key of SERIES_KEYS) {
      const values = seriesValues(result.trend, key);
      const sum = key === "cost" ? formatCost(result.totals.cost) : formatTokens(values.reduce((a, b) => a + b, 0));
      const bars = trendBar(values, barWidth);
      const label = padToWidth(truncateToWidth(key, labelWidth), labelWidth);
      const sumCell = padStartToWidth(truncateToWidth(sum, sumWidth), sumWidth);
      const plain = truncateToWidth(`${label}${sumCell} ${bars}`, width);
      lines.push(this.theme.normal(plain));
    }
  }

  private statusLine(): string {
    const scope = scopeLabel(this.scope);
    const time = timeRangeLabel(this.timeRange);
    return `范围: ${scope} · 时间: ${time} · [p]项目 [g]全局 [m] models [t]时间 [ESC]back`;
  }
}

/**
 * Build the overlay factory for `ctx.ui.custom()`. Maps the Pi `theme`
 * argument onto the small `DashboardTheme`; any failure falls back to
 * `noopTheme` so rendering never crashes Pi (non-fatal by contract).
 */
export function makeOverlayFactory(deps: OverlayDeps) {
  return (tui: { requestRender(): void }, theme: unknown, _keybindings: unknown, done: (value: null) => void) => {
    let paint = noopTheme;
    try {
      const piTheme = theme as { fg?: (color: string, text: string) => string } | null;
      if (piTheme?.fg) {
        paint = {
          normal: (text) => piTheme.fg!("text", text),
          selected: (text) => piTheme.fg!("accent", text),
          error: (text) => piTheme.fg!("error", text),
          muted: (text) => piTheme.fg!("muted", text),
        };
      }
    } catch {
      paint = noopTheme;
    }
    const requestRender = () => {
      try {
        tui.requestRender();
      } catch {
        // Rendering is best-effort; a failure must not crash the command.
      }
    };
    return new UsageDashboardComponent(deps, paint, () => done(null), requestRender);
  };
}
