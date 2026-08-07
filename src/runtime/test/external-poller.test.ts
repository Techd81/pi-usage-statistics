/**
 * ExternalDataPoller tests: watches the records file for writes from OTHER
 * processes and reloads + notifies on change. The file-state reader is
 * injectable, so the change-detection and timer wiring are tested
 * deterministically with fake timers; the real-fs reload behavior itself is
 * covered by UsageStore.reloadFromDisk tests (session-index.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageStore } from "../../storage";
import type { FileState } from "../external-poller";
import { ExternalDataPoller, EXTERNAL_POLL_INTERVAL_MS } from "../external-poller";

describe("ExternalDataPoller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function makeEnv() {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-poller-sessions-"));
    const storeDir = await mkdtemp(join(tmpdir(), "pi-poller-data-"));
    const store = new UsageStore({ storeDir, sessionDir });
    await store.init();
    return { store, storeDir, sessionDir };
  }

  /** Fake reader whose returned state the test mutates to simulate external writes. */
  function makeFakeReader() {
    const state: FileState = { mtimeMs: 1000, size: 100 };
    const reader = vi.fn(async (): Promise<FileState | null> => ({ ...state }));
    return { reader, state };
  }

  it("primes a baseline on start and notifies exactly once per external change", async () => {
    const { store } = await makeEnv();
    const { reader, state } = makeFakeReader();
    const onReloaded = vi.fn();
    const poller = new ExternalDataPoller(store, onReloaded, { readFileState: reader });
    vi.spyOn(store, "reloadFromDisk").mockResolvedValue(undefined);

    vi.useFakeTimers();
    await poller.ensureRunning();
    expect(poller.isRunning).toBe(true);
    expect(reader).toHaveBeenCalledTimes(1); // baseline read

    // No external change yet → a tick is a no-op.
    await vi.advanceTimersByTimeAsync(EXTERNAL_POLL_INTERVAL_MS);
    expect(onReloaded).not.toHaveBeenCalled();

    // "Another process" writes: mtime changes.
    state.mtimeMs = 2000;
    await vi.advanceTimersByTimeAsync(EXTERNAL_POLL_INTERVAL_MS);
    expect(onReloaded).toHaveBeenCalledTimes(1);
    // Self-baselined after the reload: same state → next tick stays silent.
    await vi.advanceTimersByTimeAsync(EXTERNAL_POLL_INTERVAL_MS);
    expect(onReloaded).toHaveBeenCalledTimes(1);
  });

  it("treats size changes as external writes and re-baselines after reload", async () => {
    const { store } = await makeEnv();
    const { reader, state } = makeFakeReader();
    const onReloaded = vi.fn();
    const poller = new ExternalDataPoller(store, onReloaded, { readFileState: reader });
    vi.spyOn(store, "reloadFromDisk").mockResolvedValue(undefined);

    vi.useFakeTimers();
    await poller.ensureRunning();

    // Size-only change (same mtime — e.g. same-second rewrite).
    state.size = 250;
    await vi.advanceTimersByTimeAsync(EXTERNAL_POLL_INTERVAL_MS);
    expect(onReloaded).toHaveBeenCalledTimes(1);

    // After the reload the baseline reflects the post-reload read; further
    // identical states do not re-trigger.
    await vi.advanceTimersByTimeAsync(EXTERNAL_POLL_INTERVAL_MS);
    expect(onReloaded).toHaveBeenCalledTimes(1);
  });

  it("reload failure is non-fatal: poller keeps polling, listener not called", async () => {
    const { store } = await makeEnv();
    const { reader, state } = makeFakeReader();
    const onReloaded = vi.fn();
    const poller = new ExternalDataPoller(store, onReloaded, { readFileState: reader });
    // reloadFromDisk swallows errors internally, so simulate a reader that
    // throws mid-flight instead (poller must not throw into the interval).
    vi.spyOn(store, "reloadFromDisk").mockRejectedValueOnce(new Error("disk boom")).mockResolvedValue(undefined);

    vi.useFakeTimers();
    await poller.ensureRunning();
    state.mtimeMs = 3000;
    await vi.advanceTimersByTimeAsync(EXTERNAL_POLL_INTERVAL_MS);
    expect(onReloaded).not.toHaveBeenCalled();
    // Still running — next change still gets polled.
    state.mtimeMs = 4000;
    await vi.advanceTimersByTimeAsync(EXTERNAL_POLL_INTERVAL_MS);
    expect(onReloaded).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels the interval and resets the baseline", async () => {
    const { store } = await makeEnv();
    const { reader, state } = makeFakeReader();
    const onReloaded = vi.fn();
    const poller = new ExternalDataPoller(store, onReloaded, { readFileState: reader });
    vi.spyOn(store, "reloadFromDisk").mockResolvedValue(undefined);

    vi.useFakeTimers();
    await poller.ensureRunning();
    poller.stop();
    expect(poller.isRunning).toBe(false);

    state.mtimeMs = 5000;
    await vi.advanceTimersByTimeAsync(EXTERNAL_POLL_INTERVAL_MS);
    expect(onReloaded).not.toHaveBeenCalled();

    // ensureRunning re-primes: an UNCHANGED state after re-prime is a no-op,
    // a NEW change is detected.
    await poller.ensureRunning();
    await vi.advanceTimersByTimeAsync(EXTERNAL_POLL_INTERVAL_MS);
    expect(onReloaded).not.toHaveBeenCalled();
    state.mtimeMs = 6000;
    await vi.advanceTimersByTimeAsync(EXTERNAL_POLL_INTERVAL_MS);
    expect(onReloaded).toHaveBeenCalledTimes(1);
  });

  it("intervalMs is clamped to a sane minimum", async () => {
    const { store } = await makeEnv();
    const { reader } = makeFakeReader();
    const poller = new ExternalDataPoller(store, () => {}, { intervalMs: 1, readFileState: reader });
    expect((poller as unknown as { intervalMs: number }).intervalMs).toBe(250);
  });
});
