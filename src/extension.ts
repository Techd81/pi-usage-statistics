/**
 * Pi extension factory (design §7, parent design §6–§8): the only file wired
 * to `ExtensionAPI`. It registers hooks and commands only — no server, timer,
 * watcher, or full scan runs at factory time.
 *
 * Lifecycle:
 * - `session_start`   -> idempotent store init + debounced single-flight
 *                        background scan;
 * - `message_end`     -> collector (see src/runtime/collector.ts);
 * - `model_select`    -> no-op (query dimensions are derived per query);
 * - `session_shutdown`-> stop timers/server, flush pending writes.
 *
 * Error pathway: every async handler is wrapped; failures are reported via
 * `ctx.ui.notify`/stdout and logged, never rethrown into Pi
 * (spec/typescript/error-handling.md).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UsageStore, type ScanSummary } from "./storage";
import { openInBrowser } from "./runtime/browser";
import { collectMessageEnd } from "./runtime/collector";
import { presentText, runUsageStatsCommand } from "./runtime/commands";
import { formatScanSummary } from "./runtime/format";
import { DebouncedScanScheduler } from "./runtime/scan-scheduler";
import { createWebServer, type WebServerHandle } from "./runtime/web-server";

export const DEFAULT_SCAN_DEBOUNCE_MS = 1000;

export type UsageStatsExtensionOptions = {
  /** Store override (tests); defaults to the agent-dir-backed store. */
  store?: UsageStore;
  /** Debounce window for the background scan. */
  scanDebounceMs?: number;
  /** Server factory override (tests); defaults to the registered web-dashboard factory. */
  createServer?: () => WebServerHandle | null;
  /** Browser-open override (tests); defaults to the OS command. */
  openBrowser?: (url: string) => void;
};

export default function usageStatsExtension(pi: ExtensionAPI, options: UsageStatsExtensionOptions = {}): void {
  const store: UsageStore = options.store ?? new UsageStore();
  const scanDebounceMs = options.scanDebounceMs ?? DEFAULT_SCAN_DEBOUNCE_MS;
  const createServer = options.createServer ?? (() => createWebServer());
  const openBrowser = options.openBrowser ?? openInBrowser;

  let server: WebServerHandle | null = null;
  let lastCtx: ExtensionContext | undefined;

  const notifyError = (ctx: ExtensionContext | undefined, action: string, error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[usage-stats] ${action} failed: ${detail}`);
    try {
      ctx?.ui.notify(`usage-stats: ${action} failed: ${detail}`, "error");
    } catch {
      // The UI itself may be unavailable (e.g. during teardown); never throw.
    }
  };

  const scheduler = new DebouncedScanScheduler(async () => {
    try {
      const summary: ScanSummary = await store.refresh();
      if (lastCtx) presentText(lastCtx, formatScanSummary(summary));
    } catch (error) {
      notifyError(lastCtx, "background scan", error);
    }
  }, scanDebounceMs);

  pi.on("session_start", async (_event, ctx) => {
    try {
      await store.init(); // idempotent: reload/new/resume re-run it safely
    } catch (error) {
      notifyError(ctx, "store init", error);
    }
    lastCtx = ctx;
    scheduler.schedule(); // debounced, single-flight background scan
  });

  pi.on("message_end", (event, ctx) => {
    try {
      collectMessageEnd(store, event, ctx);
    } catch (error) {
      notifyError(ctx, "collect usage", error);
    }
  });

  pi.on("model_select", (_event, _ctx) => {
    // No cache to invalidate: query dimensions (providers/models/projects/
    // sessions) are derived per-query from store records (design §7).
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Stop runtime resources first; each failure is isolated so a broken
    // server can never block the pending-write flush (RC4).
    try {
      await scheduler.settle(); // cancel pending pass + wait for in-flight scan
    } catch (error) {
      notifyError(ctx, "shutdown (scan)", error);
    }
    if (server) {
      const current = server;
      server = null;
      try {
        await current.stop();
      } catch (error) {
        notifyError(ctx, "shutdown (server)", error);
      }
    }
    try {
      await store.stop(); // flushes pending writes (RC4)
    } catch (error) {
      notifyError(ctx, "shutdown (store)", error);
    }
  });

  pi.registerCommand("usage-stats", {
    description:
      "Token usage statistics. Actions: (none) compact summary, web (dashboard), refresh (rescan), stop (shut down dashboard).",
    handler: (args, ctx) =>
      runUsageStatsCommand(
        {
          store,
          createServer,
          openBrowser,
          getServer: () => server,
          setServer: (next) => {
            server = next;
          },
        },
        args,
        ctx,
      ),
  });
}
