/**
 * Debounced, single-flight background scan scheduler (design §7).
 *
 * - `schedule()` coalesces bursts of events into one pass after `delayMs`;
 * - only one scan runs at a time; requests arriving while a pass is running
 *   are dropped. This is safe because `UsageStore.refresh()` is itself
 *   single-flight and dirty-flagged: events during a scan trigger exactly one
 *   follow-up pass on the next explicit refresh;
 * - the timer is unref'd so it never keeps the process alive;
 * - `run` must handle its own errors; the scheduler never rethrows into Pi.
 */
export type ScanRunner = () => Promise<void>;

export class DebouncedScanScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private readonly delayMs: number;

  constructor(
    private readonly run: ScanRunner,
    delayMs = 1000,
  ) {
    this.delayMs = Math.max(0, delayMs);
  }

  /** Schedule (or coalesce into) one background pass after the debounce window. */
  schedule(): void {
    if (this.timer !== null) return; // already debouncing
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runSafely();
    }, this.delayMs);
    this.timer.unref(); // never keep the process alive for a pending scan
  }

  private runSafely(): void {
    if (this.inflight) return; // single-flight: one pass at a time
    this.inflight = (async () => {
      try {
        await this.run();
      } catch {
        // The runner reports its own failures; never propagate into Pi.
      } finally {
        this.inflight = null;
      }
    })();
  }

  /** Cancel the pending timer and wait for an in-flight pass (shutdown path). */
  async settle(): Promise<void> {
    this.stop();
    while (this.inflight) await this.inflight;
  }

  /** Cancel a pending pass without waiting (no-op when nothing is scheduled). */
  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get hasPendingWork(): boolean {
    return this.timer !== null || this.inflight !== null;
  }
}
