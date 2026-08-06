/**
 * `/usage-stats` command implementation (design §6, RC3/RC6).
 *
 * Actions:
 * - (none)   -> compact summary via the shared store query;
 * - `web`    -> start the loopback dashboard (only on explicit invocation),
 *               report the URL, attempt a best-effort browser open;
 * - `refresh`-> rescan session files through the store;
 * - `stop`   -> shut down the dashboard server.
 *
 * Mode guards: `ctx.ui.custom()` is never invoked here (the TUI dashboard
 * child task owns that); TUI/rpc modes receive notifications, print mode
 * writes plain text to stdout, json mode stays silent so the JSON event
 * stream is never corrupted. All failures are reported non-fatally.
 */
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageFilters, UsageQueryResult } from "../domain";
import { DEFAULT_BUCKET_MS } from "../domain";
import type { ScanSummary, UsageStore } from "../storage";
import { formatCompactSummary, formatScanSummary } from "./format";
import type { WebServerHandle } from "./web-server";

export type CommandDependencies = {
  store: UsageStore;
  /** Server factory; a null result means the dashboard module is unavailable. */
  createServer: () => WebServerHandle | null;
  /** Best-effort browser open (non-fatal). */
  openBrowser: (url: string) => void;
  getServer: () => WebServerHandle | null;
  setServer: (server: WebServerHandle | null) => void;
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
  const message = `usage-stats: ${action} failed: ${detail}`;
  console.error(`[usage-stats] ${action} failed: ${detail}`);
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
    const [action = ""] = args.trim().split(/\s+/);
    switch (action) {
      case "": {
        if (ctx.mode === "tui") {
          await showUsageOverlay(deps, ctx);
        } else {
          const result: UsageQueryResult = deps.store.query(DEFAULT_FILTERS());
          presentText(ctx, formatCompactSummary(result));
        }
        return;
      }
      case "refresh": {
        try {
          const summary: ScanSummary = await deps.store.refresh();
          presentText(ctx, formatScanSummary(summary));
        } catch (error) {
          presentError(ctx, "refresh", error);
        }
        return;
      }
      case "web": {
        await runWebAction(deps, ctx);
        return;
      }
      case "stop": {
        const server = deps.getServer();
        if (!server) {
          presentText(ctx, "Web dashboard is not running.");
          return;
        }
        try {
          await server.stop();
          deps.setServer(null);
          presentText(ctx, "Web dashboard stopped.");
        } catch (error) {
          presentError(ctx, "stop", error);
        }
        return;
      }
      default: {
        presentError(ctx, action, new Error("unknown action; expected one of: web, refresh, stop"));
        return;
      }
    }
  } catch (error) {
    // Safety net: no error may escape into Pi (spec/typescript/error-handling.md).
    presentError(ctx, "usage-stats", error);
  }
}

async function runWebAction(deps: CommandDependencies, ctx: ExtensionCommandContext): Promise<void> {
  const running = deps.getServer();
  if (running && running.isRunning()) {
    presentText(ctx, `Web dashboard already running at ${running.getUrl() ?? "unknown URL"}`);
    return;
  }
  const handle = deps.createServer();
  if (!handle) {
    // Non-fatal: the dashboard module is not available yet (web-dashboard
    // child task). Pi keeps running; the compact summary still works.
    presentError(ctx, "web", new Error("web dashboard module is not available; install or build the web-dashboard package"));
    return;
  }
  try {
    const url = await handle.start();
    deps.setServer(handle);
    presentText(ctx, `Web dashboard started at ${url}`);
    try {
      deps.openBrowser(url); // best-effort; a failed open leaves the URL usable
    } catch (error) {
      console.error(`[usage-stats] browser open failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    presentError(ctx, "web", error);
  }
}

/**
 * TUI-only interactive overlay for the default action. Lazy-imports the
 * dashboard module (pi-tui must never load in non-TUI modes) and guards
 * every TUI API by `ctx.mode === "tui"`. Failures are reported non-fatally.
 */
async function showUsageOverlay(deps: CommandDependencies, ctx: ExtensionCommandContext): Promise<void> {
  try {
    const { makeOverlayFactory } = await import("../tui/dashboard");
    await ctx.ui.custom(makeOverlayFactory(() => ({ kind: "ready", result: deps.store.query(DEFAULT_FILTERS()) })), { overlay: true });
  } catch (error) {
    presentError(ctx, "tui", error);
  }
}
