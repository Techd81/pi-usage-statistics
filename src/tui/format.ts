/**
 * Terminal-safe formatting for the TUI surface. Mirrors the Web dashboard's
 * number/cost/percent conventions (spec web-and-tui.md: shared formatting
 * rules) so both surfaces present identical values. No ANSI codes are
 * generated here — colors are applied by the component after truncation.
 */
import type { CostDisplay } from "../domain";

const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

/** Token counts with zh-CN grouping, matching the Web surface. */
export function formatTokens(value: number): string {
  return numberFormat.format(value);
}

/**
 * Cost follows the Web convention: fixed 4 decimals, `--` when unavailable,
 * `~…（估算）` for estimated, `…（混合）` for a recorded+estimated mix.
 */
export function formatCost(cost: CostDisplay): string {
  if (cost.amount === null) return "--";
  const base = `$${cost.amount.toFixed(4)}`;
  if (cost.status === "estimated") return `~${base}（估算）`;
  if (cost.status === "mixed") return `${base}（混合）`;
  return base;
}

/** Cache-hit rate; a null rate (zero denominator) renders as `--`. */
export function formatHitRate(rate: number | null): string {
  return rate === null ? "--" : `${rate.toFixed(1)}%`;
}

/**
 * Compact magnitude for the hero subtitle (e.g. `2.57B`, `1.2M`, `3.4K`).
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
 * Block progress bar for a 0–100 cache-hit rate. `null` or non-positive
 * width yields `""` so callers can pair it with `--` for the percent.
 */
export function hitRateBar(rate: number | null, width: number): string {
  const w = Number.isFinite(width) ? Math.floor(width) : 0;
  if (rate === null || w <= 0) return "";
  const clamped = Math.max(0, Math.min(100, rate));
  const filled = Math.min(w, Math.round((clamped / 100) * w));
  return "█".repeat(filled) + "░".repeat(w - filled);
}

/**
 * Columns for one character: full-width (CJK / emoji) characters count as 2,
 * block-drawing (U+2580–U+259F) and box-drawing (U+2500–U+257F) as 1,
 * everything else ASCII as 1. The CJK test is a rough heuristic (any code
 * point above 0xff counts as full-width); terminal line-drawing glyphs are
 * the notable narrow exceptions.
 */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x2500 && code <= 0x257f) return 1; // box drawing ┌─┐│└┘ etc.
  if (code >= 0x2580 && code <= 0x259f) return 1; // ▁▂▃▄▅▆▇█ are narrow
  return code > 0xff ? 2 : 1;
}

/**
 * Visible display width: full-width (CJK) characters count as 2 columns,
 * everything else as 1. ANSI escape sequences are skipped entirely, so this
 * stays correct for strings that were already colored.
 */
export function displayWidth(text: string): number {
  let width = 0;
  let inEscape = false;
  for (const ch of text) {
    if (ch === "\u001b") {
      inEscape = true;
      continue;
    }
    if (inEscape) {
      if (ch === "m") inEscape = false; // ANSI SGR ends with 'm'
      continue;
    }
    width += charWidth(ch);
  }
  return width;
}

/**
 * Pad (or leave as-is) so the visible display width is exactly `width`.
 * ANSI escape sequences count as zero columns. When the text is already
 * wider than `width`, it is returned unchanged — callers should truncate
 * first when a hard cap is required.
 */
export function padToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  const current = displayWidth(text);
  if (current >= width) return text;
  return text + " ".repeat(width - current);
}

/**
 * Left-pad so the visible display width is exactly `width`. Same ANSI
 * accounting as `padToWidth`.
 */
export function padStartToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  const current = displayWidth(text);
  if (current >= width) return text;
  return " ".repeat(width - current) + text;
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
    const w = charWidth(ch);
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

/** Vertical bar trend from a series; 8 levels, empty input renders "". */
export function trendBar(values: readonly number[], maxLen = 80): string {
  const bars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  if (values.length === 0) return "";
  const capped = values.slice(0, maxLen);
  const max = Math.max(...capped);
  if (max <= 0) return bars[0]!.repeat(capped.length);
  return capped
    .map((value) => {
      // Clamp to [0, 1]: negative values (corrupt data) map to the lowest bar
      // instead of indexing past the start of the palette.
      const ratio = Math.max(0, Math.min(1, value / max));
      const index = Math.min(bars.length - 1, Math.floor(ratio * bars.length));
      return bars[index]!;
    })
    .join("");
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Compact local date-time for trend axis ticks (e.g. `08-07 14:30`).
 * Non-finite inputs collapse to `00-00 00:00`.
 */
export function formatDateTimeCompact(ms: number): string {
  const t = Number.isFinite(ms) ? ms : 0;
  const d = new Date(t);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Inclusive date-time range for the trend section title
 * (e.g. `08-01 00:00 — 08-07 14:30`).
 */
export function formatDateRange(fromMs: number, toMs: number): string {
  return `${formatDateTimeCompact(fromMs)} — ${formatDateTimeCompact(toMs)}`;
}

/** Display label for a time-range selector. */
export function timeRangeLabel(range: "today" | "7d" | "30d" | "all"): string {
  switch (range) {
    case "today":
      return "今天";
    case "7d":
      return "7天";
    case "30d":
      return "30天";
    case "all":
      return "全部";
  }
}

/** Display label for the project/global scope. */
export function scopeLabel(scope: "global" | "project"): string {
  return scope === "project" ? "项目" : "全局";
}

/**
 * Wrap content lines in a Unicode rectangular frame. Content is truncated /
 * padded to `width - 2` so the finished rows are exactly `width` columns.
 * When `width < 8` the frame is skipped (too narrow for corners + content)
 * and lines are only truncated to `width`.
 */
export function frameLines(lines: readonly string[], width: number): string[] {
  const w = Number.isFinite(width) ? Math.floor(width) : 0;
  if (w < 8) {
    return lines.map((line) => truncateToWidth(line, Math.max(0, w)));
  }
  const inner = w - 2;
  const top = `┌${"─".repeat(inner)}┐`;
  const bot = `└${"─".repeat(inner)}┘`;
  const mid = lines.map((line) => `│${padToWidth(truncateToWidth(line, inner), inner)}│`);
  return [top, ...mid, bot];
}
