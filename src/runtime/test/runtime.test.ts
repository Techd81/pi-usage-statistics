/**
 * Runtime harness tests (RC1–RC5): the extension factory wired to a fake
 * ExtensionAPI, a temp-dir UsageStore, and a fake context.
 *
 * - RC1: one finalized assistant message -> exactly one normalized record
 *        with correct fields; re-delivery and rescanning never change totals.
 * - RC2: message_update is never subscribed, so streaming updates can never
 *        create records.
 * - RC3: /pi-usage-statistics runs in print/json modes without TUI-only APIs.
 * - RC4: session_shutdown flushes pending writes and stops runtime resources.
 * - RC5: scanner/collector failures are reported non-fatally; Pi continues.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  MessageEndEvent,
  SessionEntry,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { UsageFilters } from "../../domain";
import { DEFAULT_BUCKET_MS } from "../../domain";
import usageStatsExtension from "../../extension";
import { UsageStore } from "../../storage";
import { LIVE_REFRESH_DEBOUNCE_MS, UsageDashboardComponent } from "../../tui/dashboard";

// --- Mock the Pi runtime module (isolation for store dir + scanner) --------

const sessionFiles = new Map<string, SessionEntry[]>();
const sessionInfos: SessionInfo[] = [];

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => process.env.PI_AGENT_DIR_TEST ?? "/tmp/pi-agent",
  SessionManager: {
    listAll: vi.fn(async (_sessionDir?: string) => [...sessionInfos]),
    open: vi.fn((path: string) => ({
      getEntries: () => sessionFiles.get(path) ?? [],
    })),
  },
}));

// --- Harness helpers --------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown;
type RegisteredCommand = { name: string; options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } };

function makeHarness(): {
  api: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  commands: RegisteredCommand[];
} {
  const handlers = new Map<string, Handler[]>();
  const commands: RegisteredCommand[] = [];
  const api = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand: (name: string, options: RegisteredCommand["options"]) => commands.push({ name, options }),
  } as unknown as ExtensionAPI;
  return { api, handlers, commands };
}

async function fire<E extends { type: string }>(handlers: Map<string, Handler[]>, event: E, ctx: ExtensionContext): Promise<void> {
  for (const handler of handlers.get(event.type) ?? []) {
    await handler(event, ctx);
  }
}

function makeCtx(overrides: {
  mode?: ExtensionContext["mode"];
  sessionId?: string;
  sessionPath?: string;
  projectCwd?: string;
} = {}): ExtensionCommandContext {
  const ui = {
    notify: vi.fn(),
    custom: vi.fn(async () => {
      throw new Error("TUI-only API invoked in non-TUI mode");
    }),
    select: vi.fn(async () => undefined),
    confirm: vi.fn(async () => false),
    input: vi.fn(async () => undefined),
    setStatus: vi.fn(),
  } as unknown as ExtensionUIContext;
  return {
    ui,
    mode: overrides.mode ?? "print",
    hasUI: false,
    cwd: "/projects/p1",
    sessionManager: {
      getSessionId: () => overrides.sessionId ?? "s1",
      getSessionFile: () => overrides.sessionPath ?? "/sessions/s1.jsonl",
      getCwd: () => overrides.projectCwd ?? "/projects/p1",
    },
  } as unknown as ExtensionCommandContext;
}

const defaultFilters = (): UsageFilters => ({
  providers: [],
  models: [],
  projects: [],
  sessions: [],
  fromMs: 0,
  toMs: Number.POSITIVE_INFINITY,
  bucketMs: DEFAULT_BUCKET_MS,
  includeSummaryUsage: false,
});

const assistantMessageEndEvent = (
  responseId: string,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
): MessageEndEvent =>
  ({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: {
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
        totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
        cost: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375, total: 0.02205 },
      },
      responseId,
      stopReason: "stop",
      timestamp: 1_700_000_000_000,
    },
  }) as unknown as MessageEndEvent;

const toolResultMessageEndEvent = (toolCallId: string, input: number, output: number): MessageEndEvent =>
  ({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 1_700_000_001_000,
      usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  }) as unknown as MessageEndEvent;



class ThrowingStore extends UsageStore {
  override upsertRecord(): never {
    throw new Error("store boom");
  }
}

// --- Test file setup --------------------------------------------------------

let storeDir: string;
let sessionDir: string;

beforeEach(async () => {
  process.env.PI_AGENT_DIR_TEST = await mkdtemp(join(tmpdir(), "pi-runtime-agent-"));
  sessionDir = await mkdtemp(join(tmpdir(), "pi-runtime-sessions-"));
  storeDir = await mkdtemp(join(tmpdir(), "pi-runtime-store-"));
  sessionInfos.length = 0;
  sessionFiles.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PI_AGENT_DIR_TEST;
});

async function makeStore(): Promise<UsageStore> {
  const store = new UsageStore({ storeDir, sessionDir });
  return store;
}

const usageStatsCommand = (commands: RegisteredCommand[]): RegisteredCommand["options"]["handler"] =>
  commands.find((command) => command.name === "pi-usage-statistics")!.options.handler;

// --- RC1 / RC2 ---------------------------------------------------------------

describe("message_end collector", () => {
  it("RC1: one finalized assistant message records exactly one normalized record; re-delivery and rescan do not change totals", async () => {
    const store = await makeStore();
    const { api, handlers } = makeHarness();
    usageStatsExtension(api, { store, scanDebounceMs: 1_000_000 });
    const ctx = makeCtx();
    await fire(handlers, { type: "session_start", reason: "startup" }, ctx);

    const event = assistantMessageEndEvent("msg-1", { input: 100, output: 50, cacheRead: 20, cacheWrite: 10 });
    await fire(handlers, event, ctx);

    let result = store.query(defaultFilters());
    expect(result.totals.requestCount).toBe(1);
    expect(result.totals.inputTokens).toBe(100);
    expect(result.totals.outputTokens).toBe(50);
    expect(result.totals.cacheReadTokens).toBe(20);
    expect(result.totals.cacheWriteTokens).toBe(10);
    expect(result.totals.totalTokens).toBe(180);
    expect(result.totals.cacheHitRate).toBeCloseTo((20 / 130) * 100, 5);
    expect(result.totals.cost.status).toBe("recorded");
    expect(result.dimensions.providers).toEqual(["anthropic"]);
    expect(result.dimensions.models).toEqual(["claude-sonnet-4-5"]);

    // Re-delivery of the same finalized message upserts the same recordId.
    await fire(handlers, event, ctx);
    result = store.query(defaultFilters());
    expect(result.totals.requestCount).toBe(1);
    expect(result.totals.totalTokens).toBe(180);

    // Reconciliation scan (no session files) does not change totals.
    await store.refresh();
    result = store.query(defaultFilters());
    expect(result.totals.requestCount).toBe(1);
    expect(result.totals.inputTokens).toBe(100);
  });

  it("RC1b: assistant messages without usage still count as requests (zero tokens)", async () => {
    const store = await makeStore();
    const { api, handlers } = makeHarness();
    usageStatsExtension(api, { store, scanDebounceMs: 1_000_000 });
    const ctx = makeCtx();
    const event = {
      type: "message_end",
      message: { role: "assistant", content: [], provider: "anthropic", model: "claude-sonnet-4-5", responseId: "msg-nou", stopReason: "error", timestamp: 1_700_000_000_000 },
    } as unknown as MessageEndEvent;
    await fire(handlers, event, ctx);
    const result = store.query(defaultFilters());
    expect(result.totals.requestCount).toBe(1);
    expect(result.totals.totalTokens).toBe(0);
    expect(result.totals.cost.status).toBe("unavailable");
  });

  it("RC1c: toolResult usage is recorded separately as summary usage (included only per query flag)", async () => {
    const store = await makeStore();
    const { api, handlers } = makeHarness();
    usageStatsExtension(api, { store, scanDebounceMs: 1_000_000 });
    const ctx = makeCtx();
    await fire(handlers, assistantMessageEndEvent("msg-2", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }), ctx);
    await fire(handlers, toolResultMessageEndEvent("call-1", 30, 15), ctx);

    const withoutSummaries = store.query(defaultFilters());
    expect(withoutSummaries.totals.requestCount).toBe(1);
    expect(withoutSummaries.totals.inputTokens).toBe(10);

    const withSummaries = store.query({ ...defaultFilters(), includeSummaryUsage: true });
    expect(withSummaries.totals.inputTokens).toBe(40);
    expect(withSummaries.totals.requestCount).toBe(1); // summaries never add requests
  });

  it("RC1d: a live record and a scan of the same message share one recordId (responseId identity)", async () => {
    const store = await makeStore();
    const { api, handlers } = makeHarness();
    usageStatsExtension(api, { store, scanDebounceMs: 1_000_000 });
    const ctx = makeCtx();
    await fire(handlers, { type: "session_start", reason: "startup" }, ctx);

    await fire(handlers, assistantMessageEndEvent("resp-1", { input: 100, output: 50, cacheRead: 20, cacheWrite: 10 }), ctx);

    // The same message now exists in the session file — but with Pi's
    // entry.id (8-char hex), NOT the provider responseId. The scanner must
    // upsert the SAME recordId (via the shared responseId rule), otherwise
    // the message counts twice and reconciliation changes totals (RC1).
    const sessionPath = "/sessions/s1.jsonl";
    sessionInfos.push({ path: sessionPath, id: "s1", cwd: "/projects/p1", created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "", allMessagesText: "" });
    sessionFiles.set(sessionPath, [
      {
        type: "message",
        id: "a1b2c3d4",
        parentId: null,
        timestamp: "2026-08-06T00:01:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 180, cost: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375, total: 0.02205 } },
          responseId: "resp-1",
          stopReason: "stop",
          timestamp: 1_700_000_000_000,
        },
      } as SessionEntry,
    ]);

    await store.refresh();
    const result = store.query(defaultFilters());
    expect(result.totals.requestCount).toBe(1);
    expect(result.totals.totalTokens).toBe(180);
    expect(result.dimensions.sessions).toEqual(["s1"]);
  });

  it("RC1e: messages without a responseId still share one identity between live and scan", async () => {
    const store = await makeStore();
    const { api, handlers } = makeHarness();
    usageStatsExtension(api, { store, scanDebounceMs: 1_000_000 });
    const ctx = makeCtx();

    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fingerprint me" }],
        provider: "openai",
        model: "gpt-4o",
        usage: { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 1_700_000_000_000,
        // no responseId: identity must fall back to timestamp+content fingerprint
      },
    } as unknown as MessageEndEvent;
    await fire(handlers, event, ctx);

    const sessionPath = "/sessions/s1.jsonl";
    sessionInfos.push({ path: sessionPath, id: "s1", cwd: "/projects/p1", created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "", allMessagesText: "" });
    sessionFiles.set(sessionPath, [
      {
        type: "message",
        id: "deadbeef",
        parentId: null,
        timestamp: "2026-08-06T00:01:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "fingerprint me" }],
          provider: "openai",
          model: "gpt-4o",
          usage: { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: 1_700_000_000_000,
        },
      } as SessionEntry,
    ]);

    await store.refresh();
    const result = store.query(defaultFilters());
    expect(result.totals.requestCount).toBe(1);
    expect(result.totals.totalTokens).toBe(20);
  });

  it("RC2: message_update is never subscribed, so streaming updates cannot create records", async () => {
    const store = await makeStore();
    const { api, handlers } = makeHarness();
    usageStatsExtension(api, { store, scanDebounceMs: 1_000_000 });
    expect(handlers.has("message_update")).toBe(false);
    expect(handlers.has("message_end")).toBe(true);

    const ctx = makeCtx();
    // A message_update event dispatched to the runtime reaches no handler.
    await fire(handlers, { type: "message_update", message: assistantMessageEndEvent("msg-3", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }).message }, ctx);
    expect(store.query(defaultFilters()).totals.requestCount).toBe(0);
  });
});

// --- RC3 / RC6 ----------------------------------------------------------------

describe("/pi-usage-statistics command", () => {
  it("RC3: runs in print/json modes without invoking TUI-only APIs", async () => {
    const store = await makeStore();
    const { api, commands } = makeHarness();
    usageStatsExtension(api, { store, scanDebounceMs: 1_000_000 });
    const handler = usageStatsCommand(commands);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      for (const mode of ["print", "json"] as const) {
        const ctx = makeCtx({ mode });
        await handler("", ctx);
        await handler("refresh", ctx);
        await handler("project", ctx);
        await handler("global", ctx);
        // The fake custom() throws when called; reaching here proves no
        // TUI-only API was invoked in either mode.
        expect(ctx.ui.custom).not.toHaveBeenCalled();
      }
      // print mode surfaces text on stdout, json mode stays silent.
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("requests:"));
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("Scan finished:"));
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("TC5: TUI mode opens the embedded custom UI; print mode never does", async () => {
    const store = await makeStore();
    const { api, commands } = makeHarness();
    usageStatsExtension(api, { store, scanDebounceMs: 1_000_000 });
    const handler = usageStatsCommand(commands);

    const printCtx = makeCtx({ mode: "print" });
    await handler("", printCtx);
    expect(vi.mocked(printCtx.ui.custom)).not.toHaveBeenCalled();

    // Embedded custom UI is the default; no floating overlay options are passed.
    const tuiCtx = makeCtx({ mode: "tui" });
    await handler("", tuiCtx);
    expect(vi.mocked(tuiCtx.ui.custom)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tuiCtx.ui.custom)).toHaveBeenCalledWith(expect.any(Function));
  });

  it("TC6: an open dashboard hot-updates on message_end (debounced) and unsubscribes on close", async () => {
    const store = await makeStore();
    const { api, handlers, commands } = makeHarness();
    usageStatsExtension(api, { store, scanDebounceMs: 1_000_000 });
    const handler = usageStatsCommand(commands);
    const ctx = makeCtx({ mode: "tui" });

    // One message before the dashboard opens.
    await fire(handlers, assistantMessageEndEvent("resp-0", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }), ctx);

    // Open the dashboard: the custom() mock materializes the component so the
    // factory's live subscription is active.
    let component: UsageDashboardComponent | undefined;
    const requestRender = vi.fn();
    (ctx.ui as { custom: unknown }).custom = vi.fn(async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: null) => void) => UsageDashboardComponent) => {
      component = factory({ requestRender }, null, {}, () => {});
    });
    await handler("", ctx);
    expect(component).toBeDefined();
    // Cycle to 全部 so the fixed 1_700_000_000_000 event timestamps are in range.
    for (let i = 0; i < 6; i++) component!.handleInput("t");
    expect(component!.render(80).join("\n")).toContain("150"); // 100 input + 50 output

    // A new record while the dashboard is open: debounced refresh kicks in.
    vi.useFakeTimers();
    await fire(handlers, assistantMessageEndEvent("resp-1", { input: 200, output: 100, cacheRead: 0, cacheWrite: 0 }), ctx);
    expect(component!.render(80).join("\n")).toContain("150"); // not yet refreshed
    vi.advanceTimersByTime(LIVE_REFRESH_DEBOUNCE_MS);
    expect(component!.render(80).join("\n")).toContain("450"); // 150 + 300
    expect(requestRender).toHaveBeenCalled();

    // Esc closes and unsubscribes: further events stop refreshing the closed component.
    component!.handleInput("\u001b");
    const closedRender = component!.render(80).join("\n");
    await fire(handlers, assistantMessageEndEvent("resp-2", { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }), ctx);
    vi.advanceTimersByTime(LIVE_REFRESH_DEBOUNCE_MS);
    expect(component!.render(80).join("\n")).toBe(closedRender);
    vi.useRealTimers();
  });

  it("TC7: collector failure does not hot-refresh the open dashboard (no record) and never escapes", async () => {
    const brokenStore = new ThrowingStore({ storeDir, sessionDir });
    const { api, handlers, commands } = makeHarness();
    usageStatsExtension(api, { store: brokenStore, scanDebounceMs: 1_000_000 });
    const handler = usageStatsCommand(commands);
    const ctx = makeCtx({ mode: "tui" });

    let component: UsageDashboardComponent | undefined;
    const requestRender = vi.fn();
    (ctx.ui as { custom: unknown }).custom = vi.fn(async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: null) => void) => UsageDashboardComponent) => {
      component = factory({ requestRender }, null, {}, () => {});
    });
    await handler("", ctx);
    expect(component).toBeDefined();

    vi.useFakeTimers();
    await expect(fire(handlers, assistantMessageEndEvent("boom", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), ctx)).resolves.toBeUndefined();
    expect(vi.mocked(ctx.ui.notify)).toHaveBeenCalledWith(expect.stringContaining("collect usage failed"), "error");
    // Nothing was collected, so the open dashboard must NOT be scheduled for refresh.
    vi.advanceTimersByTime(LIVE_REFRESH_DEBOUNCE_MS);
    expect(requestRender).not.toHaveBeenCalled();
    vi.useRealTimers();
    component!.dispose();
  });

});

// --- RC4 / RC5 ----------------------------------------------------------------

describe("lifecycle and error pathway", () => {
  it("RC4: session_shutdown flushes pending writes and stops runtime resources", async () => {
    const store = await makeStore();
    const { api, handlers } = makeHarness();
    usageStatsExtension(api, { store, scanDebounceMs: 1_000_000 });
    const ctx = makeCtx();
    await fire(handlers, { type: "session_start", reason: "startup" }, ctx);
    await fire(handlers, assistantMessageEndEvent("msg-4", { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }), ctx);

    // The record is in memory; nothing is on disk until a flush.
    const before = await readFile(join(storeDir, "records.jsonl"), "utf8").catch(() => "");
    expect(before).not.toContain("msg-4");

    await fire(handlers, { type: "session_shutdown", reason: "quit" }, ctx);

    const after = await readFile(join(storeDir, "records.jsonl"), "utf8");
    expect(after).toContain("msg-4");
  });

  it("RC5a: a background scan failure is reported non-fatally and Pi continues", async () => {
    const store = await makeStore();
    const { api, handlers } = makeHarness();
    usageStatsExtension(api, { store, scanDebounceMs: 0 });
    const ctx = makeCtx();

    // The UsageStore degrades a SessionManager.listAll failure into a
    // non-fatal sessionErrors summary, so to exercise the extension's
    // notifyError pathway we make the scan itself throw.
    const refreshSpy = vi.spyOn(store, "refresh").mockRejectedValueOnce(new Error("scan boom"));

    await fire(handlers, { type: "session_start", reason: "startup" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the debounced scan fire

    const errorCalls = vi.mocked(ctx.ui.notify).mock.calls.filter(([, type]) => type === "error");
    expect(errorCalls.length).toBeGreaterThan(0);
    expect(String(errorCalls[0]![0])).toContain("background scan failed");
    refreshSpy.mockRestore();

    // Pi continues: message_end still records usage.
    await fire(handlers, assistantMessageEndEvent("msg-5", { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 }), ctx);
    expect(store.query(defaultFilters()).totals.requestCount).toBe(1);
  });

  it("RC5b: a collector failure never propagates into Pi", async () => {
    const brokenStore = new ThrowingStore({ storeDir, sessionDir });
    const { api, handlers } = makeHarness();
    usageStatsExtension(api, { store: brokenStore, scanDebounceMs: 1_000_000 });
    const ctx = makeCtx();

    await expect(fire(handlers, assistantMessageEndEvent("msg-6", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), ctx)).resolves.toBeUndefined();
    expect(vi.mocked(ctx.ui.notify)).toHaveBeenCalledWith(expect.stringContaining("collect usage failed"), "error");
  });

});
