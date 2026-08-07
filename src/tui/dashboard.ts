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
 *   Cost summary (with icons), five metric slots, and the Usage trend chart
 *   below; `[m]` switches to a full-width five-column per-model table
 *   (Model / Requests / Tokens / Total cost / Avg cost) with row separators.
 * - Outer Unicode rectangular frame wraps the entire `render()` output when
 *   width ≥ 8; inner layout uses `width - 2`.
 * - Trend: overlaid five-series continuous ASCII chart (Cost / Cache write /
 *   Cache read / Input / Output — no total).
 *
 * The component satisfies Pi's `Component` structural interface
 * (`render(width): string[]`, `handleInput?`, `invalidate()`) with zero
 * runtime dependency on `pi-tui`.
 */
import type { UsageFilters, UsageQueryResult } from "../domain";
import { DEFAULT_BUCKET_MS } from "../domain";
import type { UsageStore } from "../storage";
import {
  centerInWidth,
  displayWidth,
  formatCompactTokens,
  formatCost,
  formatDateRange,
  formatHitRate,
  formatTokens,
  forceWidth,
  frameLines,
  hitRateBar,
  padStartToWidth,
  padToWidth,
  scopeLabel,
  timeRangeLabel,
  truncateToWidth,
} from "./format";
import { renderTrendChart } from "./trend-chart";
import { renderTitleBanner } from "./title-banner";

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

const KEY_ESC = "\u001b";
const KEY_ESC_NAME = "escape";

/** Wide layout uses a side-by-side hero/summary + five metric slots + emoji icons. */
const WIDE_MIN_WIDTH = 60;

/** Minimum outer width that can host a Unicode rectangular frame. */
const FRAME_MIN_WIDTH = 8;

type IconPair = { emoji: string; symbol: string };

const ICONS = {
  totalTokens: { emoji: "📚", symbol: "#" },
  requests: { emoji: "📨", symbol: ">" },
  cost: { emoji: "💰", symbol: "$" },
  input: { emoji: "📥", symbol: ">" },
  output: { emoji: "📤", symbol: "<" },
  cacheWrite: { emoji: "💾", symbol: "W" },
  cacheRead: { emoji: "📖", symbol: "R" },
  cacheHit: { emoji: "⚡", symbol: "%" },
  trend: { emoji: "📈", symbol: "~" },
  model: { emoji: "🤖", symbol: "M" },
} as const satisfies Record<string, IconPair>;

const iconFor = (pair: IconPair, wide: boolean): string => (wide ? pair.emoji : pair.symbol);

const withIcon = (pair: IconPair, label: string, wide: boolean): string => `${iconFor(pair, wide)} ${label}`;

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
    const framed = w >= FRAME_MIN_WIDTH;
    const inner = framed ? w - 2 : w;
    // Icon / layout density follows the outer terminal width so a 60-col
    // frame (inner 58) still uses the wide emoji layout.
    const wide = w >= WIDE_MIN_WIDTH;
    const lines: string[] = [];

    if (this.state.kind === "loading") {
      lines.push(this.theme.muted("Loading usage data…"));
    } else if (this.state.kind === "error") {
      lines.push(this.theme.error("⚠ Usage data unavailable"));
      lines.push(this.theme.muted(truncateToWidth(this.state.message, inner)));
    } else {
      const result = this.state.result;
      if (this.viewMode === "models") {
        this.renderModelsView(lines, result, inner, wide);
      } else {
        if (result.totals.requestCount === 0 && result.totals.totalTokens === 0) {
          lines.push(this.theme.normal("No usage data in the selected range."));
        }
        this.renderMainView(lines, result, inner, wide);
      }
    }

    lines.push(this.theme.muted(truncateToWidth(this.statusLine(), inner)));
    const capped = lines.map((line) => truncateToWidth(line, inner));
    return framed ? frameLines(capped, w) : capped;
  }

  /** Default main view: title banner + hero + metric slots + usage trend. */
  private renderMainView(lines: string[], result: UsageQueryResult, width: number, wide: boolean): void {
    const banner = renderTitleBanner(width).map((line) => this.theme.selected(line));
    lines.push(...banner);
    if (banner.length > 0) lines.push("");
    if (!wide) {
      this.renderMainNarrow(lines, result, width);
    } else {
      this.renderMainWide(lines, result, width);
    }
    this.renderTrend(lines, result, width, wide);
  }

  /** Wide: hero left, Requests/Cost right, five equal metric slots below. */
  private renderMainWide(lines: string[], result: UsageQueryResult, width: number): void {
    const totals = result.totals;
    const wide = true;
    const heroLabel = withIcon(ICONS.totalTokens, "Total tokens", wide);
    const heroValue = formatTokens(totals.totalTokens);
    const heroSub = `~ ${formatCompactTokens(totals.totalTokens)}`;
    const reqLabel = withIcon(ICONS.requests, "Requests", wide);
    const reqValue = formatTokens(totals.requestCount);
    const costLabel = withIcon(ICONS.cost, "Cost", wide);
    const costValue = formatCost(totals.cost);

    const rightReqPlain = `${reqLabel}  ${reqValue}`;
    const rightCostPlain = `${costLabel}  ${costValue}`;
    const rightW = Math.max(displayWidth(rightReqPlain), displayWidth(rightCostPlain), 12);
    const leftW = Math.max(0, width - rightW - 1);

    // Budget plain-text columns first; apply color only after truncation.
    const leftLabel = padToWidth(truncateToWidth(heroLabel, leftW), leftW);
    const rightReqCell = padStartToWidth(truncateToWidth(rightReqPlain, rightW), rightW);
    lines.push(`${this.theme.muted(leftLabel)} ${this.theme.normal(rightReqCell)}`);

    // Color only the numeric value (not the pad spaces) so theme wrappers /
    // ANSI never inflate the plain-text column budget.
    const heroTrunc = truncateToWidth(heroValue, leftW);
    const leftValue = `${this.theme.selected(heroTrunc)}${" ".repeat(Math.max(0, leftW - displayWidth(heroTrunc)))}`;
    lines.push(`${leftValue} ${this.colorCostCell(costLabel, costValue, rightW)}`);

    const leftSub = padToWidth(truncateToWidth(heroSub, leftW), leftW);
    const rightBlank = " ".repeat(rightW);
    lines.push(`${this.theme.muted(leftSub)} ${rightBlank}`);

    lines.push(...this.metricSlotRows(result, width, wide));
  }

  /**
   * Right-align Cost label + emphasized value within `rightW` columns.
   * Color is applied after the plain-text budget is known.
   */
  private colorCostCell(costLabel: string, costValue: string, rightW: number): string {
    const gap = "  ";
    const valueBudget = Math.max(0, rightW - displayWidth(costLabel) - displayWidth(gap));
    const valueTrunc = truncateToWidth(costValue, valueBudget);
    const plain = `${costLabel}${gap}${valueTrunc}`;
    const pad = Math.max(0, rightW - displayWidth(plain));
    return `${" ".repeat(pad)}${this.theme.muted(costLabel)}${gap}${this.theme.selected(valueTrunc)}`;
  }

  /** Narrow: vertical stack — hero → Requests/Cost → metrics → (trend outside). */
  private renderMainNarrow(lines: string[], result: UsageQueryResult, width: number): void {
    const totals = result.totals;
    const wide = false;
    lines.push(this.theme.muted(truncateToWidth(withIcon(ICONS.totalTokens, "Total tokens", wide), width)));
    lines.push(this.theme.selected(truncateToWidth(formatTokens(totals.totalTokens), width)));
    lines.push(this.theme.muted(truncateToWidth(`~ ${formatCompactTokens(totals.totalTokens)}`, width)));
    lines.push(
      this.theme.normal(
        truncateToWidth(`${withIcon(ICONS.requests, "Requests", wide)}  ${formatTokens(totals.requestCount)}`, width),
      ),
    );
    const costLabel = withIcon(ICONS.cost, "Cost", wide);
    const costValue = formatCost(totals.cost);
    lines.push(this.colorCostCell(costLabel, costValue, width));

    for (const slot of [
      { icon: ICONS.input, label: "Input", value: formatTokens(totals.inputTokens), emphasize: false },
      { icon: ICONS.output, label: "Output", value: formatTokens(totals.outputTokens), emphasize: false },
      { icon: ICONS.cacheWrite, label: "Cache write", value: formatTokens(totals.cacheWriteTokens), emphasize: false },
      { icon: ICONS.cacheRead, label: "Cache read", value: formatTokens(totals.cacheReadTokens), emphasize: false },
    ] as const) {
      const row = `${withIcon(slot.icon, slot.label, wide)}  ${slot.value}`;
      lines.push(this.theme.normal(truncateToWidth(row, width)));
    }
    const hitPct = formatHitRate(totals.cacheHitRate);
    const hitLabel = withIcon(ICONS.cacheHit, "Cache hit", wide);
    const hitPrefixPlain = `${hitLabel}  ${hitPct} `;
    const barW = Math.max(0, width - displayWidth(hitPrefixPlain));
    const bar = hitRateBar(totals.cacheHitRate, barW);
    const hitPrefix = `${this.theme.muted(hitLabel)}  ${this.theme.selected(hitPct)} `;
    lines.push(truncateToWidth(`${hitPrefix}${this.theme.normal(bar)}`.trimEnd(), width));
  }

  /**
   * Five equal-width metric slots on one or two rows. Cache hit includes a
   * percent + block progress bar; column widths differ by at most 1.
   * Cache hit % uses `theme.selected` for emphasis.
   */
  private metricSlotRows(result: UsageQueryResult, width: number, wide: boolean): string[] {
    const slots = 5;
    const base = Math.floor(width / slots);
    const rem = width - base * slots;
    const widths = Array.from({ length: slots }, (_, i) => base + (i < rem ? 1 : 0));

    const totals = result.totals;
    const labels = [
      withIcon(ICONS.input, "Input", wide),
      withIcon(ICONS.output, "Output", wide),
      withIcon(ICONS.cacheWrite, "Cache write", wide),
      withIcon(ICONS.cacheRead, "Cache read", wide),
      withIcon(ICONS.cacheHit, "Cache hit", wide),
    ];
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
      if (i < 4) {
        const cell = padToWidth(truncateToWidth(value, w), w);
        return this.theme.normal(cell);
      }
      // Cache hit: emphasized percent + muted bar in the remaining slot width.
      const pct = value;
      const gap = " ";
      const prefixW = displayWidth(pct) + displayWidth(gap);
      const barW = Math.max(0, w - prefixW);
      const bar = hitRateBar(totals.cacheHitRate, barW);
      const colored = `${this.theme.selected(truncateToWidth(pct, prefixW))}${gap}${this.theme.normal(bar)}`;
      const plainBudget = padToWidth(truncateToWidth(`${pct}${gap}${bar}`, w), w);
      // If colored display width drifts, fall back to truncated colored string.
      if (displayWidth(colored) <= w) {
        return colored + " ".repeat(Math.max(0, w - displayWidth(colored)));
      }
      return forceWidth(colored, w) || this.theme.normal(plainBudget);
    });
    return [forceWidth(this.theme.muted(labelRow), width), forceWidth(valueCells.join(""), width)];
  }

  /** Full-width five-column per-model table with horizontal separators. */
  private renderModelsView(lines: string[], result: UsageQueryResult, width: number, wide: boolean): void {
    const modelRows = this.modelLines(result, width, true, wide);
    if (modelRows.length === 0) {
      lines.push(this.theme.muted(truncateToWidth("No models in the selected range.", width)));
      return;
    }
    for (const row of modelRows) {
      lines.push(this.theme.normal(row));
    }
  }

  /**
   * Per-model table: Model / Requests / Tokens / Total cost / Avg cost.
   * Columns separated by │; model left-aligned; numeric columns right-aligned.
   */
  private modelLines(result: UsageQueryResult, width: number, withHeader: boolean, wide: boolean): string[] {
    const models = result.byModel;
    const lines: string[] = [];
    if (models.length === 0) return lines;

    const modelHeader = withIcon(ICONS.model, "Model", wide);
    const reqHeader = withIcon(ICONS.requests, "Requests", wide);
    const tokHeader = withIcon(ICONS.totalTokens, "Tokens", wide);
    const totalHeader = withIcon(ICONS.cost, "Total cost", wide);
    const avgHeader = "Avg cost";
    const colSep = "│";
    const sepCount = 4;

    const reqMax = Math.max(
      displayWidth(reqHeader),
      ...models.map((entry) => displayWidth(formatTokens(entry.requestCount))),
    );
    const tokMax = Math.max(
      displayWidth(tokHeader),
      ...models.map((entry) => displayWidth(formatTokens(entry.totalTokens))),
    );
    const costMax = Math.max(
      displayWidth(totalHeader),
      ...models.map((entry) => displayWidth(formatCost(entry.cost))),
    );
    const avgMax = Math.max(
      displayWidth(avgHeader),
      ...models.map((entry) => displayWidth(formatCost(entry.avgCost))),
    );
    const reserved = reqMax + tokMax + costMax + avgMax + displayWidth(colSep) * sepCount;
    const longestName = Math.max(displayWidth(modelHeader), ...models.map((entry) => displayWidth(entry.model)));
    const nameMax = Math.max(6, Math.min(longestName, Math.max(6, width - reserved)));

    const rule =
      "─".repeat(nameMax) +
      "┼" +
      "─".repeat(reqMax) +
      "┼" +
      "─".repeat(tokMax) +
      "┼" +
      "─".repeat(costMax) +
      "┼" +
      "─".repeat(avgMax);
    const separator = truncateToWidth(rule, width);

    const formatRow = (name: string, req: string, tok: string, total: string, avg: string): string =>
      truncateToWidth(
        padToWidth(name, nameMax) +
          colSep +
          padStartToWidth(req, reqMax) +
          colSep +
          padStartToWidth(tok, tokMax) +
          colSep +
          padStartToWidth(total, costMax) +
          colSep +
          padStartToWidth(avg, avgMax),
        width,
      );

    if (withHeader) {
      lines.push(formatRow(truncateToWidth(modelHeader, nameMax), reqHeader, tokHeader, totalHeader, avgHeader));
      lines.push(separator);
    }
    for (let i = 0; i < models.length; i++) {
      const entry = models[i]!;
      const name = truncateToWidth(entry.model, nameMax);
      lines.push(
        formatRow(
          name,
          formatTokens(entry.requestCount),
          formatTokens(entry.totalTokens),
          formatCost(entry.cost),
          formatCost(entry.avgCost),
        ),
      );
      if (i < models.length - 1) lines.push(separator);
    }
    return lines;
  }

  /**
   * 「使用趋势」 + date range, then the overlaid five-series chart.
   * Chart colors use fixed ANSI (theme has no per-series palette); the
   * outer `render` truncate/frame pass keeps every row within `width`.
   */
  private renderTrend(lines: string[], result: UsageQueryResult, width: number, wide: boolean): void {
    const fromMs =
      result.filters.fromMs > 0
        ? result.filters.fromMs
        : (result.trend[0]?.startMs ?? result.filters.fromMs);
    const toMs =
      result.filters.toMs < Number.MAX_SAFE_INTEGER
        ? result.filters.toMs
        : (result.trend[result.trend.length - 1]?.startMs ?? result.filters.toMs);
    const range = formatDateRange(fromMs, toMs);
    const titlePlain = `${withIcon(ICONS.trend, "使用趋势", wide)}  ${range}`;
    lines.push(this.theme.selected(centerInWidth(titlePlain, width)));
    // Noop theme in tests: skip ANSI so structural asserts stay stable.
    const colorize = this.theme !== noopTheme;
    for (const row of renderTrendChart(result.trend, { width, colorize })) {
      lines.push(row);
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
