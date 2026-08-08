/**
 * Standalone viewer tests (`pi-usage`): scope parsing, the non-TTY text
 * summary, the ANSI theme fallback, and the component's external refresh
 * hook (`refreshNow`). The raw-mode TUI loop itself is verified manually on
 * a real terminal — CI skips interactive terminals by design.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageStore } from "../../storage";
import { makeRecord } from "../../storage/test/helpers";
import { noopTheme, UsageDashboardComponent } from "../../tui/dashboard";
import { ansiTheme, buildSummary, paintLines, parseScope, resolveTheme, UsageError } from "../main";

// --- Mock the Pi runtime module (UsageStore's constructor calls getAgentDir) -

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => process.env.PI_AGENT_DIR_TEST ?? "/tmp/pi-agent",
  SessionManager: {
    listAll: vi.fn(async () => []),
    open: vi.fn(() => ({ getEntries: () => [] })),
  },
}));

let storeDir: string;

beforeEach(async () => {
  process.env.PI_AGENT_DIR_TEST = await mkdtemp(join(tmpdir(), "pi-standalone-agent-"));
  storeDir = await mkdtemp(join(tmpdir(), "pi-standalone-store-"));
});

afterEach(() => {
  delete process.env.PI_AGENT_DIR_TEST;
  vi.restoreAllMocks();
});

// --- refreshNow ---------------------------------------------------------------

describe("UsageDashboardComponent.refreshNow", () => {
  it("re-queries the store and re-renders with data that landed after construction", async () => {
    const store = new UsageStore({ storeDir });
    await store.init();
    const now = Date.now();
    store.upsertRecord(
      makeRecord({ sessionId: "s1", sourceEntryId: "e1", timestampMs: now, inputTokens: 100, outputTokens: 50 }),
    );
    await store.persistLiveRecord();

    let renderCalls = 0;
    const component = new UsageDashboardComponent(
      { store, projectCwd: "", initialScope: "global" },
      noopTheme,
      () => {},
      () => {
        renderCalls += 1;
      },
    );
    expect(component.render(80).join("\n")).toContain("150"); // 100 input + 50 output

    // A second record lands after the component was constructed; the cached
    // render still shows the old totals until refreshNow() is invoked.
    store.upsertRecord(
      makeRecord({ sessionId: "s2", sourceEntryId: "e2", timestampMs: now, inputTokens: 200, outputTokens: 100 }),
    );
    await store.persistLiveRecord();
    expect(component.render(80).join("\n")).not.toContain("450"); // stale snapshot

    component.refreshNow();
    expect(component.render(80).join("\n")).toContain("450"); // 150 + 300
    expect(renderCalls).toBeGreaterThan(0);
    component.dispose();
  });

  it("paintLines renders the component frame for a given width (empty store)", async () => {
    const store = new UsageStore({ storeDir });
    await store.init();
    const component = new UsageDashboardComponent({ store, projectCwd: "", initialScope: "project" });
    const lines = paintLines(component, 80);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("No usage data in the selected range.");
    component.dispose();
  });
});

// --- CLI argument parsing -----------------------------------------------------

describe("parseScope", () => {
  it("no argument → global (default scope)", () => {
    expect(parseScope([])).toBe("global");
  });

  it("global / project map to their scopes", () => {
    expect(parseScope(["global"])).toBe("global");
    expect(parseScope(["project"])).toBe("project");
  });

  it("unknown or extra arguments are usage errors", () => {
    expect(() => parseScope(["refresh"])).toThrow(UsageError);
    expect(() => parseScope(["project", "global"])).toThrow(/Usage: pi-usage/);
  });
});

// --- Non-TTY text summary -----------------------------------------------------

describe("buildSummary", () => {
  it("prints the shared compact summary for a scope (project shows cwd)", async () => {
    const store = new UsageStore({ storeDir });
    await store.init();
    const now = Date.now();
    store.upsertRecord(
      makeRecord({
        sessionId: "s1",
        sourceEntryId: "e1",
        projectCwd: "/work/p1",
        timestampMs: now,
        inputTokens: 7,
        outputTokens: 3,
      }),
    );
    await store.persistLiveRecord();

    const text = buildSummary(store, "project", "/work/p1", now);
    expect(text).toContain("requests:");
    expect(text).toContain("scope:         project (/work/p1)");
    expect(text).toContain("total tokens:  10");
  });
});

// --- ANSI theme -----------------------------------------------------------------

describe("theme", () => {
  it("ansiTheme colors with pi accent semantics (cyan/red/grey)", () => {
    expect(ansiTheme.selected("x")).toBe("\x1b[36mx\x1b[0m");
    expect(ansiTheme.error("x")).toBe("\x1b[31mx\x1b[0m");
    expect(ansiTheme.muted("x")).toBe("\x1b[90mx\x1b[0m");
    expect(ansiTheme.normal("x")).toBe("x");
  });

  it("resolveTheme: NO_COLOR or TERM=dumb fall back to noopTheme", () => {
    expect(resolveTheme({})).toBe(ansiTheme);
    expect(resolveTheme({ NO_COLOR: "" })).toBe(noopTheme);
    expect(resolveTheme({ NO_COLOR: "1" })).toBe(noopTheme);
    expect(resolveTheme({ TERM: "dumb" })).toBe(noopTheme);
    expect(resolveTheme({ TERM: "xterm-256color" })).toBe(ansiTheme);
  });
});
