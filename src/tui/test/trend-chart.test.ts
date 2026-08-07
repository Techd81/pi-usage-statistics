/**
 * Overlay trend-chart unit tests: five-series legend, no total, empty/zero
 * data, dual-scale cue, and per-row displayWidth ≤ width.
 */
import { describe, expect, it } from "vitest";
import type { TrendPoint } from "../../domain";
import { displayWidth, formatDateTimeCompact } from "../format";
import { renderTrendChart, TREND_CHART_SERIES, trimTrendEmptyEdges } from "../trend-chart";

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
    expect(topPlot).toMatch(/·/);
  });

  it("scatters sample glyphs only — no connecting line ink", () => {
    const trend = [
      point({ startMs: 1, inputTokens: 1, totalTokens: 1 }),
      point({ startMs: 2, inputTokens: 100, totalTokens: 100 }),
      point({ startMs: 3, inputTokens: 1, totalTokens: 1 }),
    ];
    const lines = renderTrendChart(trend, { width: 40, height: 8, colorize: false });
    const unitsIdx = lines.findIndex((line) => line.includes("cost($)"));
    const plot = lines.slice(unitsIdx + 1, unitsIdx + 1 + 8).join("");
    expect(plot).not.toMatch(/[─│╱╲]/);
    expect((plot.match(/o/g) ?? []).length).toBeGreaterThan(0);
  });

  it("paints cost glyphs at every positive sample column (including the last)", () => {
    const trend = [
      point({ startMs: 1, cost: { amount: 0.1, status: "recorded", currency: "USD" } }),
      point({ startMs: 2, cost: { amount: 0.1, status: "recorded", currency: "USD" } }),
    ];
    const lines = renderTrendChart(trend, { width: 2, height: 3, colorize: false });
    const plotBody = lines.slice(1).join("");
    const dots = (plotBody.match(/·/g) ?? []).length;
    expect(dots).toBeGreaterThanOrEqual(2);
  });

  it("paints zero-value samples on the baseline for every series (incl. Cache write)", () => {
    const trend = [
      point({
        startMs: 1,
        cacheReadTokens: 1000,
        outputTokens: 100,
        cacheWriteTokens: 0,
        cost: { amount: 0.1, status: "recorded", currency: "USD" },
      }),
      point({
        startMs: 2,
        cacheReadTokens: 2000,
        outputTokens: 200,
        cacheWriteTokens: 0,
        cost: { amount: 0.2, status: "recorded", currency: "USD" },
      }),
    ];
    const height = 8;
    const lines = renderTrendChart(trend, { width: 72, height, colorize: false });
    const unitsIdx = lines.findIndex((line) => line.includes("cost($)"));
    const plotRows = lines.slice(unitsIdx + 1, unitsIdx + 1 + height);
    const bottom = plotRows[height - 1] ?? "";
    // Cache write is all-zero — must still ink the baseline (not silently omitted).
    expect(bottom.includes("+")).toBe(true);
    expect(plotRows.join("").includes("x")).toBe(true);
  });

  it("keeps Input/Output zeros visible on the baseline (not buried under Cost ·)", () => {
    const trend = [
      point({
        startMs: 1,
        cacheReadTokens: 5_000_000,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cost: { amount: 0, status: "recorded", currency: "USD" },
      }),
      point({
        startMs: 2,
        cacheReadTokens: 6_000_000,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cost: { amount: 0, status: "recorded", currency: "USD" },
      }),
    ];
    const height = 8;
    const lines = renderTrendChart(trend, { width: 60, height, colorize: false });
    const unitsIdx = lines.findIndex((line) => line.includes("cost($)"));
    const bottom = lines[unitsIdx + height] ?? "";
    // Neighbor-spill keeps multiple zero series visible on the baseline.
    expect(bottom).toContain("+");
    expect(bottom).toContain("o");
    expect(bottom).toContain("x");
    expect(bottom).toContain("·");
  });

  it("draws a ─ time baseline between the plot body and date ticks", () => {
    const lines = renderTrendChart(sampleTrend(), { width: 80, height: 6, colorize: false });
    const axisIdx = lines.length - 1;
    const baseline = lines[axisIdx - 1] ?? "";
    expect(baseline).toMatch(/─{4,}/);
    expect(baseline).not.toMatch(/[o*+x·]/);
  });

  it("does not let zero markers erase non-zero peaks", () => {
    const trend = [
      point({ startMs: 1, outputTokens: 100, cost: { amount: 0, status: "recorded", currency: "USD" } }),
      point({ startMs: 2, outputTokens: 0, cost: { amount: 0, status: "recorded", currency: "USD" } }),
      point({ startMs: 3, outputTokens: 80, cost: { amount: 0.4, status: "recorded", currency: "USD" } }),
    ];
    const height = 6;
    const lines = renderTrendChart(trend, { width: 40, height, colorize: false });
    const unitsIdx = lines.findIndex((line) => line.includes("cost($)"));
    const above = lines.slice(unitsIdx + 1, unitsIdx + height).join("");
    expect(above.includes("x")).toBe(true);
  });

  it("uses a taller default plot height on wide terminals", () => {
    const narrow = renderTrendChart(sampleTrend(), { width: 30, colorize: false });
    const wide = renderTrendChart(sampleTrend(), { width: 100, colorize: false });
    // Wide plot body (excluding legend/units/axis) should be taller.
    expect(wide.length).toBeGreaterThan(narrow.length);
  });

  it("keeps Output above the baseline when Cache read dominates by 100×+", () => {
    // Reproduces the real-world crush: cache-read peaks crush linear Output to y=0.
    const trend = [
      point({
        startMs: 1,
        cacheReadTokens: 8_000_000,
        outputTokens: 30_000,
        inputTokens: 140_000,
        totalTokens: 8_170_000,
        cost: { amount: 1.2, status: "recorded", currency: "USD" },
      }),
      point({
        startMs: 2,
        cacheReadTokens: 6_000_000,
        outputTokens: 50_000,
        inputTokens: 200_000,
        totalTokens: 6_250_000,
        cost: { amount: 2.0, status: "recorded", currency: "USD" },
      }),
      point({
        startMs: 3,
        cacheReadTokens: 7_500_000,
        outputTokens: 40_000,
        inputTokens: 160_000,
        totalTokens: 7_700_000,
        cost: { amount: 1.5, status: "recorded", currency: "USD" },
      }),
    ];
    const height = 11;
    const lines = renderTrendChart(trend, { width: 80, height, colorize: false });
    const unitsIdx = lines.findIndex((line) => line.includes("cost($)"));
    const plotRows = lines.slice(unitsIdx + 1, unitsIdx + 1 + height);
    const bottom = plotRows[height - 1] ?? "";
    const above = plotRows.slice(0, height - 1).join("");
    // Output ink must appear above the baseline — not only on y=0.
    expect(above.includes("x")).toBe(true);
    // And not exclusively stuck on the bottom row.
    const bottomX = (bottom.match(/x/g) ?? []).length;
    const aboveX = (above.match(/x/g) ?? []).length;
    expect(aboveX).toBeGreaterThan(bottomX);
  });

  it("shows mid Y-axis ticks on tall plots", () => {
    const lines = renderTrendChart(sampleTrend(), { width: 100, height: 11, colorize: false });
    const unitsIdx = lines.findIndex((line) => line.includes("cost($)"));
    const plotRows = lines.slice(unitsIdx + 1, unitsIdx + 1 + 11);
    // Mid row should carry a compact token label (not only top/bottom).
    const mid = plotRows[Math.floor(10 / 2)] ?? "";
    expect(mid.trimStart().match(/^\d/)).toBeTruthy();
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
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it("forces axisToMs on the right tick and supports open-start ~", () => {
    const trend = sampleTrend();
    const axisTo = new Date(2026, 7, 7, 17, 17, 0).getTime();
    const lines = renderTrendChart(trend, {
      width: 100,
      colorize: false,
      openStart: true,
      axisToMs: axisTo,
    });
    const axis = lines[lines.length - 1] ?? "";
    expect(axis).toContain("~");
    expect(axis).toContain("2026-08-07 17:17");
  });

  it("does not lose the active tail when the window is mostly leading zeros (30d/1y bug)", () => {
    // Mostly empty prefix + real activity only at the end — stride sampling
    // used to pick almost only zeros and hide the tail.
    const trend = [
      ...Array.from({ length: 900 }, (_, i) => point({ startMs: i })),
      ...Array.from({ length: 100 }, (_, i) =>
        point({
          startMs: 900 + i,
          cacheReadTokens: 2_000_000,
          inputTokens: 50_000,
          outputTokens: 10_000,
          cost: { amount: 1.5, status: "recorded", currency: "USD" },
        }),
      ),
    ];
    const height = 10;
    const lines = renderTrendChart(trend, { width: 80, height, colorize: false });
    const unitsIdx = lines.findIndex((line) => line.includes("cost($)"));
    const above = lines.slice(unitsIdx + 1, unitsIdx + height).join("");
    // Peaks from the active tail must appear above the baseline.
    expect(above).toMatch(/[o*x]/);
  });

  it("sparsePaint (全部): no solid horizontal bars on a flat dense series", () => {
    const trend = Array.from({ length: 200 }, (_, i) =>
      point({
        startMs: 1_700_000_000_000 + i * 3_600_000,
        cacheReadTokens: 5_000_000,
        outputTokens: 20_000,
        inputTokens: 50_000,
        cost: { amount: 0.5, status: "recorded", currency: "USD" },
      }),
    );
    const height = 10;
    const lines = renderTrendChart(trend, {
      width: 80,
      height,
      colorize: false,
      sparsePaint: true,
    });
    const unitsIdx = lines.findIndex((line) => line.includes("cost($)"));
    const plot = lines.slice(unitsIdx + 1, unitsIdx + 1 + height).join("");
    expect(plot.match(/\*{6,}/g) ?? []).toHaveLength(0);
    expect(plot).toContain("*");
  });

  it("sparsePaint still paints every zero on the baseline (Cache write=0)", () => {
    const trend = Array.from({ length: 80 }, (_, i) =>
      point({
        startMs: 1_700_000_000_000 + i * 3_600_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 0,
        inputTokens: 10_000,
        outputTokens: 1_000,
        cost: { amount: 0.2, status: "recorded", currency: "USD" },
      }),
    );
    const height = 8;
    const lines = renderTrendChart(trend, {
      width: 72,
      height,
      colorize: false,
      sparsePaint: true,
    });
    const unitsIdx = lines.findIndex((line) => line.includes("cost($)"));
    const baseline = lines[unitsIdx + height] ?? "";
    // Zeros are not sparsified — baseline must carry dense Cache-write `+`.
    expect(baseline).toMatch(/\+{5,}/);
  });

  it("bounded ranges paint every column (sparsePaint off — 1d/7d must stay dense)", () => {
    const trend = Array.from({ length: 40 }, (_, i) =>
      point({
        startMs: 1_700_000_000_000 + i * 3_600_000,
        cacheReadTokens: 5_000_000,
        outputTokens: 20_000,
        inputTokens: 50_000,
        cost: { amount: 0.5, status: "recorded", currency: "USD" },
      }),
    );
    const height = 8;
    const lines = renderTrendChart(trend, { width: 60, height, colorize: false });
    const unitsIdx = lines.findIndex((line) => line.includes("cost($)"));
    const plot = lines.slice(unitsIdx + 1, unitsIdx + 1 + height).join("");
    // Without sparsePaint, flat column-max ink forms a continuous peak run.
    expect(plot).toMatch(/\*{6,}/);
  });

  it("keeps filter-window zeros on the left — idle days render as 0, not cropped", () => {
    const day = 86_400_000;
    const windowStart = Date.UTC(2026, 6, 8, 9, 0); // 07-08 — no install yet = 0
    const firstData = windowStart + 12 * day;
    const toMs = windowStart + 30 * day;
    const trend = [
      point({ startMs: windowStart }),
      point({ startMs: windowStart + day }),
      point({ startMs: windowStart + 2 * day }),
      point({
        startMs: firstData,
        cacheReadTokens: 1_000_000,
        outputTokens: 10_000,
        inputTokens: 20_000,
        cost: { amount: 0.5, status: "recorded", currency: "USD" },
      }),
      point({
        startMs: firstData + day,
        cacheReadTokens: 1_200_000,
        outputTokens: 12_000,
        inputTokens: 22_000,
        cost: { amount: 0.6, status: "recorded", currency: "USD" },
      }),
    ];
    const height = 8;
    const lines = renderTrendChart(trend, {
      width: 72,
      height,
      colorize: false,
      axisFromMs: windowStart,
      axisToMs: toMs,
    });
    const axis = lines[lines.length - 1] ?? "";
    expect(axis).toContain(formatDateTimeCompact(windowStart));
    const unitsIdx = lines.findIndex((line) => line.includes("cost($)"));
    const bottom = lines[unitsIdx + height] ?? "";
    // Leading idle buckets must leave zero glyphs on the baseline (not blank).
    expect(bottom).toMatch(/[o*+x·]/);
  });

  it("trimTrendEmptyEdges drops leading/trailing zero buckets", () => {
    const day = 86_400_000;
    const base = Date.UTC(2026, 2, 1);
    const raw = [
      point({ startMs: base }),
      point({ startMs: base + day }),
      point({ startMs: base + 2 * day, outputTokens: 10 }),
      point({ startMs: base + 3 * day, outputTokens: 20 }),
      point({ startMs: base + 4 * day }),
    ];
    const trimmed = trimTrendEmptyEdges(raw);
    expect(trimmed).toHaveLength(2);
    expect(trimmed[0]!.outputTokens).toBe(10);
    expect(trimmed[1]!.outputTokens).toBe(20);
  });

  it("colorize wraps series glyphs in ANSI without exceeding width", () => {
    const lines = renderTrendChart(sampleTrend(), { width: 80, colorize: true });
    expect(lines.some((line) => line.includes("\u001b["))).toBe(true);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(80);
    }
  });
});
