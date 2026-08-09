/**
 * Terminal-safe formatting for the TUI surface. Mirrors the Web dashboard's
 * number/cost/percent conventions (spec web-and-tui.md: shared formatting
 * rules) so both surfaces present identical values. No ANSI codes are
 * generated here — colors are applied by the component after truncation.
 *
 * Width measurement delegates to pi-tui's `visibleWidth` — the SAME
 * measurement pi uses when it validates custom component output
 * (TuiMainScreen.doRender). Hand-rolled width tables drifted from it
 * (e.g. ⚡ U+26A1 counted narrow) and made a rendered line exceed the
 * terminal width, crashing pi with "Rendered line N exceeds terminal width".
 * Never re-implement character-width logic here.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CostDisplay } from "../domain";

const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

/** Token counts with zh-CN grouping, matching the Web surface. */
export function formatTokens(value: number): string {
  return numberFormat.format(value);
}

/**
 * Cost follows the Web convention: fixed 4 decimals, `--` when unavailable.
 * Provenance suffixes (`（估算）` / `（混合）`) are intentionally omitted so
 * the dashboard reads cleanly; estimation status is still visible via the
 * tooltip/status line where available.
 */
export function formatCost(cost: CostDisplay): string {
  if (cost.amount === null) return "--";
  return `$${cost.amount.toFixed(4)}`;
}

/** Cache-hit rate; a null rate (zero denominator) renders as `--`. */
export function formatHitRate(rate: number | null): string {
  return rate === null ? "--" : `${rate.toFixed(1)}%`;
}

/**
 * Compact magnitude for chart axis ticks (e.g. `2.57B`, `1.2M`, `3.4K`).
 * Non-finite / negative inputs collapse to `0`.
 */
export function formatCompactTokens(value: number): string {
  const n = Number.isFinite(value) && value > 0 ? value : 0;
  const trim = (x: number): string => {
    const s = x.toFixed(2);
    return s.replace(/\.?0+$/, "");
  };
  if (n >= 1_000_000_000) return `${trim(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}K`;
  return String(Math.floor(n));
}

/**
 * Chinese compact magnitude for the Total tokens hint:
 * 0 → `0`（0 个 token 不是 0 万）；
 * ≥ 1亿 → `x.xx亿`；otherwise → `x.xx万` (including values under 1万).
 */
export function formatTokensZhCompact(value: number): string {
  const n = Number.isFinite(value) && value > 0 ? value : 0;
  if (n === 0) return "0";
  const trim = (x: number): string => {
    const s = x.toFixed(2);
    return s.replace(/\.?0+$/, "");
  };
  if (n >= 100_000_000) return `${trim(n / 100_000_000)}亿`;
  return `${trim(n / 10_000)}万`;
}

/**
 * Braille progress-bar palettes by overall rate. Each glyph is 1 column on
 * typical terminals (unlike ambiguous █░), so the outer frame stays intact.
 * Higher stages use denser “full” cells and darker empty tracks.
 */
type BraillePalette = { empty: string; full: string; ramp: readonly string[] };

function braillePalette(rate: number): BraillePalette {
  // 100%: solid blaze
  if (rate >= 100) {
    return { empty: "⣿", full: "⣿", ramp: ["⣿"] };
  }
  // 75–99%: dense fire — nearly solid ⣿, soft ember track
  if (rate >= 75) {
    return { empty: "⣀", full: "⣿", ramp: ["⣄", "⣤", "⣦", "⣶", "⣷", "⣿", "⣿", "⣿"] };
  }
  // 50–74%: strong tide — heavy partials
  if (rate >= 50) {
    return { empty: "⡀", full: "⣷", ramp: ["⡄", "⡆", "⡇", "⣇", "⣧", "⣷", "⣿", "⣿"] };
  }
  // 25–49%: rising mist — mid density
  if (rate >= 25) {
    return { empty: "⠀", full: "⡇", ramp: ["⠂", "⠄", "⠤", "⠴", "⠶", "⠷", "⠿", "⣿"] };
  }
  // 0–24%: faint spark — lightest track and soft dots
  return { empty: "⠀", full: "⠉", ramp: ["⠁", "⠂", "⠄", "⠈", "⠉", "⠊", "⠋", "⠛"] };
}

/**
 * Cache-hit progress bar (Braille, not ASCII / not █░).
 *
 * Looks change with the overall rate band (spark → mist → tide → fire → solid),
 * and each cell has a smooth 8-step partial fill. Braille is counted as 1
 * column — safe beside the outer frame on Windows Terminal.
 */
export function hitRateBar(rate: number | null, width: number): string {
  const w = Number.isFinite(width) ? Math.floor(width) : 0;
  if (rate === null || w <= 0) return "";
  const clamped = Math.max(0, Math.min(100, rate));
  const { empty, full, ramp } = braillePalette(clamped);
  if (clamped <= 0) return empty.repeat(w);

  const exact = (clamped / 100) * w;
  const fullCount = Math.min(w, Math.floor(exact));
  const frac = exact - fullCount;
  const cells: string[] = [];
  for (let i = 0; i < w; i++) {
    if (i < fullCount) {
      cells.push(full);
      continue;
    }
    if (i === fullCount && frac > 1e-9 && ramp.length > 0) {
      const idx = Math.min(ramp.length - 1, Math.max(0, Math.ceil(frac * ramp.length) - 1));
      cells.push(ramp[idx]!);
      continue;
    }
    cells.push(empty);
  }
  return cells.join("");
}

/**
 * Visible display width in terminal columns — delegates to pi-tui's
 * `visibleWidth` so every measurement matches pi's own line validation
 * exactly (grapheme clusters, emoji, zero-width marks, ANSI stripping, tabs).
 */
export function displayWidth(text: string): number {
  return visibleWidth(text);
}

/**
 * Force visible display width to exactly `width`: truncate first, then pad.
 * Never returns a string wider than `width` (ANSI counts as zero columns).
 * Use this before framing so the right border never wraps to the next line.
 */
export function forceWidth(text: string, width: number): string {
  if (width <= 0) return "";
  return padToWidth(truncateToWidth(text, width), width);
}

/**
 * Pad so the visible display width is exactly `width`. If already wider,
 * truncates first (same as `forceWidth`) so callers never leak overflow
 * into the outer frame.
 */
export function padToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = displayWidth(text) > width ? truncateToWidth(text, width) : text;
  const current = displayWidth(clipped);
  if (current >= width) return clipped;
  return clipped + " ".repeat(width - current);
}

/**
 * Left-pad so the visible display width is exactly `width`. Truncates when
 * already wider (same overflow guard as `padToWidth`).
 */
export function padStartToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = displayWidth(text) > width ? truncateToWidth(text, width) : text;
  const current = displayWidth(clipped);
  if (current >= width) return clipped;
  return " ".repeat(width - current) + clipped;
}

/**
 * Center `text` within `width` columns (truncate first, then equal pad).
 */
export function centerInWidth(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(text, width);
  const pad = Math.max(0, width - displayWidth(clipped));
  const left = Math.floor(pad / 2);
  return " ".repeat(left) + clipped + " ".repeat(pad - left);
}

/**
 * Truncate to `width` visible columns without breaking a line or splitting
 * an ANSI escape sequence; never throws. Escape sequences count as zero
 * columns and are preserved — including any trailing SGR sequence (e.g. a
 * reset) that falls past the cut point — so truncating already-colored
 * strings never leaves the terminal in a stale color state.
 */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = Array.from(text); // code-point aware (surrogate pairs stay whole)
  let used = 0;
  let result = "";
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    if (ch === "\u001b") {
      // Preserve the whole ANSI SGR sequence; it occupies zero columns.
      let end = i + 1;
      while (end < chars.length && chars[end] !== "m") end++;
      result += chars.slice(i, Math.min(end + 1, chars.length)).join("");
      i = end + 1;
      continue;
    }
    const w = displayWidth(ch);
    if (used + w > width) {
      // Keep any SGR sequences from the dropped tail (resets, color changes)
      // so the terminal state after this line matches the full text.
      result += (chars.slice(i).join("").match(/\u001b\[[0-9;]*m/g) ?? []).join("");
      break;
    }
    result += ch;
    used += w;
    i++;
  }
  return result;
}

/** Vertical bar trend from a series; 8 ASCII levels (width-safe on all terminals). */
export function trendBar(values: readonly number[], maxLen = 80): string {
  // Prefer ASCII over ▁▂▃▄▅▆▇█ — those block glyphs are ambiguous-width on
  // Windows Terminal and can break the outer frame when used at line edges.
  const bars = ["_", ".", ":", "-", "=", "+", "*", "#"];
  if (values.length === 0) return "";
  const capped = values.slice(0, maxLen);
  const max = Math.max(...capped);
  if (max <= 0) return bars[0]!.repeat(capped.length);
  return capped
    .map((value) => {
      const ratio = Math.max(0, Math.min(1, value / max));
      const index = Math.min(bars.length - 1, Math.floor(ratio * bars.length));
      return bars[index]!;
    })
    .join("");
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Compact local date-time for trend titles and axis ticks
 * (e.g. `2026-08-07 14:30`). Non-finite inputs collapse to epoch local time.
 */
export function formatDateTimeCompact(ms: number): string {
  const t = Number.isFinite(ms) ? ms : 0;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Inclusive date-time range for the trend section title
 * (e.g. `2026-08-01 00:00 - 2026-08-07 14:30`).
 * When `fromMs <= 0` (empty open start), the left side is fullwidth `～`
 * (e.g. `～ - 2026-08-07 14:30`) — never epoch as a fake start date.
 * 「全部」with data should pass the first-token timestamp instead.
 * Fullwidth tilde avoids ASCII `~ -` collapsing into a `--` look in many fonts.
 * ASCII hyphen only between sides — Unicode em dashes punch frame holes.
 */
export function formatDateRange(fromMs: number, toMs: number): string {
  const right = formatDateTimeCompact(toMs);
  if (!Number.isFinite(fromMs) || fromMs <= 0) return `～ - ${right}`;
  return `${formatDateTimeCompact(fromMs)} - ${right}`;
}

/** Display label for a time-range selector. */
export function timeRangeLabel(range: "today" | "1d" | "7d" | "14d" | "30d" | "1y" | "all"): string {
  switch (range) {
    case "today":
      return "当天";
    case "1d":
      return "1d";
    case "7d":
      return "7d";
    case "14d":
      return "14d";
    case "30d":
      return "30d";
    case "1y":
      return "1year";
    case "all":
      return "全部";
  }
}

/** Display label for the project/global scope. */
export function scopeLabel(scope: "global" | "project"): string {
  return scope === "project" ? "项目" : "全局";
}

/**
 * Wrap content lines in a Unicode rectangular frame.
 *
 * Layout (width = W):
 *   │ + body (W-2-G) + G spaces + │
 * The trailing ASCII gutter absorbs up to G columns of “surprise” width from
 * ambiguous glyphs (emoji / blocks) so the right border never wraps.
 */
export function frameLines(lines: readonly string[], width: number): string[] {
  const w = Number.isFinite(width) ? Math.floor(width) : 0;
  if (w < 8) {
    return lines.map((line) => truncateToWidth(line, Math.max(0, w)));
  }
  const gutter = FRAME_RIGHT_GUTTER;
  const inner = w - 2;
  const bodyW = Math.max(0, inner - gutter);
  const top = `┌${"─".repeat(inner)}┐`;
  const bot = `└${"─".repeat(inner)}┘`;
  const pad = " ".repeat(gutter);
  const mid = lines.map((line) => `│${forceWidth(line, bodyW)}${pad}│`);
  return [top, ...mid, bot];
}

/** ASCII columns reserved before the right │ inside {@link frameLines}. */
export const FRAME_RIGHT_GUTTER = 4;
