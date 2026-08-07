/**
 * `/pi-usage-statistics` command implementation (design §6).
 *
 * Arguments:
 * - (none)   -> default scope `global`; TUI mode opens the interactive
 *               embedded dashboard, other modes print a text summary;
 * - `project`-> scope `project` (records of the current working directory);
 * - `global` -> scope `global` (all locally stored sessions).
 *
 * Mode guards: `ctx.ui.custom()` runs only in `tui` mode; TUI/rpc modes
 * receive notifications, print mode writes plain text to stdout, json mode
 * stays silent so the JSON event stream is never corrupted. All failures are
 * reported non-fatally.
 */
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageFilters, UsageQueryResult } from "../domain";
import { DEFAULT_BUCKET_MS } from "../domain";
import type { ScanSummary, UsageStore } from "../storage";
import { formatCompactSummary, formatScanSummary } from "./format";
import type { Scope } from "../tui/dashboard";

export type { Scope } from "../tui/dashboard";

export type CommandDependencies = {
  store: UsageStore;
};

const DEFAULT_FILTERS = (): UsageFilters => ({
  providers: [],
  models: [],
  projects: [],
  sessions: [],
  fromMs: 0,
  toMs: Number.POSITIVE_INFINITY,
  bucketMs: DEFAULT_BUCKET_MS,
  includeSummaryUsage: false,
});

/** Current working directory for project-scoped queries. */
export const projectCwd = (ctx: ExtensionContext): string => {
  try {
    return ctx.sessionManager?.getCwd() ?? ctx.cwd ?? "";
  } catch {
    return ctx.cwd ?? "";
  }
};

/** Build query filters for a scope; project limits records to the cwd. */
export const filtersForScope = (scope: Scope, ctx: ExtensionContext): UsageFilters => {
  const filters = DEFAULT_FILTERS();
  if (scope === "project") {
    const cwd = projectCwd(ctx);
    if (cwd !== "") filters.projects = [cwd];
  }
  return filters;
};

/**
 * Mode-aware text output: TUI/rpc notify, print stdout, json silent (stdout
 * carries the JSON event stream in json mode and must not be polluted).
 */
export function presentText(ctx: ExtensionContext, text: string): void {
  switch (ctx.mode) {
    case "tui":
    case "rpc":
      ctx.ui.notify(text, "info");
      return;
    case "print":
      process.stdout.write(`${text}\n`);
      return;
    case "json":
      return;
  }
}

function presentError(ctx: ExtensionCommandContext, action: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  const message = `pi-usage-statistics: ${action} failed: ${detail}`;
  console.error(`[pi-usage-statistics] ${action} failed: ${detail}`);
  if (ctx.mode === "print") {
    process.stdout.write(`${message}\n`);
  } else {
    try {
      ctx.ui.notify(message, "error");
    } catch {
      // The UI itself may be unavailable (e.g. during teardown); never throw.
    }
  }
}

export async function runUsageStatsCommand(
  deps: CommandDependencies,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const [arg = ""] = args.trim().split(/\s+/);
    if (arg !== "" && arg !== "project" && arg !== "global" && arg !== "refresh") {
      presentError(ctx, arg, new Error("unknown argument; expected: project | global | refresh"));
      return;
    }

    if (arg === "refresh") {
      try {
        const summary: ScanSummary = await deps.store.refresh();
        presentText(ctx, formatScanSummary(summary));
      } catch (error) {
        presentError(ctx, "refresh", error);
      }
      return;
    }

    const scope: Scope = arg === "project" ? "project" : "global";

    if (ctx.mode === "tui") {
      await showUsageOverlay(deps, ctx, scope);
      return;
    }

    const result: UsageQueryResult = deps.store.query(filtersForScope(scope, ctx));
    presentText(ctx, formatCompactSummary(result, scope, projectCwd(ctx)));
  } catch (error) {
    // Safety net: no error may escape into Pi (spec/typescript/error-handling.md).
    presentError(ctx, "pi-usage-statistics", error);
  }
}

/**
 * TUI-only interactive embedded dashboard. Lazy-imports the dashboard module
 * (pi-tui must never load in non-TUI modes) and guards every TUI API by
 * `ctx.mode === "tui"`. Failures are reported non-fatally.
 */
async function showUsageOverlay(deps: CommandDependencies, ctx: ExtensionCommandContext, scope: Scope): Promise<void> {
  try {
    const { makeOverlayFactory } = await import("../tui/dashboard");
    const cwd = projectCwd(ctx);
    await ctx.ui.custom(
      makeOverlayFactory({ store: deps.store, projectCwd: cwd, initialScope: scope }),
    );
  } catch (error) {
    presentError(ctx, "tui", error);
  }
}
