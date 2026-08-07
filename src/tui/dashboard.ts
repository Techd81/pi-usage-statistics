/**
 * TUI dashboard surface (design §6): a `ctx.ui.custom()` embedded component
 * rendering the shared `UsageQueryResult` with terminal-safe formatting.
 *
 * - `/pi-usage-statistics` command opens this embedded dashboard; scope
 *   defaults to `global` and can be switched to `project` (records of the
 *   current cwd).
 * - Keys: `p`/`g` scope switch, `m` models-view toggle, `t` time-range
 *   cycle (当天 → 1d → 7d → 14d → 30d → 1year → 全部), `Esc` back (models → main first,
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
  formatTokensZhCompact,
  formatCost,
  formatDateRange,
  formatHitRate,
  formatTokens,
  forceWidth,
  FRAME_RIGHT_GUTTER,
  frameLines,
  hitRateBar,
  scopeLabel,
  timeRangeLabel,
  truncateToWidth,
} from "./format";
import { renderTrendChart, trimTrendEmptyEdges } from "./trend-chart";
import { renderTitleBanner } from "./title-banner";

/** Query scope: all sessions (global) or only the current working directory. */
export type Scope = "global" | "project";

/** Relative time window applied via `filters.fromMs`. */
export type TimeRange = "today" | "1d" | "7d" | "14d" | "30d" | "1y" | "all";

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
    case "1d":
      return now - DAY_MS;
    case "7d":
      return now - 7 * DAY_MS;
    case "14d":
      return now - 14 * DAY_MS;
    case "30d":
      return now - 30 * DAY_MS;
    case "1y":
      return now - 365 * DAY_MS;
    case "all":
      return 0;
  }
};

/** `[t]` cycles: 当天 → 1d → 7d → 14d → 30d → 1year → 全部 → … */
const NEXT_RANGE: Record<TimeRange, TimeRange> = {
  today: "1d",
  "1d": "7d",
  "7d": "14d",
  "14d": "30d",
  "30d": "1y",
  "1y": "all",
  all: "today",
};

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
    // ││ = 2 cols; frameLines also keeps FRAME_RIGHT_GUTTER ASCII spaces
    // before the right border to absorb ambiguous-width surprises.
    const inner = framed ? w - 2 - FRAME_RIGHT_GUTTER : w;
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

    lines.push(this.theme.muted(centerInWidth(truncateToWidth(this.statusLine(), inner), inner)));
    const capped = lines.map((line) => truncateToWidth(line, inner));
    return framed ? frameLines(capped, w) : capped;
  }

  /** Default main view: title banner + hero + metric slots + usage trend. */
  private renderMainView(lines: string[], result: UsageQueryResult, width: number, wide: boolean): void {
    const colorize = this.theme !== noopTheme;
    const banner = renderTitleBanner(width, { colorize });
    lines.push(...banner);
    if (banner.length > 0) lines.push("");
    if (!wide) {
      this.renderMainNarrow(lines, result, width);
    } else {
      this.renderMainWide(lines, result, width);
    }
    // One blank before the trend block — keeps metrics / title from stacking flush.
    lines.push("");
    this.renderTrend(lines, result, width, wide);
  }

  /** Wide: one summary row (Total tokens / Requests / Cost) + five metric slots. */
  private renderMainWide(lines: string[], result: UsageQueryResult, width: number): void {
    const totals = result.totals;
    const wide = true;
    const cells = [
      {
        plain: `${withIcon(ICONS.totalTokens, "Total tokens", wide)}  ${formatTokens(totals.totalTokens)} （${formatTokensZhCompact(totals.totalTokens)}）`,
        emphasize: true,
      },
      {
        plain: `${withIcon(ICONS.requests, "Requests", wide)}  ${formatTokens(totals.requestCount)}`,
        emphasize: false,
      },
      {
        plain: `${withIcon(ICONS.cost, "Cost", wide)}  ${formatCost(totals.cost)}`,
        emphasize: true,
      },
    ];
    lines.push(this.equalSlotRow(cells, width));
    lines.push("");
    lines.push(...this.metricSlotRows(result, width, wide));
  }

  /**
   * Split `width` into N equal slots (diff ≤ 1) and render one cell per slot.
   * Emphasized cells use `theme.selected` on the truncated plain text.
   */
  private equalSlotRow(
    cells: readonly { plain: string; emphasize: boolean }[],
    width: number,
  ): string {
    const n = cells.length;
    if (n === 0) return forceWidth("", width);
    const base = Math.floor(width / n);
    const rem = width - base * n;
    const parts = cells.map((cell, i) => {
      const w = base + (i < rem ? 1 : 0);
      const clipped = centerInWidth(truncateToWidth(cell.plain, w), w);
      return cell.emphasize ? this.theme.selected(clipped) : this.theme.normal(clipped);
    });
    return forceWidth(parts.join(""), width);
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
    lines.push(
      this.theme.selected(
        truncateToWidth(
          `${formatTokens(totals.totalTokens)} （${formatTokensZhCompact(totals.totalTokens)}）`,
          width,
        ),
      ),
    );
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
   * Five equal-width metric slots. Order keeps the Cache-hit progress bar off
   * the rightmost column (Windows Terminal ambiguous-width / border punch).
   * Cache hit % uses `theme.selected` for emphasis.
   */
  private metricSlotRows(result: UsageQueryResult, width: number, wide: boolean): string[] {
    const slots = 5;
    const base = Math.floor(width / slots);
    const rem = width - base * slots;
    const widths = Array.from({ length: slots }, (_, i) => base + (i < rem ? 1 : 0));

    const totals = result.totals;
    // Percent on the label row; value row is a full-slot Braille gauge.
    const hitPct = formatHitRate(totals.cacheHitRate);
    const specs: { label: string; kind: "plain" | "hit"; value: string }[] = [
      { label: withIcon(ICONS.input, "Input", wide), kind: "plain", value: formatTokens(totals.inputTokens) },
      { label: withIcon(ICONS.output, "Output", wide), kind: "plain", value: formatTokens(totals.outputTokens) },
      {
        label: `${withIcon(ICONS.cacheHit, "Cache hit", wide)} ${hitPct}`,
        kind: "hit",
        value: hitPct,
      },
      { label: withIcon(ICONS.cacheRead, "Cache read", wide), kind: "plain", value: formatTokens(totals.cacheReadTokens) },
      { label: withIcon(ICONS.cacheWrite, "Cache write", wide), kind: "plain", value: formatTokens(totals.cacheWriteTokens) },
    ];

    const labelRow = specs
      .map((spec, i) => centerInWidth(truncateToWidth(spec.label, widths[i]!), widths[i]!))
      .join("");

    const valueCells = specs.map((spec, i) => {
      const w = widths[i]!;
      if (spec.kind === "plain") {
        return this.theme.normal(centerInWidth(truncateToWidth(spec.value, w), w));
      }
      const bar = hitRateBar(totals.cacheHitRate, w);
      return this.theme.selected(centerInWidth(truncateToWidth(bar, w), w));
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
   * Columns separated by │; every cell centered in its column.
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
    // Give every leftover column to the model name so the table spans full width
    // instead of hugging content and leaving a blank right pane.
    const nameMax = Math.max(6, width - reserved);

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
    const separator = forceWidth(truncateToWidth(rule, width), width);

    const formatRow = (name: string, req: string, tok: string, total: string, avg: string): string =>
      forceWidth(
        centerInWidth(truncateToWidth(name, nameMax), nameMax) +
          colSep +
          centerInWidth(truncateToWidth(req, reqMax), reqMax) +
          colSep +
          centerInWidth(truncateToWidth(tok, tokMax), tokMax) +
          colSep +
          centerInWidth(truncateToWidth(total, costMax), costMax) +
          colSep +
          centerInWidth(truncateToWidth(avg, avgMax), avgMax),
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
    const isAllTime = !(result.filters.fromMs > 0);
    const filterFrom = result.filters.fromMs;
    const toMs =
      result.filters.toMs < Number.MAX_SAFE_INTEGER
        ? result.filters.toMs
        : (result.trend[result.trend.length - 1]?.startMs ?? result.filters.toMs);
    // 「全部」: domain already starts buckets at first token; trim is a safety net.
    // Bounded windows keep the full filter span — idle days stay on-axis.
    const trend = isAllTime ? trimTrendEmptyEdges(result.trend) : result.trend;
    // Title/axis: first-token time → now (never epoch / ～ once data exists).
    const dataFromMs = trend[0]?.startMs ?? 0;
    const fromMs = isAllTime ? dataFromMs : filterFrom;
    const openStart = !(fromMs > 0);
    const range = formatDateRange(fromMs, toMs);
    const titlePlain = `${withIcon(ICONS.trend, "使用趋势", wide)}  ${range}`;
    lines.push(this.theme.selected(centerInWidth(titlePlain, width)));
    const colorize = this.theme !== noopTheme;
    const chartOpts = {
      width,
      colorize,
      openStart,
      // Sparse X only for「全部」— never for 当天/1d/…/1y.
      sparsePaint: isAllTime,
      axisToMs: toMs,
      ...(openStart ? {} : { axisFromMs: fromMs }),
    };
    for (const row of renderTrendChart(trend, chartOpts)) {
      lines.push(row);
    }
  }

  private statusLine(): string {
    const scope = scopeLabel(this.scope);
    const time = timeRangeLabel(this.timeRange);
    // 项目视图显示具体路径，用户可确认过滤范围（R2）；空 projectCwd 回退旧文案。
    const scopeDetail = this.scope === "project" && this.deps.projectCwd !== "" ? ` (${this.deps.projectCwd})` : "";
    // [m]模型（2 列）而非 models（6 列）：80 列窄终端下含项目路径仍能完整显示提示行。
    return `范围: ${scope}${scopeDetail} · 时间: ${time} · [p]项目 [g]全局 [m]模型 [t]时间 [ESC]back`;
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
