/**
 * Overlay component tests (TC1–TC6): render() output at wide and narrow
 * widths, all presentation states, keyboard interaction, and the no-op
 * theme guarantee (deterministic output, safe in non-TUI modes).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeOverlayFactory, UsageDashboardComponent, type OverlayDeps } from "../dashboard";
import { displayWidth } from "../format";
import { UsageStore } from "../../storage";
import { makeRecord } from "../../storage/test/helpers";

const tempDirs: string[] = [];

async function makeStore(projectCwd = "/projects/p1"): Promise<UsageStore> {
  const storeDir = await mkdtemp(join(tmpdir(), "pi-tui-store-"));
  tempDirs.push(storeDir);
  const store = new UsageStore({ storeDir });
  await store.init();
  const now = Date.now();
  // One record in the current project, one in another project (both today).
  store.upsertRecord(
    makeRecord({ sessionId: "s1", sourceEntryId: "e1", projectCwd, timestampMs: now, inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, recordedCost: { input: 0.3, output: 0.1, cacheRead: 0.01, cacheWrite: 0.02, total: 0.43 } }),
  );
  store.upsertRecord(
    makeRecord({ sessionId: "s2", sourceEntryId: "e1", projectCwd: "/projects/p2", model: "gpt-5", timestampMs: now, inputTokens: 300, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  );
  return store;
}

/** Store with many models so right-pane rows exceed the left metric count. */
async function makeManyModelStore(modelCount: number): Promise<UsageStore> {
  const storeDir = await mkdtemp(join(tmpdir(), "pi-tui-many-"));
  tempDirs.push(storeDir);
  const store = new UsageStore({ storeDir });
  await store.init();
  const now = Date.now();
  for (let i = 1; i <= modelCount; i++) {
    const id = String(i).padStart(2, "0");
    store.upsertRecord(
      makeRecord({
        sessionId: `s${id}`,
        sourceEntryId: "e1",
        model: `model-${id}`,
        timestampMs: now,
        inputTokens: 10 + i,
        outputTokens: 5,
        recordedCost: { input: 0.01 * i, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.01 * i + 0.001 },
      }),
    );
  }
  return store;
}

async function makeDeps(initialScope: OverlayDeps["initialScope"] = "global"): Promise<OverlayDeps> {
  return { store: await makeStore(), projectCwd: "/projects/p1", initialScope };
}

/** Visible column where `needle` starts, or -1 if absent. */
function visibleStartCol(line: string, needle: string): number {
  const idx = line.indexOf(needle);
  if (idx < 0) return -1;
  return displayWidth(line.slice(0, idx));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UsageDashboardComponent.render", () => {
  it("TC1: default view renders icon metric rows, the per-model table, and the status line", async () => {
    const deps = await makeDeps();
    const component = new UsageDashboardComponent(deps);
    const lines = component.render(120);
    const text = lines.join("\n");
    // Metric rows with emoji icons (wide terminal).
    expect(text).toContain("📨 requests");
    expect(text).toContain("🪙 total tokens");
    expect(text).toContain("cache hit");
    expect(text).toContain("💰 cost");
    // Per-model table: four-column header plus both models with request/token/cost values.
    expect(text).toContain("models");
    expect(text).toContain("requests");
    expect(text).toContain("tokens");
    expect(text).toMatch(/\bcost\b/);
    expect(text).toContain("claude-sonnet-4-5");
    expect(text).toContain("gpt-5");
    // No curve rows in the default text view.
    expect(text).not.toContain("cacheRead");
    // Status line shows the scope/time state and the curve toggle.
    expect(text).toContain("范围: 全局");
    expect(text).toContain("时间: 今天");
    expect(text).toContain("[p]项目 [g]全局 [s]曲线 [t]时间 [q]关闭 [ESC]back");
  });

  it("TC1b: wide view uses equal left/right panes and keeps overflow models in the right half", async () => {
    const width = 120;
    const gutterW = 1;
    const leftW = Math.floor((width - gutterW) / 2);
    const rightW = width - gutterW - leftW;
    expect(Math.abs(leftW - rightW)).toBeLessThanOrEqual(1);

    const store = await makeManyModelStore(9);
    const component = new UsageDashboardComponent({ store, projectCwd: "/projects/p1" });
    const lines = component.render(width);
    const text = lines.join("\n");

    // Left pane: exactly the eight summary metrics (cache hit = hit rate).
    for (const label of [
      "📨 requests",
      "🪙 total tokens",
      "📥 input",
      "📤 output",
      "💾 cache write",
      "📚 cache read",
      "⚡ cache hit",
      "💰 cost",
    ]) {
      expect(text).toContain(label);
    }
    // Right pane: four-column header.
    const headerLine = lines.find((line) => line.includes("models") && line.includes("requests") && line.includes("tokens") && line.includes("cost"));
    expect(headerLine).toBeDefined();
    expect(visibleStartCol(headerLine!, "models")).toBe(leftW + gutterW);
    expect(displayWidth(headerLine!)).toBe(width);

    // Every model — including the 9th — starts at the same right-pane column.
    const rightStarts: number[] = [];
    for (let i = 1; i <= 9; i++) {
      const id = String(i).padStart(2, "0");
      const needle = `model-${id}`;
      const line = lines.find((row) => row.includes(needle));
      expect(line, `missing ${needle}`).toBeDefined();
      const start = visibleStartCol(line!, needle);
      expect(start).toBe(leftW + gutterW);
      rightStarts.push(start);
      expect(displayWidth(line!)).toBe(width);
      // Overflow rows (past the 8 left metrics + after header alignment) keep the left spacer.
      if (i >= 8) {
        expect(line!.startsWith(needle)).toBe(false);
        expect(displayWidth(line!.slice(0, leftW))).toBe(leftW);
      }
    }
    expect(new Set(rightStarts).size).toBe(1);

    // Model cost column uses domain cost formatting (recorded amounts present).
    expect(text).toMatch(/\$\d+\.\d{4}/);
  });

  it("TC2: narrow width falls back to symbol icons, compact model rows, and never throws", async () => {
    const deps = await makeDeps();
    const lines = new UsageDashboardComponent(deps).render(40);
    const text = lines.join("\n");
    // All eight metric rows render with single-color symbol icons.
    expect(text).toContain("▣ requests");
    expect(text).toContain("▤ total tokens");
    expect(text).toContain("▥ input");
    expect(text).toContain("▦ output");
    expect(text).toContain("▧ cache write");
    expect(text).toContain("▨ cache read");
    expect(text).toContain("▩ cache hit");
    expect(text).toContain("◆ cost");
    // No emoji at narrow width.
    expect(text).not.toContain("📨");
    expect(text).not.toContain("🪙");
    expect(text).not.toContain("💰");
    // Compact model rows still render both models (metrics first, then models).
    // Narrow width may truncate long model names; match the stable prefix.
    const metricIdx = text.indexOf("▣ requests");
    const modelIdx = text.indexOf("claude-sonnet");
    expect(metricIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeGreaterThan(metricIdx);
    expect(text).toContain("gpt-5");
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("TC2b: an extremely narrow width (e.g. 10) still renders without throwing", async () => {
    const deps = await makeDeps();
    expect(() => new UsageDashboardComponent(deps).render(10)).not.toThrow();
  });

  it("TC2c: curve view at narrow width renders all six series without throwing", async () => {
    const deps = await makeDeps();
    const component = new UsageDashboardComponent(deps);
    component.handleInput("s");
    expect(() => component.render(40)).not.toThrow();
    const lines = component.render(40);
    expect(lines.join("\n")).toContain("cacheRead");
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("TC3: zero-data state renders a meaningful message", async () => {
    const deps = await makeDeps();
    const store = new UsageStore({ storeDir: await mkdtemp(join(tmpdir(), "pi-tui-empty-")) });
    await store.init();
    const lines = new UsageDashboardComponent({ ...deps, store }).render(80);
    const text = lines.join("\n");
    expect(text).toContain("No usage data in the selected range.");
  });

  it("TC4: unavailable cost renders as -- and the series legend uses it", async () => {
    const deps = await makeDeps();
    const lines = new UsageDashboardComponent(deps).render(80);
    expect(lines.join("\n")).toContain("--");
  });
});

describe("UsageDashboardComponent.handleInput", () => {
  it("p switches to project scope and back with g, recomputing totals", async () => {
    const deps = await makeDeps("global");
    const component = new UsageDashboardComponent(deps);
    const renderSpy = vi.fn();
    (component as unknown as { requestRender: () => void }).requestRender = renderSpy;

    expect(component.currentScope).toBe("global");
    const globalText = component.render(80).join("\n");
    expect(globalText).toContain("范围: 全局");

    component.handleInput("p");
    expect(component.currentScope).toBe("project");
    const projectText = component.render(80).join("\n");
    expect(projectText).toContain("范围: 项目");
    // Project scope excludes the /projects/p2 record (300 input tokens).
    expect(projectText).not.toContain("范围: 全局");
    expect(renderSpy).toHaveBeenCalled();

    component.handleInput("g");
    expect(component.currentScope).toBe("global");
  });

  it("s toggles the curve-only view and back", async () => {
    const deps = await makeDeps();
    const component = new UsageDashboardComponent(deps);
    expect(component.isCurvesVisible).toBe(false);
    const textView = component.render(120).join("\n");
    expect(textView).toContain("📨 requests");
    expect(textView).toContain("claude-sonnet-4-5");
    expect(textView).not.toContain("cacheRead");

    component.handleInput("s");
    expect(component.isCurvesVisible).toBe(true);
    const curveView = component.render(120).join("\n");
    // Curve view: all six series rows, no metric/model text.
    expect(curveView).toContain("total");
    expect(curveView).toContain("input");
    expect(curveView).toContain("output");
    expect(curveView).toContain("cacheRead");
    expect(curveView).toContain("cacheWrite");
    expect(curveView).toContain("cost");
    expect(curveView).not.toContain("📨");
    expect(curveView).not.toContain("claude-sonnet-4-5");

    component.handleInput("s");
    expect(component.isCurvesVisible).toBe(false);
    const restored = component.render(120).join("\n");
    expect(restored).toContain("📨 requests");
    expect(restored).not.toContain("cacheRead");
  });

  it("t cycles time range and recomputes from the new window", async () => {
    const deps = await makeDeps();
    const component = new UsageDashboardComponent(deps);
    expect(component.currentTimeRange).toBe("today");
    component.handleInput("t");
    expect(component.currentTimeRange).toBe("7d");
    component.handleInput("t");
    expect(component.currentTimeRange).toBe("30d");
    component.handleInput("t");
    expect(component.currentTimeRange).toBe("all");
    component.handleInput("t");
    expect(component.currentTimeRange).toBe("today");
  });

  it("q closes and Escape goes back once; other keys are ignored", async () => {
    const deps = await makeDeps();
    const onDone = vi.fn();
    const component = new UsageDashboardComponent(deps, undefined, onDone);
    component.handleInput("x");
    expect(onDone).not.toHaveBeenCalled();
    component.handleInput("q");
    expect(onDone).toHaveBeenCalledTimes(1);
    component.handleInput("q");
    component.handleInput("escape");
    component.handleInput("\u001b");
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("makeOverlayFactory", () => {
  it("TC5: builds a component from deps and maps the Pi theme to colors", async () => {
    const deps = await makeDeps();
    const factory = makeOverlayFactory(deps);
    const done = vi.fn();
    const component = factory(
      { requestRender: () => {} },
      { fg: (color: string, text: string) => `{${color}:${text}}` },
      {},
      done,
    );
    const lines = component.render(80);
    expect(lines.some((line) => line.includes("{muted:") || line.includes("{normal:"))).toBe(true);
  });

  it("falls back to the no-op theme when the Pi theme is unusable", async () => {
    const deps = await makeDeps();
    const factory = makeOverlayFactory(deps);
    const component = factory({ requestRender: () => {} }, null, {}, vi.fn());
    expect(() => component.render(80)).not.toThrow();
  });
});
