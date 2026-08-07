/**
 * Overlay trend-chart unit tests: five-series legend, no total, empty/zero
 * data, dual-scale cue, and per-row displayWidth ≤ width.
 */
import { describe, expect, it } from "vitest";
import type { TrendPoint } from "../../domain";
import { displayWidth } from "../format";
import { renderTrendChart, TREND_CHART_SERIES } from "../trend-chart";

const point = (partial: Partial<TrendPoint> & { startMs: number }): TrendPoint => ({
  startMs: partial.startMs,
  inputTokens: partial.inputTokens ?? 0,
  outputTokens: partial.outputTokens ?? 0,
  cacheWriteTokens: partial.cacheWriteTokens ?? 0,
  cacheReadTokens: partial.cacheReadTokens ?? 0,
  totalTokens: partial.totalTokens ?? 0,
  cost: partial.cost ?? { amount: 0, status: "recorded", currency: "USD" },
});

const sampleTrend = (): TrendPoint[] => {
  const day = 86_400_000;
  const base = Date.UTC(2026, 7, 1, 0, 0, 0);
  return [
    point({ startMs: base, inputTokens: 100, outputTokens: 40, cacheWriteTokens: 10, cacheReadTokens: 20, totalTokens: 170, cost: { amount: 0.1, status: "recorded", currency: "USD" } }),
    point({ startMs: base + day, inputTokens: 200, outputTokens: 80, cacheWriteTokens: 20, cacheReadTokens: 50, totalTokens: 350, cost: { amount: 0.25, status: "recorded", currency: "USD" } }),
    point({ startMs: base + 2 * day, inputTokens: 50, outputTokens: 10, cacheWriteTokens: 5, cacheReadTokens: 5, totalTokens: 70, cost: { amount: 0.05, status: "recorded", currency: "USD" } }),
    point({ startMs: base + 3 * day, inputTokens: 300, outputTokens: 120, cacheWriteTokens: 30, cacheReadTokens: 90, totalTokens: 540, cost: { amount: 0.4, status: "recorded", currency: "USD" } }),
  ];
};

describe("renderTrendChart", () => {
  it("exposes exactly the five approved series names (no total)", () => {
    expect([...TREND_CHART_SERIES]).toEqual(["Cost", "Cache write", "Cache read", "Input", "Output"]);
    expect(TREND_CHART_SERIES).not.toContain("total");
  });

  it("renders legend for all five series and omits total", () => {
    const lines = renderTrendChart(sampleTrend(), { width: 100, colorize: false });
    const text = lines.join("\n");
    for (const name of TREND_CHART_SERIES) {
      expect(text).toContain(name);
    }
    expect(text).not.toMatch(/\btotal\b/i);
    expect(text).toContain("cost($)");
  });

  it("keeps every row within width, including narrow terminals", () => {
    for (const width of [1, 3, 5, 10, 40, 80, 120]) {
      const lines = renderTrendChart(sampleTrend(), { width, colorize: false });
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("maps cost onto its own max so a tiny cost still reaches the top row", () => {
    const trend = [
      point({
        startMs: 1_700_000_000_000,
        inputTokens: 100_000,
        cost: { amount: 0.01, status: "recorded", currency: "USD" },
      }),
      point({
        startMs: 1_700_086_400_000,
        inputTokens: 10_000,
        cost: { amount: 0.02, status: "recorded", currency: "USD" },
      }),
    ];
    const lines = renderTrendChart(trend, { width: 72, height: 6, colorize: false });
    // Skip legend / units cue; first plot row is the top of the dual-Y grid.
    const unitsIdx = lines.findIndex((line) => line.includes("cost($)"));
    const topPlot = lines[unitsIdx + 1] ?? "";
    expect(topPlot).toMatch(/[·:]/);
  });

  it("connects adjacent samples with continuous ink (not only isolated scatter)", () => {
    // Steep rise: Bresenham fills intermediate rows between samples.
    const trend = [
      point({ startMs: 1, inputTokens: 1, totalTokens: 1 }),
      point({ startMs: 2, inputTokens: 100, totalTokens: 100 }),
      point({ startMs: 3, inputTokens: 1, totalTokens: 1 }),
    ];
    const lines = renderTrendChart(trend, { width: 40, height: 8, colorize: false });
    const unitsIdx = lines.findIndex((line) => line.includes("cost($)"));
    const plot = lines.slice(unitsIdx + 1, unitsIdx + 1 + 8).join("");
    const ink = (plot.match(/[o*+x·]/g) ?? []).length;
    // Continuous segments paint more than one cell per series endpoint.
    expect(ink).toBeGreaterThan(6);
  });

  it("dashed cost series still paints every sample column (including the last)", () => {
    // Flat cost + plotW=2: a 1-wide Bresenham segment would skip the odd
    // endpoint if dashed painting omitted atEnd. Legend at width 2 truncates
    // before the · glyph, so plot-body dots are unambiguous.
    const trend = [
      point({ startMs: 1, cost: { amount: 0.1, status: "recorded", currency: "USD" } }),
      point({ startMs: 2, cost: { amount: 0.1, status: "recorded", currency: "USD" } }),
    ];
    const lines = renderTrendChart(trend, { width: 2, height: 3, colorize: false });
    const plotBody = lines.slice(1).join("");
    const dots = (plotBody.match(/·/g) ?? []).length;
    expect(dots).toBeGreaterThanOrEqual(2);
  });

  it("uses a taller default plot height on wide terminals", () => {
    const narrow = renderTrendChart(sampleTrend(), { width: 30, colorize: false });
    const wide = renderTrendChart(sampleTrend(), { width: 100, colorize: false });
    // Wide plot body (excluding legend/units/axis) should be taller.
    expect(wide.length).toBeGreaterThan(narrow.length);
  });

  it("handles empty trend without throwing", () => {
    const lines = renderTrendChart([], { width: 80, colorize: false });
    const text = lines.join("\n");
    expect(text).toContain("Cost");
    expect(text).toContain("(no trend data)");
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  it("handles all-zero trend without throwing", () => {
    const zeros = [
      point({ startMs: 1_700_000_000_000 }),
      point({ startMs: 1_700_086_400_000 }),
    ];
    const lines = renderTrendChart(zeros, { width: 80, colorize: false });
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  it("shows x-axis date ticks aligned to trend startMs", () => {
    const trend = sampleTrend();
    const lines = renderTrendChart(trend, { width: 100, colorize: false });
    const text = lines.join("\n");
    // Local-time compact labels from first/last bucket.
    expect(text).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it("colorize wraps series glyphs in ANSI without exceeding width", () => {
    const lines = renderTrendChart(sampleTrend(), { width: 80, colorize: true });
    expect(lines.some((line) => line.includes("\u001b["))).toBe(true);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(80);
    }
  });
});
