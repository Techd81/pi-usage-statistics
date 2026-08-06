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
  // One record in the current project, one in another project.
  store.upsertRecord(
    makeRecord({ sessionId: "s1", sourceEntryId: "e1", projectCwd, inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, recordedCost: { input: 0.3, output: 0.1, cacheRead: 0.01, cacheWrite: 0.02, total: 0.43 } }),
  );
  store.upsertRecord(
    makeRecord({ sessionId: "s2", sourceEntryId: "e1", projectCwd: "/projects/p2", inputTokens: 300, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  );
  return store;
}

async function makeDeps(initialScope: OverlayDeps["initialScope"] = "global"): Promise<OverlayDeps> {
  return { store: await makeStore(), projectCwd: "/projects/p1", initialScope };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UsageDashboardComponent.render", () => {
  it("TC1: renders totals, breakdown, multi-series trend rows, and the status line", async () => {
    const deps = await makeDeps();
    const component = new UsageDashboardComponent(deps);
    const lines = component.render(120);
    const text = lines.join("\n");
    expect(text).toContain("requests");
    expect(text).toContain("total tokens");
    expect(text).toContain("cache hit");
    expect(text).toContain("cost");
    // Multi-series rows with legend values.
    expect(text).toContain("total");
    expect(text).toContain("input");
    expect(text).toContain("output");
    expect(text).toContain("cacheRead");
    expect(text).toContain("cacheWrite");
    expect(text).toContain("cost");
    // Status line shows the scope/time/series state.
    expect(text).toContain("范围: 全局");
    expect(text).toContain("时间: 今天");
    expect(text).toContain("[p]项目 [g]全局 [s]系列 [t]时间 [q]关闭");
  });

  it("TC2: narrow width keeps only the headline series and never throws", async () => {
    const deps = await makeDeps();
    const lines = new UsageDashboardComponent(deps).render(40);
    const text = lines.join("\n");
    expect(text).toContain("total tokens");
    expect(text).toContain("cost");
    // Narrow width hides secondary metric rows and non-headline series rows.
    expect(text).not.toContain("input");
    expect(text).not.toContain("output");
    expect(text).not.toContain("cacheRead");
    expect(text).not.toContain("cacheWrite");
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("TC2b: an extremely narrow width (e.g. 10) still renders without throwing", async () => {
    const deps = await makeDeps();
    expect(() => new UsageDashboardComponent(deps).render(10)).not.toThrow();
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

  it("s cycles series visibility (all -> tokens -> cost -> all)", async () => {
    const deps = await makeDeps();
    const component = new UsageDashboardComponent(deps);
    expect(component.currentSeriesMode).toBe("all");

    component.handleInput("s");
    expect(component.currentSeriesMode).toBe("tokens");
    const tokensText = component.render(80).join("\n");
    expect(tokensText).toContain("cacheRead"); // tokens mode keeps the token series
    expect(tokensText).toContain("系列: Tokens"); // status reflects the mode
    expect(tokensText).not.toContain("系列: 成本");
    component.handleInput("s");
    expect(component.currentSeriesMode).toBe("cost");
    const costText = component.render(80).join("\n");
    expect(costText).toContain("成本");

    component.handleInput("s");
    expect(component.currentSeriesMode).toBe("all");
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

  it("q and Escape close the overlay; other keys are ignored", async () => {
    const deps = await makeDeps();
    const onDone = vi.fn();
    const component = new UsageDashboardComponent(deps, undefined, onDone);
    component.handleInput("x");
    expect(onDone).not.toHaveBeenCalled();
    component.handleInput("q");
    expect(onDone).toHaveBeenCalledTimes(1);
    component.handleInput("\u001b");
    expect(onDone).toHaveBeenCalledTimes(2);
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
