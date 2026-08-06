/**
 * Scope / series / time-range behavior tests (AC6/AC7/AC8): the single
 * `filtersFor` decode point, the command argument resolution, and the
 * project-scope filter narrowing.
 */
import { describe, expect, it, vi } from "vitest";
import { filtersFor, type Scope, type TimeRange } from "../dashboard";
import { runUsageStatsCommand, projectCwd } from "../../runtime/commands";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { UsageStore } from "../../storage";
import { makeRecord } from "../../storage/test/helpers";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = Date.now();

describe("filtersFor (single decode point)", () => {
  it("global scope keeps projects empty and honors the time window", () => {
    const filters = filtersFor("global", "all", "/projects/p1", NOW);
    expect(filters.projects).toEqual([]);
    expect(filters.fromMs).toBe(0);
    expect(filters.toMs).toBe(NOW);
  });

  it("project scope narrows to the current cwd", () => {
    const filters = filtersFor("project", "all", "/projects/p1", NOW);
    expect(filters.projects).toEqual(["/projects/p1"]);
  });

  it("project scope with an empty cwd stays unfiltered (safe fallback)", () => {
    const filters = filtersFor("project", "all", "", NOW);
    expect(filters.projects).toEqual([]);
  });

  it("today starts at the local midnight", () => {
    const filters = filtersFor("global", "today", "", NOW);
    const midnight = new Date(NOW);
    midnight.setHours(0, 0, 0, 0);
    expect(filters.fromMs).toBe(midnight.getTime());
  });

  it("7d / 30d compute relative windows", () => {
    expect(filtersFor("global", "7d", "", NOW).fromMs).toBe(NOW - 7 * 86_400_000);
    expect(filtersFor("global", "30d", "", NOW).fromMs).toBe(NOW - 30 * 86_400_000);
  });
});

describe("projectCwd", () => {
  it("prefers the session manager cwd and falls back to ctx.cwd", () => {
    const ctx = {
      cwd: "/fallback",
      sessionManager: { getCwd: () => "/projects/p1" },
    } as unknown as ExtensionCommandContext;
    expect(projectCwd(ctx)).toBe("/projects/p1");

    const noManager = { cwd: "/fallback" } as unknown as ExtensionCommandContext;
    expect(projectCwd(noManager)).toBe("/fallback");
  });
});

describe("runUsageStatsCommand argument resolution", () => {
  it("rejects unknown arguments non-fatally", async () => {
    const store = new UsageStore({ storeDir: await mkdtemp(join(tmpdir(), "pi-arg-")) });
    await store.init();
    const ctx = {
      mode: "print",
      ui: { notify: () => {}, custom: () => {} },
      cwd: "/projects/p1",
      sessionManager: { getCwd: () => "/projects/p1", getSessionId: () => "s1", getSessionFile: () => "" },
    } as unknown as ExtensionCommandContext;
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runUsageStatsCommand({ store }, "bogus", ctx);
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("unknown argument"));
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("project argument prints a project-scoped summary in print mode", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pi-arg2-"));
    const store = new UsageStore({ storeDir });
    await store.init();
    store.upsertRecord(makeRecord({ sessionId: "s1", sourceEntryId: "e1", projectCwd: "/projects/p1", inputTokens: 100, outputTokens: 50, recordedCost: { input: 0.3, output: 0.1, cacheRead: 0.01, cacheWrite: 0.02, total: 0.43 } }));
    store.upsertRecord(makeRecord({ sessionId: "s2", sourceEntryId: "e1", projectCwd: "/projects/p2", inputTokens: 999, outputTokens: 1 }));

    const ctx = {
      mode: "print",
      ui: { notify: () => {}, custom: () => {} },
      cwd: "/projects/p1",
      sessionManager: { getCwd: () => "/projects/p1", getSessionId: () => "s1", getSessionFile: () => "" },
    } as unknown as ExtensionCommandContext;

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runUsageStatsCommand({ store }, "project", ctx);
      const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(output).toContain("scope:         project");
      expect(output).toContain("projects/p1");
      expect(output).toContain("total tokens:  150"); // only the p1 record (100+50)
      expect(output).not.toContain("1,000");
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("global (default) prints all records", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "pi-arg3-"));
    const store = new UsageStore({ storeDir });
    await store.init();
    store.upsertRecord(makeRecord({ sessionId: "s1", sourceEntryId: "e1", projectCwd: "/projects/p1", inputTokens: 100, outputTokens: 50, recordedCost: { input: 0.3, output: 0.1, cacheRead: 0.01, cacheWrite: 0.02, total: 0.43 } }));
    store.upsertRecord(makeRecord({ sessionId: "s2", sourceEntryId: "e1", projectCwd: "/projects/p2", inputTokens: 999, outputTokens: 1 }));

    const ctx = {
      mode: "print",
      ui: { notify: () => {}, custom: () => {} },
      cwd: "/projects/p1",
      sessionManager: { getCwd: () => "/projects/p1", getSessionId: () => "s1", getSessionFile: () => "" },
    } as unknown as ExtensionCommandContext;

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runUsageStatsCommand({ store }, "", ctx);
      const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(output).toContain("scope:         global");
      expect(output).toContain("total tokens:  1150"); // p1 (150) + p2 (1000)
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

// Keep Scope/TimeRange type usage so the exports stay covered by the compiler.
const _scopeTypes: Scope[] = ["global", "project"];
const _rangeTypes: TimeRange[] = ["today", "7d", "30d", "all"];
void _scopeTypes;
void _rangeTypes;
