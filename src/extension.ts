/**
 * Pi extension factory (design §7, parent design §6–§8): the only file wired
 * to `ExtensionAPI`. It registers hooks and commands only — no server, timer,
 * watcher, or full scan runs at factory time.
 *
 * Lifecycle:
 * - `session_start`   -> idempotent store init + debounced single-flight
 *                        background scan (silent on success);
 * - `message_end`     -> collector (see src/runtime/collector.ts);
 * - `model_select`    -> no-op (query dimensions are derived per query);
 * - `session_shutdown`-> stop timers, flush pending writes.
 *
 * Command: `/pi-usage-statistics` (TUI-only product; no web surface).
 * CLI flag: `pi --usage` (boolean) opens the global-scope dashboard right
 * after startup — a shell-free quick entry that reuses the same command
 * logic (DRY), so behavior can never drift from the in-session command.
 *
 * Error pathway: every async handler is wrapped; failures are reported via
 * `ctx.ui.notify`/stdout and logged, never rethrown into Pi
 * (spec/typescript/error-handling.md).
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageRecord } from "./domain";
import { UsageStore } from "./storage";
import { collectMessageEnd } from "./runtime/collector";
import { runUsageStatsCommand } from "./runtime/commands";
import { ExternalDataPoller, type ExternalPollerOptions } from "./runtime/external-poller";
import { DebouncedScanScheduler } from "./runtime/scan-scheduler";

export const DEFAULT_SCAN_DEBOUNCE_MS = 1000;

export type UsageStatsExtensionOptions = {
  /** Store override (tests); defaults to the agent-dir-backed store. */
  store?: UsageStore;
  /** Debounce window for the background scan. */
  scanDebounceMs?: number;
  /** Multi-window disk-polling knobs (tests may shrink the interval / fake the reader). */
  externalPoll?: ExternalPollerOptions;
};

export default function usageStatsExtension(pi: ExtensionAPI, options: UsageStatsExtensionOptions = {}): void {
  const store: UsageStore = options.store ?? new UsageStore();
  const scanDebounceMs = options.scanDebounceMs ?? DEFAULT_SCAN_DEBOUNCE_MS;
  let lastCtx: ExtensionContext | undefined;

  /**
   * Live-dashboard subscribers: while a `/pi-usage-statistics` overlay is
   * open, its component registers a listener here so `message_end` can
   * trigger a debounced refresh (hot update). Each listener is isolated —
   * one broken subscriber can never break collection or Pi.
   */
  const liveListeners = new Set<() => void>();
  /**
   * Multi-window hot updates: while at least one dashboard is open, poll the
   * records file for writes from OTHER pi processes and reload the store.
   */
  const externalPoller = new ExternalDataPoller(store, () => notifyLiveListeners(), options.externalPoll);
  const subscribeLive = (listener: () => void): (() => void) => {
    liveListeners.add(listener);
    void externalPoller.ensureRunning(); // first subscriber starts disk polling
    return () => {
      liveListeners.delete(listener);
      if (liveListeners.size === 0) externalPoller.stop(); // last one stops it
    };
  };

  const notifyLiveListeners = (): void => {
    for (const listener of [...liveListeners]) {
      try {
        listener();
      } catch {
        // A subscriber refresh failure must never escape into Pi.
      }
    }
  };

  const notifyError = (ctx: ExtensionContext | undefined, action: string, error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[pi-usage-statistics] ${action} failed: ${detail}`);
    try {
      ctx?.ui.notify(`pi-usage-statistics: ${action} failed: ${detail}`, "error");
    } catch {
      // The UI itself may be unavailable (e.g. during teardown); never throw.
    }
  };

  const scheduler = new DebouncedScanScheduler(async () => {
    try {
      // Background scan stays silent on success — only failures notify.
      // Explicit `/pi-usage-statistics refresh` still prints a summary.
      await store.refresh();
    } catch (error) {
      notifyError(lastCtx, "background scan", error);
    }
  }, scanDebounceMs);

  pi.on("session_start", async (event, ctx) => {
    try {
      await store.init(); // idempotent: reload/new/resume re-run it safely
    } catch (error) {
      notifyError(ctx, "store init", error);
    }
    lastCtx = ctx;
    // CLI quick entry: `pi --usage` opens the dashboard right after startup.
    // `reason === "startup"` limits this to the initial launch — reload/new/
    // resume/fork must not re-open the overlay. The strict `=== true` check
    // keeps an unregistered/absent flag (undefined) or default (false) inert.
    if (event.reason === "startup" && pi.getFlag("usage") === true) {
      try {
        // session_start delivers the base ExtensionContext; the command only
        // reads base-context members (mode/ui/cwd/sessionManager), so this
        // widening is safe and keeps commands.ts untouched (pure reuse, DRY).
        await runUsageStatsCommand({ store, subscribeLive }, "", ctx as ExtensionCommandContext);
      } catch (error) {
        notifyError(ctx, "usage flag", error);
      }
    }
    scheduler.schedule(); // debounced, single-flight background scan
  });

  pi.on("message_end", (event, ctx) => {
    let collected: UsageRecord | null = null;
    try {
      collected = collectMessageEnd(store, event, ctx);
    } catch (error) {
      notifyError(ctx, "collect usage", error);
    }
    // Hot update: only messages that actually stored a record trigger a
    // (debounced) dashboard refresh — non-countable messages stay silent.
    if (collected) {
      notifyLiveListeners();
      // Do not await disk I/O in message_end. UsageStore keeps the dirty state
      // on failure; shutdown and later live events provide retry opportunities.
      try {
        void store.persistLiveRecord().catch((error) => {
          notifyError(ctx, "persist live usage", error);
        });
      } catch (error) {
        // Keep even a synchronous scheduling failure inside the extension
        // boundary; custom/test stores must not be able to break Pi.
        notifyError(ctx, "persist live usage", error);
      }
    }
  });

  pi.on("model_select", (_event, _ctx) => {
    // No cache to invalidate: query dimensions (providers/models/projects/
    // sessions) are derived per-query from store records (design §7).
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Stop runtime resources first; each failure is isolated so a broken
    // step can never block the pending-write flush (RC4).
    try {
      externalPoller.stop();
      await scheduler.settle(); // cancel pending pass + wait for in-flight scan
    } catch (error) {
      notifyError(ctx, "shutdown (scan)", error);
    }
    try {
      await store.stop(); // flushes pending writes (RC4)
    } catch (error) {
      notifyError(ctx, "shutdown (store)", error);
    }
  });

  pi.registerFlag("usage", {
    description: "Open the token-usage statistics dashboard at startup (global scope)",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("pi-usage-statistics", {
    description:
      "Token usage statistics (TUI). Optional argument: project | global (scope). No argument defaults to global.",
    handler: (args, ctx) => runUsageStatsCommand({ store, subscribeLive }, args, ctx),
  });
}
