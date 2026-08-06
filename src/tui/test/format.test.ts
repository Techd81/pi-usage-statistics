/**
 * Terminal-safe formatting tests: token/cost/percent formatting mirrors the
 * Web surface, truncation is display-width aware, and the trend bar is
 * bounded and deterministic.
 */
import { describe, expect, it } from "vitest";
import { displayWidth, formatCost, formatHitRate, formatTokens, trendBar, truncateToWidth } from "../format";
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

describe("trendBar", () => {
  it("maps a series to 8-level bars, bounded to 80 cells", () => {
    const bar = trendBar([0, 1, 5, 9]);
    expect(bar.length).toBe(4);
    expect(bar).toMatch(/^[▁-█]+$/);
    expect(trendBar([5, 5])).toBe("██"); // max maps to the top level
    expect(trendBar([0, 0])).toBe("▁▁");
  });

  it("returns empty for an empty series and caps long series", () => {
    expect(trendBar([])).toBe("");
    expect(trendBar(Array.from({ length: 200 }, () => 1)).length).toBe(80);
  });

  it("clamps negative values to the lowest bar instead of dropping bars", () => {
    const bar = trendBar([-5, 10, 0]);
    expect(bar.length).toBe(3); // never shorter than the input
    expect(bar[1]).toBe("█");
    expect(bar[0]).toBe("▁");
    expect(bar[2]).toBe("▁");
  });
});
