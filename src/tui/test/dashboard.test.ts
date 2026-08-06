/**
 * Overlay component tests (TC1–TC6): render() output at wide and narrow
 * widths, all presentation states, keyboard close, and the no-op theme
 * guarantee (deterministic output, safe in non-TUI modes).
 */
import { describe, expect, it, vi } from "vitest";
import { displayWidth } from "../format";
import { makeOverlayFactory, UsageDashboardComponent } from "../dashboard";
import type { OverlayState } from "../dashboard";
import type { UsageQueryResult } from "../../domain";
import { DEFAULT_BUCKET_MS } from "../../domain";

const emptyResult = (overrides: Partial<UsageQueryResult> = {}): UsageQueryResult => ({
  filters: {
    providers: [],
    models: [],
    projects: [],
    sessions: [],
    fromMs: 0,
    toMs: Number.MAX_SAFE_INTEGER,
    bucketMs: DEFAULT_BUCKET_MS,
    includeSummaryUsage: false,
  },
  totals: {
    totalTokens: 0,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    cacheHitRate: null,
    cost: { amount: null, status: "unavailable", currency: "USD" },
  },
  trend: [],
  dimensions: { providers: [], models: [], projects: [], sessions: [] },
  refreshedAtMs: 1_700_000_000_000,
  ...overrides,
});

const ready = (result: UsageQueryResult): OverlayState => ({ kind: "ready", result });

describe("UsageDashboardComponent.render", () => {
  it("TC1: renders the shared query totals, breakdown, cost provenance, and trend at wide width", () => {
    const state = ready(
      emptyResult({
        totals: {
          totalTokens: 555,
          requestCount: 2,
          inputTokens: 300,
          outputTokens: 150,
          cacheWriteTokens: 70,
          cacheReadTokens: 35,
          cacheHitRate: 8.64,
          cost: { amount: 0.52205, status: "mixed", currency: "USD" },
        },
        trend: [
          { startMs: 0, inputTokens: 100, outputTokens: 50, cacheWriteTokens: 20, cacheReadTokens: 10, totalTokens: 180, cost: { amount: 0.1, status: "recorded", currency: "USD" } },
          { startMs: 30_000, inputTokens: 200, outputTokens: 100, cacheWriteTokens: 50, cacheReadTokens: 25, totalTokens: 375, cost: { amount: 0.2, status: "estimated", currency: "USD" } },
        ],
        dimensions: { providers: ["anthropic"], models: ["claude-sonnet-4-5"], projects: ["/p1"], sessions: ["s1"] },
      }),
    );
    const lines = new UsageDashboardComponent(state).render(120);
    const text = lines.join("\n");
    expect(text).toContain("requests");
    expect(text).toContain("2");
    expect(text).toContain("total tokens");
    expect(text).toContain("555");
    expect(text).toContain("input");
    expect(text).toContain("cache hit");
    expect(text).toContain("$0.5221（混合）");
    expect(text).toContain("trend");
    expect(text).toContain("models 1 · projects 1 · sessions 1");
    expect(text).toContain("[q] close");
  });

  it("TC2: narrow width hides the token breakdown but keeps essentials and never throws", () => {
    const state = ready(
      emptyResult({
        totals: {
          totalTokens: 1_234_567,
          requestCount: 42,
          inputTokens: 700_000,
          outputTokens: 300_000,
          cacheWriteTokens: 100_000,
          cacheReadTokens: 134_567,
          cacheHitRate: 12.3,
          cost: { amount: 1.25, status: "recorded", currency: "USD" },
        },
        dimensions: { providers: ["anthropic"], models: ["claude-sonnet-4-5"], projects: ["/p1"], sessions: ["s1"] },
      }),
    );
    const lines = new UsageDashboardComponent(state).render(40);
    const text = lines.join("\n");
    expect(text).toContain("total tokens");
    expect(text).toContain("requests");
    expect(text).toContain("cost");
    expect(text).toContain("$1.2500");
    expect(text).toContain("[q] close");
    // Narrow width hides the breakdown rows and the dimensions line.
    expect(text).not.toContain("input");
    expect(text).not.toContain("output");
    expect(text).not.toContain("cache write");
    expect(text).not.toContain("cache read");
    expect(text).not.toContain("models 1");
    // Every rendered line fits the viewport (display-width aware).
    for (const line of lines) {
      expect(Array.from(line).reduce((w, ch) => w + (ch.codePointAt(0)! > 0xff ? 2 : 1), 0)).toBeLessThanOrEqual(40);
    }
  });

  it("TC2b: an extremely narrow width (e.g. 10) still renders without throwing", () => {
    const state = ready(emptyResult({ totals: { ...emptyResult({}).totals, totalTokens: 123, requestCount: 1 } }));
    expect(() => new UsageDashboardComponent(state).render(10)).not.toThrow();
  });

  it("TC2c: with a real (ANSI) theme, narrow rendering keeps lines within width and every escape sequence intact", () => {
    // The noopTheme used elsewhere hides ANSI-related truncation bugs; this
    // exercises the truecolor-length prefixes Pi emits.
    const ansiTheme = {
      normal: (text: string) => `\u001b[38;2;229;231;235m${text}\u001b[0m`,
      selected: (text: string) => `\u001b[38;2;125;211;252m${text}\u001b[0m`,
      error: (text: string) => `\u001b[38;2;248;113;113m${text}\u001b[0m`,
      muted: (text: string) => `\u001b[38;2;148;163;184m${text}\u001b[0m`,
    };
    const state = ready(
      emptyResult({
        totals: {
          totalTokens: 1_234_567,
          requestCount: 42,
          inputTokens: 700_000,
          outputTokens: 300_000,
          cacheWriteTokens: 100_000,
          cacheReadTokens: 134_567,
          cacheHitRate: 12.3,
          cost: { amount: 1.25, status: "estimated", currency: "USD" },
        },
      }),
    );
    const lines = new UsageDashboardComponent(state, ansiTheme).render(40);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
      // Every escape sequence is terminated: no split prefixes, no bleeding color.
      expect((line.match(/\u001b\[[0-9;]*m/g) ?? []).length).toBe((line.match(/\u001b\[/g) ?? []).length);
    }
    expect(lines.join("\n")).toContain("~$1.2500（估算）");
  });

  it("TC3: zero-data state renders a meaningful message without crashing", () => {
    const lines = new UsageDashboardComponent(ready(emptyResult())).render(80);
    expect(lines.join("\n")).toContain("No usage data in the selected range.");
    expect(lines.join("\n")).toContain("--");
  });

  it("TC3b: error state renders the message and stays openable", () => {
    const lines = new UsageDashboardComponent({ kind: "error", message: "store init failed" }).render(60);
    const text = lines.join("\n");
    expect(text).toContain("Usage data unavailable");
    expect(text).toContain("store init failed");
    expect(text).toContain("[q] close");
  });

  it("TC3c: loading state renders a loading line", () => {
    const lines = new UsageDashboardComponent({ kind: "loading" }).render(60);
    expect(lines.join("\n")).toContain("Loading usage data");
  });

  it("TC4: estimated and unavailable costs are visually distinct", () => {
    const estimated = new UsageDashboardComponent(
      ready(emptyResult({ totals: { ...emptyResult({}).totals, cost: { amount: 0.018, status: "estimated", currency: "USD" } } })),
    ).render(80);
    expect(estimated.join("\n")).toContain("~$0.0180（估算）");

    const unavailable = new UsageDashboardComponent(
      ready(emptyResult({ totals: { ...emptyResult({}).totals, cost: { amount: null, status: "unavailable", currency: "USD" } } })),
    ).render(80);
    expect(unavailable.join("\n")).toContain("--");
  });
});

describe("UsageDashboardComponent.handleInput", () => {
  it("closes on q and on Escape, ignores other keys", () => {
    const onDone = vi.fn();
    const component = new UsageDashboardComponent(ready(emptyResult()), undefined, onDone);
    component.handleInput("r");
    expect(onDone).not.toHaveBeenCalled();
    component.handleInput("q");
    expect(onDone).toHaveBeenCalledTimes(1);
    component.handleInput("\u001b");
    expect(onDone).toHaveBeenCalledTimes(2);
  });
});

describe("makeOverlayFactory", () => {
  it("TC5: builds a component from a state getter and maps the Pi theme to colors", () => {
    const factory = makeOverlayFactory(() => ready(emptyResult()));
    const done = vi.fn();
    const component = factory(
      { requestRender: () => {} },
      { fg: (color: string, text: string) => `{${color}:${text}}` },
      {},
      done,
    );
    const lines = component.render(80);
    expect(lines.some((line) => line.includes("{muted:[q] close}"))).toBe(true);
  });

  it("falls back to the no-op theme when the Pi theme is unusable", () => {
    const factory = makeOverlayFactory(() => ({ kind: "error", message: "boom" }));
    const component = factory({ requestRender: () => {} }, null, {}, vi.fn());
    const lines = component.render(80);
    expect(lines.join("\n")).toContain("⚠ Usage data unavailable");
    expect(lines.join("\n")).toContain("boom");
  });
});
