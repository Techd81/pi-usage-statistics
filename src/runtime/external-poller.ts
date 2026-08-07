/**
 * External-data poller for multi-window hot updates (design: live-update-multi-window).
 *
 * Each pi process keeps its own in-memory `UsageStore`; records written by
 * OTHER processes only exist on disk. While a dashboard is open this poller
 * watches the records file's mtime/size and, on change, reloads the store
 * from disk and notifies the live subscribers so the visible dashboard
 * catches up without a restart.
 *
 * - `ensureRunning()` records the current file state as the baseline, then
 *   starts a 2s interval (unref'd so it never keeps the process alive);
 * - `stop()` cancels the timer;
 * - stat/reload failures are non-fatal (keep the current in-memory state).
 */
import { stat } from "node:fs/promises";
import type { UsageStore } from "../storage";

/** Default poll interval (ms). stat() is ~microseconds; reload only on change. */
export const EXTERNAL_POLL_INTERVAL_MS = 2000;

export type FileState = { mtimeMs: number; size: number };

/** Read the records file's change signal; null when absent/unreadable. */
export type FileStateReader = (filePath: string) => Promise<FileState | null>;

export const defaultFileStateReader: FileStateReader = async (filePath) => {
  try {
    const st = await stat(filePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null; // absent/unreadable file: treat as no-change (fresh store)
  }
};

export type ExternalPollerOptions = {
  intervalMs?: number;
  /** Injectable file-state reader (tests); defaults to fs.stat. */
  readFileState?: FileStateReader;
};

export class ExternalDataPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private baseline: FileState | null = null;
  private readonly store: UsageStore;
  private readonly intervalMs: number;
  private readonly readFileState: FileStateReader;
  /** Listener invoked after a successful reload (wired to liveListeners). */
  private readonly onReloaded: () => void;

  constructor(
    store: UsageStore,
    onReloaded: () => void,
    options: ExternalPollerOptions = {},
  ) {
    this.store = store;
    this.onReloaded = onReloaded;
    this.intervalMs = Math.max(250, options.intervalMs ?? EXTERNAL_POLL_INTERVAL_MS);
    this.readFileState = options.readFileState ?? defaultFileStateReader;
  }

  /** Start polling (idempotent); the first read becomes the change baseline. */
  async ensureRunning(): Promise<void> {
    if (this.timer !== null) return;
    this.baseline = await this.readFileState(this.store.recordsFilePath);
    this.timer = setInterval(() => {
      void this.pollNow();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop polling and drop the baseline (next ensureRunning re-primes). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.baseline = null;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** Run one change-detection pass (also drives the interval). */
  async pollNow(): Promise<void> {
    const state = await this.readFileState(this.store.recordsFilePath);
    if (state === null) return; // file gone mid-flight: wait for the next tick
    const changed =
      this.baseline === null ||
      state.mtimeMs !== this.baseline.mtimeMs ||
      state.size !== this.baseline.size;
    if (!changed) return;
    try {
      await this.store.reloadFromDisk();
    } catch {
      // Reload failed: keep the OLD baseline so the next tick retries the
      // same change instead of silently dropping it.
      return;
    }
    // Re-baseline AFTER the reload: reloadFromDisk may flush this process's
    // own pending records, which rewrites the file (new mtime). Without this
    // the next tick would see our own write as an external change and loop
    // every interval. With it, only genuine external writes re-trigger.
    this.baseline = (await this.readFileState(this.store.recordsFilePath)) ?? state;
    this.onReloaded();
  }
}
