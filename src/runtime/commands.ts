/**
 * `/pi-usage-statistics` command implementation (design §6).
 *
 * Arguments:
 * - (none)   -> default scope `global`; TUI and compatible RPC hosts (such
 *               as Pi Web) open the interactive embedded dashboard, while
 *               non-interactive modes print a text summary;
 * - `project`-> scope `project` (records of the current working directory);
 * - `global` -> scope `global` (all locally stored sessions).
 *
 * Mode guards: `ctx.ui.custom()` runs in `tui` and `rpc` modes. Pi Web
 * provides a headless custom-component bridge for RPC sessions; print mode
 * writes plain text to stdout and json mode stays silent so the JSON event
 * stream is never corrupted. All failures are reported non-fatally.
 */
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageFilters, UsageQueryResult } from "../domain";
import { DEFAULT_BUCKET_MS } from "../domain";
import type { ScanSummary, UsageStore } from "../storage";
import { formatCompactSummary, formatScanSummary } from "./format";
import type { OverlayDeps, Scope } from "../tui/dashboard";

export type { Scope } from "../tui/dashboard";

export type CommandDependencies = {
  store: UsageStore;
  /**
   * Live-update subscription source (extension factory): register a listener
   * invoked when a new record arrives; returns an unsubscribe function.
   * Optional so print-only/test callers keep working without TUI wiring.
   */
  subscribeLive?: (listener: () => void) => () => void;
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
      await showUsageDashboard(deps, ctx, scope);
      return;
    }
    if (ctx.mode === "rpc") {
      const displayed = await showUsageDashboard(deps, ctx, scope);
      if (displayed) return;
    }

    const result: UsageQueryResult = deps.store.query(filtersForScope(scope, ctx));
    presentText(ctx, formatCompactSummary(result, scope, projectCwd(ctx)));
  } catch (error) {
    // Safety net: no error may escape into Pi (spec/typescript/error-handling.md).
    presentError(ctx, "pi-usage-statistics", error);
  }
}

/**
 * Interactive dashboard for Pi's TUI and RPC hosts that implement the custom
 * component bridge (notably Pi Web >= 0.8.8). The dashboard module is imported
 * lazily so print/json modes never load pi-tui. Returning `false` means the
 * host used the standard RPC no-op implementation and the caller should fall
 * back to the compact text summary. Failures are non-fatal.
 */
async function showUsageDashboard(
  deps: CommandDependencies,
  ctx: ExtensionCommandContext,
  scope: Scope,
): Promise<boolean> {
  try {
    // Multi-window: reload the durable file first so the freshly opened
    // dashboard already includes records written by other pi processes.
    await deps.store.reloadFromDisk();
    const { makeOverlayFactory } = await import("../tui/dashboard");
    const cwd = projectCwd(ctx);
    const overlayDeps: OverlayDeps = {
      store: deps.store,
      projectCwd: cwd,
      initialScope: scope,
      renderTarget: ctx.mode === "rpc" ? "web" : "terminal",
    };
    if (deps.subscribeLive) overlayDeps.subscribeLive = deps.subscribeLive;
    const result = await ctx.ui.custom<null>(makeOverlayFactory(overlayDeps));
    return ctx.mode === "tui" || result !== undefined;
  } catch (error) {
    presentError(ctx, "dashboard", error);
    return false;
  }
}
