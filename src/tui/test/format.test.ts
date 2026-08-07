/**
 * Terminal-safe formatting tests: token/cost/percent formatting mirrors the
 * Web surface, truncation is display-width aware, and the trend bar is
 * bounded and deterministic.
 */
import { describe, expect, it } from "vitest";
import {
  centerInWidth,
  displayWidth,
  forceWidth,
  formatCompactTokens,
  formatTokensZhCompact,
  formatCost,
  formatDateRange,
  formatDateTimeCompact,
  formatHitRate,
  formatTokens,
  frameLines,
  hitRateBar,
  padStartToWidth,
  padToWidth,
  trendBar,
  truncateToWidth,
} from "../format";
import type { CostDisplay } from "../../domain";

const cost = (amount: number | null, status: CostDisplay["status"]): CostDisplay => ({
  amount,
  status,
  currency: "USD",
});

describe("formatTokens", () => {
  it("groups with zh-CN separators and floors fractions", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1234)).toBe("1,234");
    expect(formatTokens(1234567)).toBe("1,234,567");
  });
});

describe("formatCost", () => {
  it("renders recorded cost with 4 decimals", () => {
    expect(formatCost(cost(0.52205, "recorded"))).toBe("$0.5221");
  });

  it("marks estimated and mixed costs", () => {
    expect(formatCost(cost(0.018, "estimated"))).toBe("~$0.0180（估算）");
    expect(formatCost(cost(0.3, "mixed"))).toBe("$0.3000（混合）");
  });

  it("renders unavailable cost as --", () => {
    expect(formatCost(cost(null, "unavailable"))).toBe("--");
  });
});

describe("formatHitRate", () => {
  it("formats a rate and renders null as --", () => {
    expect(formatHitRate(17.28395)).toBe("17.3%");
    expect(formatHitRate(0)).toBe("0.0%");
    expect(formatHitRate(null)).toBe("--");
  });
});

describe("formatCompactTokens", () => {
  it("uses K/M/B magnitude labels", () => {
    expect(formatCompactTokens(0)).toBe("0");
    expect(formatCompactTokens(999)).toBe("999");
    expect(formatCompactTokens(1_000)).toBe("1K");
    expect(formatCompactTokens(12_500)).toBe("12.5K");
    expect(formatCompactTokens(2_570_000_000)).toBe("2.57B");
    expect(formatCompactTokens(1_200_000)).toBe("1.2M");
  });

  it("collapses non-finite and negative inputs to 0", () => {
    expect(formatCompactTokens(Number.NaN)).toBe("0");
    expect(formatCompactTokens(-5)).toBe("0");
  });
});

describe("formatTokensZhCompact", () => {
  it("uses 亿 at ≥1e8 and 万 below", () => {
    expect(formatTokensZhCompact(85_003_298)).toBe("8500.33万");
    expect(formatTokensZhCompact(100_000_000)).toBe("1亿");
    expect(formatTokensZhCompact(250_000_000)).toBe("2.5亿");
    expect(formatTokensZhCompact(12_500)).toBe("1.25万");
    expect(formatTokensZhCompact(0)).toBe("0万");
  });

  it("collapses non-finite and negative inputs to 0万", () => {
    expect(formatTokensZhCompact(Number.NaN)).toBe("0万");
    expect(formatTokensZhCompact(-5)).toBe("0万");
  });
});

describe("hitRateBar", () => {
  it("renders a Braille gauge with exact width; empty for null/zero width", () => {
    expect(hitRateBar(null, 10)).toBe("");
    expect(hitRateBar(50, 0)).toBe("");
    expect(hitRateBar(0, 4)).toBe("⠀⠀⠀⠀");
    expect(hitRateBar(100, 4)).toBe("⣿⣿⣿⣿");
    expect(displayWidth(hitRateBar(75, 10))).toBe(10);
    expect(displayWidth(hitRateBar(10, 8))).toBe(8);
  });

  it("changes glyph density across rate stages (spark → fire)", () => {
    const spark = hitRateBar(10, 10);
    const fire = hitRateBar(90, 10);
    expect(spark).not.toBe(fire);
    expect(spark).toMatch(/^[⠀⠁⠂⠄⠈⠉⠊⠋⠛⠿⠶⠷⠴⠤⡇⣷⣿]+$/u);
    expect(fire).toContain("⣿");
    expect(fire).toContain("⣀"); // ember track in the 75–99 band
  });

  it("counts Braille cells as 1 column", () => {
    expect(displayWidth("⣿⣷⣧")).toBe(3);
    expect(displayWidth("⠀")).toBe(1);
  });
});

describe("displayWidth / truncateToWidth", () => {
  it("counts CJK as 2 columns and ASCII as 1", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("使用统计")).toBe(8);
    expect(displayWidth("a中文")).toBe(5);
  });

  it("counts block-drawing trend bars as narrow (1 column)", () => {
    expect(displayWidth("▁▅█")).toBe(3);
    expect(displayWidth("trend ▁▂▃")).toBe(9); // "trend " (6) + 3 bars
  });

  it("counts box-drawing frame glyphs as narrow (1 column)", () => {
    expect(displayWidth("┌─┐")).toBe(3);
    expect(displayWidth("│")).toBe(1);
    expect(displayWidth("└─┘")).toBe(3);
    expect(displayWidth("─".repeat(10))).toBe(10);
  });

  it("skips ANSI escape sequences when measuring width", () => {
    expect(displayWidth("\u001b[31mred\u001b[0m")).toBe(3);
    expect(displayWidth("\u001b[38;2;255;0;0mred\u001b[0m")).toBe(3);
  });

  it("truncates at the display-width boundary without splitting a full-width char", () => {
    expect(truncateToWidth("abcdef", 4)).toBe("abcd");
    expect(truncateToWidth("中文统计", 6)).toBe("中文统");
    expect(truncateToWidth("中文统计", 7)).toBe("中文统");
    expect(truncateToWidth("abc", 0)).toBe("");
    expect(truncateToWidth("abc", 10)).toBe("abc");
  });

  it("preserves ANSI escapes while truncating to visible columns", () => {
    // Truecolor prefixes are long; escapes count as zero columns and survive intact.
    const colored = "\u001b[38;2;255;0;0mabcdef\u001b[0m";
    expect(truncateToWidth(colored, 4)).toBe("\u001b[38;2;255;0;0mabcd\u001b[0m");
    expect(displayWidth(truncateToWidth(colored, 4))).toBe(4);
    expect(truncateToWidth(colored, 3)).toBe("\u001b[38;2;255;0;0mabc\u001b[0m");
  });

  it("keeps the trailing reset when truncating past it", () => {
    const colored = "\u001b[2mabc\u001b[0m";
    expect(truncateToWidth(colored, 1)).toBe("\u001b[2ma\u001b[0m");
    expect(displayWidth(truncateToWidth(colored, 1))).toBe(1);
  });
});

describe("padToWidth / padStartToWidth", () => {
  it("pads to an exact visible width and truncates when already wider", () => {
    expect(padToWidth("ab", 5)).toBe("ab   ");
    expect(padStartToWidth("ab", 5)).toBe("   ab");
    expect(padToWidth("abcdef", 4)).toBe("abcd");
    expect(padStartToWidth("abcdef", 4)).toBe("abcd");
    expect(padToWidth("x", 0)).toBe("");
    expect(padStartToWidth("x", 0)).toBe("");
  });

  it("ignores ANSI when measuring and pads CJK by display columns", () => {
    const colored = "\u001b[31mab\u001b[0m";
    expect(displayWidth(padToWidth(colored, 5))).toBe(5);
    expect(padToWidth(colored, 5).endsWith("   ")).toBe(true);
    expect(displayWidth(padStartToWidth(colored, 5))).toBe(5);
    expect(padToWidth("中", 4)).toBe("中  ");
    expect(padStartToWidth("中", 4)).toBe("  中");
  });
});

describe("centerInWidth / forceWidth", () => {
  it("centers text and forceWidth always matches the target columns", () => {
    expect(centerInWidth("ab", 6)).toBe("  ab  ");
    expect(centerInWidth("abc", 6)).toBe(" abc  ");
    expect(displayWidth(forceWidth("hello world", 5))).toBe(5);
    expect(forceWidth("hi", 5)).toBe("hi   ");
  });
});

describe("formatDateTimeCompact / formatDateRange", () => {
  it("formats local compact date-time and ranges", () => {
    const ms = new Date(2026, 7, 7, 14, 30, 0).getTime(); // Aug 7 local
    expect(formatDateTimeCompact(ms)).toBe("08-07 14:30");
    const from = new Date(2026, 7, 1, 0, 0, 0).getTime();
    expect(formatDateRange(from, ms)).toBe("08-01 00:00 - 08-07 14:30");
  });

  it("counts en/em dashes as 1 column (Windows Terminal)", () => {
    expect(displayWidth("—")).toBe(1);
    expect(displayWidth("–")).toBe(1);
    expect(displayWidth("08-07 00:00 - 08-07 16:15")).toBe(25);
  });

  it("ignores emoji variation selectors when measuring width", () => {
    expect(displayWidth("⚡\uFE0F")).toBe(displayWidth("⚡"));
  });

  it("collapses non-finite ms safely", () => {
    expect(formatDateTimeCompact(Number.NaN)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("trendBar", () => {
  it("maps a series to 8-level bars, bounded to 80 cells", () => {
    const bar = trendBar([0, 1, 5, 9]);
    expect(bar.length).toBe(4);
    expect(bar).toMatch(/^[_.:\-=+*#]+$/);
    expect(trendBar([5, 5])).toBe("##"); // max maps to the top level
    expect(trendBar([0, 0])).toBe("__");
  });

  it("returns empty for an empty series and caps long series", () => {
    expect(trendBar([])).toBe("");
    expect(trendBar(Array.from({ length: 200 }, () => 1)).length).toBe(80);
  });

  it("clamps negative values to the lowest bar instead of dropping bars", () => {
    const bar = trendBar([-5, 10, 0]);
    expect(bar.length).toBe(3); // never shorter than the input
    expect(bar[1]).toBe("#");
    expect(bar[0]).toBe("_");
    expect(bar[2]).toBe("_");
  });
});

describe("frameLines", () => {
  it("wraps content in a Unicode rectangle at usable widths", () => {
    const framed = frameLines(["hello", "world"], 12);
    expect(framed[0]).toBe(`┌${"─".repeat(10)}┐`);
    expect(framed[1]).toMatch(/^│hello\s+│$/);
    expect(framed[2]).toMatch(/^│world\s+│$/);
    expect(framed[framed.length - 1]).toBe(`└${"─".repeat(10)}┘`);
    for (const line of framed) {
      expect(displayWidth(line)).toBe(12);
    }
  });

  it("degrades to truncation without a frame when too narrow", () => {
    const lines = frameLines(["abcdefghij"], 5);
    expect(lines).toEqual(["abcde"]);
    expect(lines[0]).not.toMatch(/[┌│└]/);
  });

  it("keeps a multi-column ASCII gutter before the right border", () => {
    const framed = frameLines(["hello", "world"], 12);
    expect(framed[1]!.endsWith(`${" ".repeat(4)}│`)).toBe(true);
    for (const line of framed) {
      expect(displayWidth(line)).toBe(12);
      expect(line.endsWith("┐") || line.endsWith("┘") || line.endsWith("│")).toBe(true);
    }
  });

  it("keeps right border attached when content would otherwise overflow", () => {
    const framed = frameLines(["x".repeat(50), "\u001b[31m" + "宽".repeat(20) + "\u001b[0m"], 20);
    for (const line of framed) {
      expect(displayWidth(line)).toBe(20);
      expect(line.endsWith("┐") || line.endsWith("┘") || line.endsWith("│")).toBe(true);
    }
  });
});
