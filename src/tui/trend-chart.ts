/**
 * Zero-dependency overlaid multi-series ASCII trend chart for the TUI
 * dashboard. Sample → dual-normalize → scatter paint → string[].
 * Token series share one log-compressed scale (so Cache read cannot crush
 * Input/Output to the baseline); cost is normalized independently on a
 * linear right axis. Only sample glyphs are painted — no connecting lines
 * (connectors clutter multi-series overlays). Colors are applied after the
 * plain grid fits `width` (never before).
 */
import type { TrendPoint } from "../domain";
import {
  centerInWidth,
  displayWidth,
  formatCompactTokens,
  formatDateTimeCompact,
  padStartToWidth,
  truncateToWidth,
} from "./format";

/** Optional paint / sizing knobs for the chart body. */
export type TrendChartOptions = {
  /** Total row budget (display columns). */
  width: number;
  /** Plot body height in rows (clamped 3–18). */
  height?: number;
  /** Apply fixed ANSI series colors after layout. Default true. */
  colorize?: boolean;
  /**
   * Explicit x-axis end label time (ms). Defaults to the last sample's
   * startMs. Pass the filter `toMs` so the right tick matches the title
   * range even when the last bucket start is earlier.
   */
  axisToMs?: number;
  /**
   * Explicit x-axis start label time (ms). Defaults to the first sample.
   * When `openStart` is true, the left tick renders as `~`.
   */
  axisFromMs?: number;
  /** Left x-axis tick is an open start (`~`) — used for「全部」. */
  openStart?: boolean;
  /**
   * Sparse X paint after column-max sampling. Use for「全部」only: dense
   * flat plateaus would otherwise read as solid horizontal bars. Bounded
   * ranges (today/1d/…/1y) must paint every column so activity stays visible.
   */
  sparsePaint?: boolean;
};

type ScaleKind = "token" | "cost";

type SeriesSpec = {
  legend: string;
  scale: ScaleKind;
  /** Plain glyph used at sample columns. */
  glyph: string;
  /** ANSI SGR open sequence (no reset). */
  ansi: string;
  value: (point: TrendPoint) => number;
};

const RESET = "\u001b[0m";

/** Series defs — legend order is LEGEND_ORDER; paint order is handled below. */
const SERIES: readonly SeriesSpec[] = [
  {
    legend: "Cache read",
    scale: "token",
    glyph: "*",
    ansi: "\u001b[35m",
    value: (p) => p.cacheReadTokens,
  },
  {
    legend: "Cache write",
    scale: "token",
    glyph: "+",
    ansi: "\u001b[38;5;208m",
    value: (p) => p.cacheWriteTokens,
  },
  {
    legend: "Input",
    scale: "token",
    glyph: "o",
    ansi: "\u001b[34m",
    value: (p) => p.inputTokens,
  },
  {
    legend: "Output",
    scale: "token",
    glyph: "x",
    ansi: "\u001b[32m",
    value: (p) => p.outputTokens,
  },
  {
    legend: "Cost",
    scale: "cost",
    glyph: "·",
    ansi: "\u001b[31m",
    value: (p) => p.cost.amount ?? 0,
  },
];

/** Legend order matching the product reference (Cost first). */
const LEGEND_ORDER = ["Cost", "Cache write", "Cache read", "Input", "Output"] as const;

type Cell = { ch: string; series: number | null; zero: boolean };

type Sampled = {
  /** Time label per plot column (for mid tick). */
  startMs: number[];
  /** Parallel to SERIES token entries; NaN = no sample in this column. */
  tokenSeries: number[][];
  /** NaN = no sample in this column. */
  cost: number[];
};

const clampHeight = (height: number | undefined, width: number): number => {
  const fallback = width < 40 ? 5 : width < 60 ? 9 : width < 90 ? 12 : 15;
  const h = height ?? fallback;
  if (!Number.isFinite(h) || h < 3) return 3;
  return Math.min(18, Math.floor(h));
};

const safeMax = (values: readonly number[]): number => {
  let max = 0;
  for (const v of values) {
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max;
};

const pointActive = (p: TrendPoint): boolean =>
  p.inputTokens > 0 ||
  p.outputTokens > 0 ||
  p.cacheReadTokens > 0 ||
  p.cacheWriteTokens > 0 ||
  (p.cost.amount ?? 0) > 0;

/**
 * Drop leading / trailing all-zero buckets so「全部」(epoch→now) does not
 * squash real activity into the last few columns. Keeps at least one point.
 */
export function trimTrendEmptyEdges(points: readonly TrendPoint[]): TrendPoint[] {
  if (points.length === 0) return [];
  let lo = 0;
  let hi = points.length - 1;
  while (lo < points.length && !pointActive(points[lo]!)) lo++;
  while (hi > lo && !pointActive(points[hi]!)) hi--;
  if (lo === 0 && hi === points.length - 1) return points as TrendPoint[];
  if (lo >= points.length) return points.slice(0, 1) as TrendPoint[];
  return points.slice(lo, hi + 1);
}

/**
 * Map a value onto row index 0 (top/max) … height-1 (bottom/zero).
 * Token series use log1p compression; cost stays linear on its own max.
 */
const toRow = (value: number, max: number, height: number, mode: "log" | "linear"): number => {
  if (height <= 1) return 0;
  if (max <= 0 || !Number.isFinite(value) || value <= 0) return height - 1;
  let ratio: number;
  if (mode === "log") {
    const denom = Math.log1p(max);
    ratio = denom > 0 ? Math.log1p(value) / denom : 0;
  } else {
    ratio = value / max;
  }
  ratio = Math.max(0, Math.min(1, ratio));
  return height - 1 - Math.round(ratio * (height - 1));
};

const logMidValue = (max: number): number => {
  if (max <= 0) return 0;
  return Math.expm1(Math.log1p(max) / 2);
};

/**
 * Downsample `points` into exactly `cols` columns by max-pooling each slice.
 *
 * Why max (not stride-pick): a 30d/1y window is mostly leading empty buckets.
 * Uniform index stride lands almost all picks in the zero prefix and only the
 * forced last point carries real data → chart looks "all zeros". Column max
 * keeps every time slice, so the active tail still shows peaks while idle
 * slices stay explicit 0 (baseline glyphs).
 */
function columnMaxSample(points: readonly TrendPoint[], cols: number): Sampled {
  const tokenSpecs = SERIES.filter((s) => s.scale === "token");
  const empty: Sampled = {
    startMs: [],
    tokenSeries: tokenSpecs.map(() => []),
    cost: [],
  };
  if (points.length === 0 || cols <= 0) return empty;

  const startMs: number[] = [];
  const cost: number[] = [];
  const tokenSeries = tokenSpecs.map(() => [] as number[]);

  for (let c = 0; c < cols; c++) {
    const from = Math.floor((c * points.length) / cols);
    const to = Math.max(from + 1, Math.floor(((c + 1) * points.length) / cols));
    const slice = points.slice(from, to);
    // Prefer last bucket's start so the rightmost column tracks range end.
    startMs.push(slice[slice.length - 1]?.startMs ?? slice[0]?.startMs ?? 0);

    let costMax = 0;
    const tokenMaxes = tokenSpecs.map(() => 0);
    for (const p of slice) {
      const cAmt = p.cost.amount ?? 0;
      if (cAmt > costMax) costMax = cAmt;
      tokenSpecs.forEach((spec, i) => {
        const v = spec.value(p);
        if (v > tokenMaxes[i]!) tokenMaxes[i] = v;
      });
    }
    cost.push(costMax);
    tokenMaxes.forEach((v, i) => tokenSeries[i]!.push(v));
  }

  return { startMs, tokenSeries, cost };
}

const formatTokenTick = (value: number): string => formatCompactTokens(value);

const formatCostTick = (value: number): string => {
  if (value <= 0) return "$0";
  if (value >= 1) return `$${value.toFixed(1)}`;
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
};

/**
 * Render an overlaid five-series trend chart. Does not include the section
 * title — the dashboard prefixes 「使用趋势」 + date range.
 */
export function renderTrendChart(trend: readonly TrendPoint[], options: TrendChartOptions): string[] {
  const width = Number.isFinite(options.width) && options.width > 0 ? Math.floor(options.width) : 80;
  const height = clampHeight(options.height, width);
  const colorize = options.colorize !== false;

  const lines: string[] = [];

  const legendParts = LEGEND_ORDER.map((name) => {
    const spec = SERIES.find((s) => s.legend === name)!;
    const unit = spec.scale === "cost" ? `${spec.glyph}$` : spec.glyph;
    const label = `${name}(${unit})`;
    return colorize ? `${spec.ansi}${label}${RESET}` : label;
  });
  lines.push(centerInWidth(legendParts.join("  "), width));

  const unitsCue = "tokens (log) <- | -> cost($)";
  if (width >= displayWidth(unitsCue) + 2) {
    lines.push(centerInWidth(unitsCue, width));
  }

  if (trend.length === 0) {
    lines.push(truncateToWidth("(no trend data)", width));
    return lines.map((line) => truncateToWidth(line, width));
  }

  const tokenMax = safeMax(
    trend.flatMap((p) => [p.inputTokens, p.outputTokens, p.cacheReadTokens, p.cacheWriteTokens]),
  );
  const costMax = safeMax(trend.map((p) => p.cost.amount ?? 0));
  const leftLabel = formatTokenTick(tokenMax);
  const rightLabel = formatCostTick(costMax);
  const minPlot = 4;
  let leftW = Math.min(8, Math.max(2, displayWidth(leftLabel) + 1));
  let rightW = 0;
  if (width - leftW - minPlot >= displayWidth(rightLabel) + 1 + 4) {
    rightW = Math.min(8, displayWidth(rightLabel) + 1);
  }
  if (width - leftW - rightW < minPlot) {
    leftW = 0;
    rightW = 0;
  }
  const plotW = Math.max(1, width - leftW - rightW);

  const axisTo = Number.isFinite(options.axisToMs)
    ? options.axisToMs!
    : trend[trend.length - 1]!.startMs;
  const axisFromBound = Number.isFinite(options.axisFromMs)
    ? options.axisFromMs!
    : trend[0]!.startMs;

  const sampled = columnMaxSample(trend, plotW);
  const { tokenSeries, cost, startMs } = sampled;

  const grid: Cell[][] = Array.from({ length: height }, () =>
    Array.from({ length: plotW }, () => ({ ch: " ", series: null as number | null, zero: false })),
  );

  const paintPoint = (row: number, col: number, seriesIdx: number, ch: string, value: number): void => {
    if (row < 0 || row >= height || col < 0 || col >= plotW) return;
    const isZero = value <= 0;
    if (!isZero) {
      const cur = grid[row]![col]!;
      // Don't let Cost erase a token peak when both land on the same cell
      // (common on flat「全部」windows where log tokens and cost both hug the top).
      if (
        cur.series !== null &&
        !cur.zero &&
        SERIES[seriesIdx]!.scale === "cost" &&
        SERIES[cur.series]!.scale === "token"
      ) {
        return;
      }
      grid[row]![col] = { ch, series: seriesIdx, zero: false };
      return;
    }
    // Zeros: keep every series visible. Prefer exact/neighbor empty cells;
    // when the baseline is saturated, interleave by column so +/o/x/· all show.
    const tryCol = (c: number, allowInterleave: boolean): boolean => {
      if (c < 0 || c >= plotW) return false;
      const cur = grid[row]![c]!;
      if (cur.series !== null && !cur.zero) return false;
      if (cur.series !== null && cur.zero && cur.series !== seriesIdx) {
        if (!allowInterleave || c % SERIES.length !== seriesIdx) return false;
      }
      grid[row]![c] = { ch, series: seriesIdx, zero: true };
      return true;
    };
    if (tryCol(col, false)) return;
    for (let d = 1; d <= 4; d++) {
      if (tryCol(col + d, false) || tryCol(col - d, false)) return;
    }
    tryCol(col, true);
  };

  /** Paint finite samples; `zerosOnly` selects baseline zeros vs peaks. */
  const paintScatter = (
    rows: number[],
    values: readonly number[],
    seriesIdx: number,
    glyph: string,
    zerosOnly: boolean,
  ): void => {
    // Sparse X only for non-zero peaks on「全部」. Zeros always paint every
    // column — otherwise Cache write=0 / idle buckets vanish from the baseline.
    const sparsePeaks = options.sparsePaint === true && !zerosOnly;
    const stride = sparsePeaks ? Math.max(3, Math.ceil(plotW / 16)) : 1;
    const n = values.length;
    for (let x = 0; x < n; x++) {
      const value = values[x]!;
      if (!Number.isFinite(value)) continue;
      if (zerosOnly ? value > 0 : value <= 0) continue;
      if (sparsePeaks && x !== 0 && x !== n - 1 && x % stride !== 0) continue;
      paintPoint(rows[x]!, x, seriesIdx, glyph, value);
    }
  };

  // Pass 1: non-zero peaks. Pass 2: zeros (with neighbor spill so Cost/Cache
  // write/Input/Output zeros are not buried under each other).
  const paintAll = (zerosOnly: boolean): void => {
    SERIES.forEach((spec, seriesIdx) => {
      let samples: number[];
      if (spec.scale === "cost") {
        samples = cost;
      } else {
        const tokenIdx = SERIES.filter((s) => s.scale === "token").findIndex((s) => s.legend === spec.legend);
        samples = tokenSeries[tokenIdx] ?? [];
      }
      const max = spec.scale === "cost" ? costMax : tokenMax;
      const mode = spec.scale === "cost" ? "linear" : "log";
      const rows = samples.map((v) => (Number.isFinite(v) ? toRow(v, max, height, mode) : -1));
      paintScatter(rows, samples, seriesIdx, spec.glyph, zerosOnly);
    });
  };
  paintAll(false);
  paintAll(true);

  const midRow = Math.floor((height - 1) / 2);
  const tokenMid = logMidValue(tokenMax);
  const costMid = costMax / 2;

  for (let r = 0; r < height; r++) {
    let left = "";
    if (leftW > 0) {
      if (r === 0) left = padStartToWidth(truncateToWidth(formatTokenTick(tokenMax), leftW), leftW);
      else if (r === height - 1) left = padStartToWidth(truncateToWidth("0", leftW), leftW);
      else if (r === midRow && height >= 7 && tokenMax > 0) {
        left = padStartToWidth(truncateToWidth(formatTokenTick(tokenMid), leftW), leftW);
      } else left = " ".repeat(leftW);
    }
    let right = "";
    if (rightW > 0) {
      if (r === 0) right = padStartToWidth(truncateToWidth(formatCostTick(costMax), rightW), rightW);
      else if (r === height - 1) right = padStartToWidth(truncateToWidth("$0", rightW), rightW);
      else if (r === midRow && height >= 7 && costMax > 0) {
        right = padStartToWidth(truncateToWidth(formatCostTick(costMid), rightW), rightW);
      } else right = " ".repeat(rightW);
    }

    let plot = "";
    for (let c = 0; c < plotW; c++) {
      const cell = grid[r]![c]!;
      if (colorize && cell.series !== null) {
        plot += `${SERIES[cell.series]!.ansi}${cell.ch}${RESET}`;
      } else {
        plot += cell.ch;
      }
    }
    lines.push(truncateToWidth(`${left}${plot}${right}`, width));
  }

  // Time baseline — a dedicated `─` row under the plot so Cost/series glyphs
  // on y=0 are not mistaken for the axis itself.
  {
    const left = leftW > 0 ? " ".repeat(leftW) : "";
    const right = rightW > 0 ? " ".repeat(rightW) : "";
    lines.push(truncateToWidth(`${left}${"─".repeat(plotW)}${right}`, width));
  }

  const axisFrom =
    options.openStart === true
      ? null
      : axisFromBound;

  lines.push(truncateToWidth(buildXAxis(startMs, plotW, leftW, rightW, width, axisFrom, axisTo), width));
  return lines.map((line) => truncateToWidth(line, width));
}

function buildXAxis(
  startMs: readonly number[],
  plotW: number,
  leftW: number,
  rightW: number,
  width: number,
  axisFrom: number | null,
  axisTo: number,
): string {
  if (startMs.length === 0 || plotW <= 0) {
    return "".padEnd(Math.max(0, width), " ");
  }

  const row: string[] = Array.from({ length: plotW }, () => " ");
  const place = (text: string, at: number, force: boolean): void => {
    const start = Math.max(0, Math.min(plotW - text.length, at));
    if (!force) {
      for (let i = 0; i < text.length; i++) {
        if (row[start + i] !== " ") return;
      }
    }
    for (let i = 0; i < text.length && start + i < plotW; i++) {
      row[start + i] = text[i]!;
    }
  };

  const first = axisFrom === null ? "~" : formatDateTimeCompact(axisFrom);
  const last = formatDateTimeCompact(axisTo);
  place(first, 0, true);

  if (plotW >= 36 && startMs.length >= 3) {
    const mid = Math.floor(startMs.length / 2);
    place(formatDateTimeCompact(startMs[mid]!), Math.max(0, mid - Math.floor(first.length / 2)), false);
  }

  // Always force the end tick so it cannot be dropped by a mid-label collision
  // (that bug made「全部」bottom axis stop months before the title end).
  if (plotW >= first.length + last.length + 1) {
    place(last, plotW - last.length, true);
  }

  const left = leftW > 0 ? " ".repeat(leftW) : "";
  const right = rightW > 0 ? " ".repeat(rightW) : "";
  return `${left}${row.join("")}${right}`;
}

/** Public series legend names for tests / callers. */
export const TREND_CHART_SERIES = LEGEND_ORDER;
