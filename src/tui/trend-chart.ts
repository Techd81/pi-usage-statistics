/**
 * Zero-dependency overlaid multi-series ASCII trend chart for the TUI
 * dashboard. Inspired by asciichart: sample → dual-normalize → paint grid
 * → string[]. Token series share one scale; cost is normalized independently.
 * Colors are applied after the plain grid fits `width` (never before).
 * Adjacent samples are joined with Bresenham segments for a continuous line
 * feel (less scatter than isolated glyphs).
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
  /** Plot body height in rows (clamped 3–14). */
  height?: number;
  /** Apply fixed ANSI series colors after layout. Default true. */
  colorize?: boolean;
};

type ScaleKind = "token" | "cost";

type SeriesSpec = {
  legend: string;
  scale: ScaleKind;
  /** Plain glyph used when colorize is off (and as the ink cell). */
  glyph: string;
  /** ANSI SGR open sequence (no reset). */
  ansi: string;
  /** Optional area fill under the line (cache read). */
  fill?: boolean;
  value: (point: TrendPoint) => number;
};

const RESET = "\u001b[0m";

/** Paint order: fill first, cost last so the dashed cost line stays visible. */
const SERIES: readonly SeriesSpec[] = [
  {
    legend: "Cache read",
    scale: "token",
    glyph: "*",
    ansi: "\u001b[35m",
    fill: true,
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

type Cell = { ch: string; series: number | null };

type Sampled = {
  startMs: number[];
  /** Parallel to SERIES entries with scale === "token". */
  tokenSeries: number[][];
  cost: number[];
};

const clampHeight = (height: number | undefined, width: number): number => {
  // Slightly taller on wide terminals for a finer continuous-line plot.
  const fallback = width < 40 ? 5 : width < 60 ? 8 : 11;
  const h = height ?? fallback;
  if (!Number.isFinite(h) || h < 3) return 3;
  return Math.min(14, Math.floor(h));
};

const safeMax = (values: readonly number[]): number => {
  let max = 0;
  for (const v of values) {
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max;
};

/** Map a value onto row index 0 (top/max) … height-1 (bottom/zero). */
const toRow = (value: number, max: number, height: number): number => {
  if (height <= 1) return 0;
  if (max <= 0 || !Number.isFinite(value) || value <= 0) return height - 1;
  const ratio = Math.max(0, Math.min(1, value / max));
  return height - 1 - Math.round(ratio * (height - 1));
};

/**
 * Downsample `points` to exactly `cols` slots by averaging each bucket.
 */
function resample(points: readonly TrendPoint[], cols: number): Sampled {
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
    const n = slice.length || 1;
    startMs.push(slice[0]?.startMs ?? 0);
    let costSum = 0;
    const tokenSums = tokenSpecs.map(() => 0);
    for (const p of slice) {
      costSum += p.cost.amount ?? 0;
      tokenSpecs.forEach((spec, i) => {
        tokenSums[i]! += spec.value(p);
      });
    }
    cost.push(costSum / n);
    tokenSums.forEach((sum, i) => tokenSeries[i]!.push(sum / n));
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

  // Legend: Cost(·$) · Cache write(+) · … — centered; glyph+$ cues dual scale.
  const legendParts = LEGEND_ORDER.map((name) => {
    const spec = SERIES.find((s) => s.legend === name)!;
    const unit = spec.scale === "cost" ? `${spec.glyph}$` : spec.glyph;
    const label = `${name}(${unit})`;
    return colorize ? `${spec.ansi}${label}${RESET}` : label;
  });
  lines.push(centerInWidth(legendParts.join("  "), width));

  const unitsCue = "tokens <- | -> cost($)";
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
  // Drop side scales when they would leave fewer than 4 plot columns.
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
  // Never claim more plot columns than the remaining width (narrow terminals).
  const plotW = Math.max(1, width - leftW - rightW);

  const sampled = resample(trend, plotW);
  const { tokenSeries, cost, startMs } = sampled;

  const grid: Cell[][] = Array.from({ length: height }, () =>
    Array.from({ length: plotW }, () => ({ ch: " ", series: null as number | null })),
  );

  const paintPoint = (row: number, col: number, seriesIdx: number, ch: string): void => {
    if (row < 0 || row >= height || col < 0 || col >= plotW) return;
    grid[row]![col] = { ch, series: seriesIdx };
  };

  /**
   * Bresenham segment so consecutive samples form a continuous run instead of
   * isolated scatter points. Cost stays dashed (every other cell).
   */
  const paintSegment = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    seriesIdx: number,
    glyph: string,
    dashed: boolean,
  ): void => {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    let step = 0;
    for (;;) {
      // Always ink the segment endpoint so a dashed cost run does not drop
      // the final sample column (step would be odd on a 1-wide segment).
      const atEnd = x === x1 && y === y1;
      if (!dashed || step % 2 === 0 || atEnd) {
        paintPoint(y, x, seriesIdx, glyph);
      }
      if (atEnd) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
      step++;
      // Safety: never spin on degenerate input.
      if (step > dx + dy + 2) break;
    }
  };

  const paintLine = (rows: number[], seriesIdx: number, glyph: string, dashed: boolean): void => {
    if (rows.length === 0) return;
    if (rows.length === 1) {
      paintPoint(rows[0]!, 0, seriesIdx, glyph);
      return;
    }
    for (let x = 0; x < rows.length - 1; x++) {
      paintSegment(x, rows[x]!, x + 1, rows[x + 1]!, seriesIdx, glyph, dashed);
    }
  };

  const paintFill = (rows: number[], seriesIdx: number): void => {
    for (let x = 0; x < rows.length; x++) {
      const y = rows[x]!;
      for (let r = y + 1; r < height; r++) {
        if (grid[r]![x]!.series === null) {
          grid[r]![x] = { ch: "░", series: seriesIdx };
        }
      }
    }
  };

  SERIES.forEach((spec, seriesIdx) => {
    let samples: number[];
    if (spec.scale === "cost") {
      samples = cost;
    } else {
      const tokenIdx = SERIES.filter((s) => s.scale === "token").findIndex((s) => s.legend === spec.legend);
      samples = tokenSeries[tokenIdx] ?? [];
    }
    const max = spec.scale === "cost" ? costMax : tokenMax;
    const rows = samples.map((v) => toRow(v, max, height));
    if (spec.fill) paintFill(rows, seriesIdx);
    paintLine(rows, seriesIdx, spec.glyph, spec.scale === "cost");
  });

  for (let r = 0; r < height; r++) {
    let left = "";
    if (leftW > 0) {
      if (r === 0) left = padStartToWidth(truncateToWidth(formatTokenTick(tokenMax), leftW), leftW);
      else if (r === height - 1) left = padStartToWidth(truncateToWidth("0", leftW), leftW);
      else left = " ".repeat(leftW);
    }
    let right = "";
    if (rightW > 0) {
      if (r === 0) right = padStartToWidth(truncateToWidth(formatCostTick(costMax), rightW), rightW);
      else if (r === height - 1) right = padStartToWidth(truncateToWidth("$0", rightW), rightW);
      else right = " ".repeat(rightW);
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

  lines.push(truncateToWidth(buildXAxis(startMs, plotW, leftW, rightW, width), width));
  return lines.map((line) => truncateToWidth(line, width));
}

function buildXAxis(
  startMs: readonly number[],
  plotW: number,
  leftW: number,
  rightW: number,
  width: number,
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

  const first = formatDateTimeCompact(startMs[0]!);
  const last = formatDateTimeCompact(startMs[startMs.length - 1]!);
  place(first, 0, true);

  if (plotW >= 36 && startMs.length >= 3) {
    const mid = Math.floor(startMs.length / 2);
    place(formatDateTimeCompact(startMs[mid]!), Math.max(0, mid - Math.floor(first.length / 2)), false);
  }

  if (plotW >= first.length + last.length + 2) {
    place(last, plotW - last.length, false);
  }

  const left = leftW > 0 ? " ".repeat(leftW) : "";
  const right = rightW > 0 ? " ".repeat(rightW) : "";
  return `${left}${row.join("")}${right}`;
}

/** Public series legend names for tests / callers. */
export const TREND_CHART_SERIES = LEGEND_ORDER;
