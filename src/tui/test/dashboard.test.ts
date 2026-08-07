/**
 * Overlay component tests: hero + metric slots + overlay trend main view,
 * five-column models view via `m`, outer frame, Esc back from models,
 * narrow stacking, and status-line keys.
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

/** Store with many models for the models-view table. */
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UsageDashboardComponent.render", () => {
  it("AC1: wide main view shows hero, icons, Requests/Cost, five metric slots, 使用趋势, and outer frame", async () => {
    const deps = await makeDeps();
    const component = new UsageDashboardComponent(deps);
    const lines = component.render(120);
    const text = lines.join("\n");

    expect(lines[0]).toMatch(/^┌─+┐$/);
    expect(lines[lines.length - 1]).toMatch(/^└─+┘$/);
    expect(lines.some((line) => line.startsWith("│") && line.endsWith("│"))).toBe(true);

    expect(text).toContain("Total tokens");
    expect(text).toContain("📚");
    expect(text).toContain("📨");
    expect(text).toContain("💰");
    expect(text).toContain("📥");
    expect(text).toContain("📤");
    expect(text).toContain("💾");
    expect(text).toContain("📖");
    expect(text).toContain("⚡");
    expect(text).toContain("📈");
    expect(text).toContain("Requests");
    expect(text).toContain("Cost");
    expect(text).toContain("Input");
    expect(text).toContain("Output");
    expect(text).toContain("Cache write");
    expect(text).toContain("Cache read");
    expect(text).toContain("Cache hit");
    expect(text).toContain("使用趋势");
    expect(text).toMatch(/\d{2}-\d{2} \d{2}:\d{2}\s+—\s+\d{2}-\d{2} \d{2}:\d{2}/);
    // Overlay legend (glyph forms) — not the old six independent trendBar rows.
    expect(text).toContain("Cost(·$)");
    expect(text).toContain("Cache write(+)");
    expect(text).toContain("Cache read(*)");
    expect(text).toContain("Input(o)");
    expect(text).toContain("Output(x)");
    expect(text).toContain("tokens ← | → cost($)");
    expect(text).not.toMatch(/\btotal\(/i);
    // Compact hero subtitle.
    expect(text).toMatch(/~\s+\d/);
    // Non-null hit rate shows percent + block bar on the wide Cache hit slot.
    expect(text).toMatch(/[\d.]+%\s*[█░]/);
    // Status line keys match real bindings (no [s], has [m]).
    expect(text).toContain("范围: 全局");
    expect(text).toContain("时间: 今天");
    expect(text).toContain("[p]项目 [g]全局 [m] models [t]时间 [ESC]back");
    expect(text).not.toContain("[q]");
    expect(text).not.toContain("[s]");
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(120);
    }
  });

  it("AC1/AC2: main view has no model table; m opens five-column models view with separators", async () => {
    const store = await makeManyModelStore(3);
    const component = new UsageDashboardComponent({ store, projectCwd: "/projects/p1" });
    const main = component.render(120).join("\n");
    expect(main).not.toContain("model-01");
    expect(main).not.toMatch(/\bModel\b.*\bRequests\b.*\bTokens\b.*\bTotal cost\b.*\bAvg cost\b/);

    component.handleInput("m");
    expect(component.currentViewMode).toBe("models");
    const models = component.render(120);
    const text = models.join("\n");
    const headerLine = models.find(
      (line) =>
        line.includes("Model") &&
        line.includes("Requests") &&
        line.includes("Tokens") &&
        line.includes("Total cost") &&
        line.includes("Avg cost"),
    );
    expect(headerLine).toBeDefined();
    expect(text).toContain("🤖");
    expect(text).toContain("model-01");
    expect(text).toContain("model-03");
    expect(text).toMatch(/\$\d+\.\d{4}/);
    expect(models.some((line) => /─{8,}/.test(line))).toBe(true);
    // Models view does not render hero / five slots / trend title.
    expect(text).not.toContain("Total tokens");
    expect(text).not.toContain("使用趋势");
    expect(models[0]).toMatch(/^┌─+┐$/);
    expect(models[models.length - 1]).toMatch(/^└─+┘$/);

    component.handleInput("m");
    expect(component.currentViewMode).toBe("main");
    expect(component.render(120).join("\n")).toContain("Total tokens");
  });

  it("AC2: models Avg cost shows $ when computable and -- when unavailable", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pi-tui-avg-"));
    tempDirs.push(storeDir);
    const store = new UsageStore({ storeDir });
    await store.init();
    const now = Date.now();
    // Two requests → Total $6.0000, Avg $3.0000.
    store.upsertRecord(
      makeRecord({
        sessionId: "s1",
        sourceEntryId: "a",
        model: "paid-pair",
        timestampMs: now,
        inputTokens: 10,
        recordedCost: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
      }),
    );
    store.upsertRecord(
      makeRecord({
        sessionId: "s1",
        sourceEntryId: "b",
        model: "paid-pair",
        timestampMs: now,
        inputTokens: 10,
        recordedCost: { input: 4, output: 0, cacheRead: 0, cacheWrite: 0, total: 4 },
      }),
    );
    // Requests without cost → Total/Avg both `--`.
    store.upsertRecord(
      makeRecord({
        sessionId: "s2",
        sourceEntryId: "c",
        model: "no-cost",
        timestampMs: now,
        inputTokens: 5,
      }),
    );

    const component = new UsageDashboardComponent({ store, projectCwd: "/projects/p1" });
    component.handleInput("m");
    const text = component.render(120).join("\n");
    const paidRow = text.split("\n").find((line) => line.includes("paid-pair"));
    const freeRow = text.split("\n").find((line) => line.includes("no-cost"));
    expect(paidRow).toBeDefined();
    expect(freeRow).toBeDefined();
    // Total then Avg on the paid row.
    expect(paidRow!).toMatch(/paid-pair.*\$6\.0000.*\$3\.0000/);
    // Unavailable cost → `--` for both Total cost and Avg cost.
    expect(freeRow!).toMatch(/no-cost.*--.*--/);
  });

  it("AC6: narrow models view keeps every row within width", async () => {
    const store = await makeManyModelStore(3);
    const component = new UsageDashboardComponent({ store, projectCwd: "/projects/p1" });
    component.handleInput("m");
    for (const width of [40, 10, 5]) {
      expect(() => component.render(width)).not.toThrow();
      const lines = component.render(width);
      for (const line of lines) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width);
      }
      if (width >= 8) {
        expect(lines[0]).toMatch(/^┌/);
        expect(lines[lines.length - 1]).toMatch(/^└/);
      } else {
        expect(lines[0]).not.toMatch(/^┌/);
      }
    }
  });

  it("emphasizes Cost via theme.selected on the main view", async () => {
    const deps = await makeDeps();
    // ANSI wrappers match production themes (zero display width).
    const theme = {
      normal: (t: string) => t,
      selected: (t: string) => `\u001b[1m${t}\u001b[0m`,
      error: (t: string) => t,
      muted: (t: string) => t,
    };
    const text = new UsageDashboardComponent(deps, theme).render(120).join("\n");
    // Cost may be `$…` or `--` depending on provenance mix; either is emphasized.
    expect(text).toMatch(/\u001b\[1m(\$|--)/);
    expect(text).toMatch(/\u001b\[1m[\d,]+\u001b\[0m/); // hero token count
    expect(text).toMatch(/\u001b\[1m[\d.]+%\u001b\[0m/); // cache hit %
  });

  it("AC4/AC5: narrow stacks vertically, keeps row widths, and shows hit bar or --", async () => {
    const deps = await makeDeps();
    const lines = new UsageDashboardComponent(deps).render(40);
    const text = lines.join("\n");

    const totalIdx = text.indexOf("Total tokens");
    const reqIdx = text.indexOf("Requests");
    const inputIdx = text.indexOf("Input");
    const hitIdx = text.indexOf("Cache hit");
    const trendIdx = text.indexOf("使用趋势");
    expect(totalIdx).toBeGreaterThanOrEqual(0);
    expect(reqIdx).toBeGreaterThan(totalIdx);
    expect(inputIdx).toBeGreaterThan(reqIdx);
    expect(hitIdx).toBeGreaterThan(inputIdx);
    expect(trendIdx).toBeGreaterThan(hitIdx);
    // Narrow uses symbol fallbacks, not wide emoji.
    expect(text).toContain("# Total tokens");
    expect(text).not.toContain("📚");
    // No side-by-side model table on main.
    expect(text).not.toContain("claude-sonnet");
    expect(text).not.toContain("gpt-5");
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
    }
    // Hit rate present as percent or -- with optional bar characters.
    expect(text).toMatch(/Cache hit\s+(--|[\d.]+%)/);
  });

  it("AC5: extremely narrow width still renders without throwing", async () => {
    const deps = await makeDeps();
    expect(() => new UsageDashboardComponent(deps).render(10)).not.toThrow();
    const lines = new UsageDashboardComponent(deps).render(10);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(10);
    }
  });

  it("skips the outer frame when width is below 8", async () => {
    const deps = await makeDeps();
    const lines = new UsageDashboardComponent(deps).render(5);
    expect(lines[0]).not.toMatch(/^┌/);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(5);
    }
  });

  it("AC4: zero-denominator cache hit renders as -- without a bar", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pi-tui-zerohit-"));
    tempDirs.push(storeDir);
    const store = new UsageStore({ storeDir });
    await store.init();
    // Zero input/cache tokens → cacheHitRate null.
    store.upsertRecord(
      makeRecord({
        sessionId: "s1",
        sourceEntryId: "e1",
        projectCwd: "/projects/p1",
        timestampMs: Date.now(),
        inputTokens: 0,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        recordedCost: { input: 0, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.1 },
      }),
    );
    const lines = new UsageDashboardComponent({ store, projectCwd: "/projects/p1" }).render(120);
    const labelIdx = lines.findIndex((line) => line.includes("Cache hit"));
    expect(labelIdx).toBeGreaterThanOrEqual(0);
    const valueLine = lines[labelIdx + 1]!;
    expect(valueLine).toContain("--");
    expect(valueLine).not.toMatch(/[█░]/);
  });

  it("TC3: zero-data state renders a meaningful message", async () => {
    const deps = await makeDeps();
    const store = new UsageStore({ storeDir: await mkdtemp(join(tmpdir(), "pi-tui-empty-")) });
    await store.init();
    const lines = new UsageDashboardComponent({ ...deps, store }).render(80);
    const text = lines.join("\n");
    expect(text).toContain("No usage data in the selected range.");
  });

  it("TC4: unavailable cost renders as --", async () => {
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
    expect(projectText).not.toContain("范围: 全局");
    expect(renderSpy).toHaveBeenCalled();

    component.handleInput("g");
    expect(component.currentScope).toBe("global");
  });

  it("AC3: s no longer toggles a curve-only page; trend stays on main", async () => {
    const deps = await makeDeps();
    const component = new UsageDashboardComponent(deps);
    expect(component.currentViewMode).toBe("main");
    const before = component.render(120).join("\n");
    expect(before).toContain("使用趋势");
    expect(before).toContain("Total tokens");

    component.handleInput("s");
    expect(component.currentViewMode).toBe("main");
    const after = component.render(120).join("\n");
    expect(after).toContain("使用趋势");
    expect(after).toContain("Total tokens");
  });

  it("AC7: Esc from models returns to main; Esc/q on main close once", async () => {
    const deps = await makeDeps();
    const onDone = vi.fn();
    const component = new UsageDashboardComponent(deps, undefined, onDone);

    component.handleInput("m");
    expect(component.currentViewMode).toBe("models");
    component.handleInput("\u001b");
    expect(component.currentViewMode).toBe("main");
    expect(onDone).not.toHaveBeenCalled();

    component.handleInput("m");
    component.handleInput("escape");
    expect(component.currentViewMode).toBe("main");
    expect(onDone).not.toHaveBeenCalled();

    component.handleInput("x");
    component.handleInput("q");
    expect(onDone).not.toHaveBeenCalled();
    component.handleInput("escape");
    expect(onDone).toHaveBeenCalledTimes(1);
    component.handleInput("q");
    component.handleInput("escape");
    component.handleInput("\u001b");
    expect(onDone).toHaveBeenCalledTimes(1);
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

  it("p/g/t keep the current viewMode", async () => {
    const deps = await makeDeps();
    const component = new UsageDashboardComponent(deps);
    component.handleInput("m");
    expect(component.currentViewMode).toBe("models");
    component.handleInput("t");
    expect(component.currentViewMode).toBe("models");
    component.handleInput("p");
    expect(component.currentViewMode).toBe("models");
    component.handleInput("g");
    expect(component.currentViewMode).toBe("models");
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
    expect(lines.some((line) => line.includes("{muted:") || line.includes("{normal:") || line.includes("{accent:"))).toBe(true);
  });

  it("falls back to the no-op theme when the Pi theme is unusable", async () => {
    const deps = await makeDeps();
    const factory = makeOverlayFactory(deps);
    const component = factory({ requestRender: () => {} }, null, {}, vi.fn());
    expect(() => component.render(80)).not.toThrow();
  });
});
