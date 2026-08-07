/**
 * TUI dashboard surface (design §6): a `ctx.ui.custom()` embedded component
 * rendering the shared `UsageQueryResult` with terminal-safe formatting.
 *
 * - `/pi-usage-statistics` command opens this embedded dashboard; scope
 *   defaults to `global` and can be switched to `project` (records of the
 *   current cwd).
 * - Keys: `p`/`g` scope switch, `s` series-visibility cycle, `t` time-range
 *   cycle (今天 → 7天 → 30天 → 全部), `q` close, `Esc` back.
 * - Trend curves: one bar row per series (total, input, output, cache read,
 *   cache write, cost) with a per-series legend value; series visibility and
 *   time range both recompute from the same `store.query` path (TC1).
 * - Narrow widths hide secondary rows and truncate labels; render() never
 *   throws on overflow (TC2/TC3). Loading/error/empty/estimated/unavailable
 *   states render distinctly (TC3/TC4).
 *
 * The component satisfies Pi's `Component` structural interface
 * (`render(width): string[]`, `handleInput?`, `invalidate()`) with zero
 * runtime dependency on `pi-tui` — the extension lazily imports this module
 * only inside the TUI-mode command path.
 */
import type { UsageFilters, UsageQueryResult, TrendPoint } from "../domain";
import { DEFAULT_BUCKET_MS } from "../domain";
import type { UsageStore } from "../storage";
import { formatCost, formatTokens, scopeLabel, timeRangeLabel, trendBar, truncateToWidth } from "./format";

/** Query scope: all sessions (global) or only the current working directory. */
export type Scope = "global" | "project";

/** Which trend series rows are visible. */
export type SeriesMode = "all" | "tokens" | "cost";

/** Relative time window applied via `filters.fromMs`. */
export type TimeRange = "today" | "7d" | "30d" | "all";

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
const NEXT_SERIES: Record<SeriesMode, SeriesMode> = { all: "tokens", tokens: "cost", cost: "all" };

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

const KEY_QUIT = "q";
const KEY_ESC = "\u001b";
const KEY_ESC_NAME = "escape";
/**
 * Embedded usage dashboard. Key bindings:
 * `p`/`g` scope, `s` series visibility, `t` time range, `q` close, `Esc` back.
 */
export class UsageDashboardComponent {
  private state: OverlayState = { kind: "loading" };
  private scope: Scope;
  private timeRange: TimeRange = "today";
  private seriesMode: SeriesMode = "all";
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

  get currentSeriesMode(): SeriesMode {
    return this.seriesMode;
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
      case "s":
        this.seriesMode = NEXT_SERIES[this.seriesMode];
        this.requestRender();
        break;
      case "t":
        this.timeRange = NEXT_RANGE[this.timeRange];
        this.refresh();
        this.requestRender();
        break;
      case KEY_QUIT:
      case KEY_ESC:
      case KEY_ESC_NAME:
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
      if (result.totals.requestCount === 0 && result.totals.totalTokens === 0) {
        lines.push(this.theme.normal("No usage data in the selected range."));
      }
      this.renderMetrics(lines, result, w);
      this.renderSeries(lines, result, w);
    }

    lines.push(this.theme.muted(truncateToWidth(this.statusLine(), w)));
    return lines.map((line) => truncateToWidth(line, w));
  }

  private renderMetrics(lines: string[], result: UsageQueryResult, width: number): void {
    const totals = result.totals;
    const labelWidth = Math.min(14, Math.max(0, Math.floor(width / 3)));
    const row = (label: string, value: string, style: (s: string) => string = this.theme.normal): void => {
      const padded = label.padEnd(labelWidth);
      lines.push(truncateToWidth(`${padded}${style(value)}`, width));
    };
    row("requests", formatTokens(totals.requestCount));
    row("total tokens", formatTokens(totals.totalTokens));
    if (width >= 60) {
      row("input", formatTokens(totals.inputTokens));
      row("output", formatTokens(totals.outputTokens));
      row("cache write", formatTokens(totals.cacheWriteTokens));
      row("cache read", formatTokens(totals.cacheReadTokens));
    }
    row("cache hit", totals.cacheHitRate === null ? "--" : `${totals.cacheHitRate.toFixed(1)}%`);
    row("cost", formatCost(totals.cost), this.theme.selected);
  }

  private renderSeries(lines: string[], result: UsageQueryResult, width: number): void {
    const visible: SeriesKey[] =
      this.seriesMode === "cost"
        ? ["cost"]
        : this.seriesMode === "tokens"
          ? ["total", "input", "output", "cacheRead", "cacheWrite"]
          : [...SERIES_KEYS];
    // Narrow terminals keep only the headline series.
    const effective = width < 60 ? visible.filter((key) => key === "total" || key === "cost") : visible;

    const labelWidth = 11;
    const sumWidth = 14;
    const barWidth = Math.max(1, width - labelWidth - sumWidth);
    for (const key of effective) {
      const values = seriesValues(result.trend, key);
      const sum = key === "cost" ? formatCost(result.totals.cost) : formatTokens(values.reduce((a, b) => a + b, 0));
      const bars = trendBar(values, barWidth);
      const line = `${key.padEnd(labelWidth)}${sum.padStart(sumWidth)} ${bars}`;
      lines.push(truncateToWidth(this.theme.normal(line), width));
    }
  }

  private statusLine(): string {
    const scope = scopeLabel(this.scope);
    const time = timeRangeLabel(this.timeRange);
    const series = this.seriesMode === "all" ? "全部" : this.seriesMode === "tokens" ? "Tokens" : "成本";
    return `范围: ${scope} · 时间: ${time} · 系列: ${series} · [p]项目 [g]全局 [s]系列 [t]时间 [q]关闭 [ESC]back`;
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
