#!/usr/bin/env node
/**
 * Standalone usage viewer (`pi-usage`): an htop-style TUI that reads the
 * same durable records as the pi extension and NEVER starts a pi session —
 * no AgentSession, no session files, no LLM calls (design: 08-08-standalone-viewer).
 *
 * - Data: `<agent-dir>/token-usage-statistics/records.jsonl` via `UsageStore`
 *   (init + reloadFromDisk only — the read-only path, no session scanning).
 * - Hot updates: `ExternalDataPoller` re-reads the file every 0.5s while the
 *   viewer is open, so records produced by a running pi session in another
 *   window land on the dashboard within ~1s.
 * - Terminal: alternate screen, hidden cursor, raw mode; Esc (or Ctrl+C)
 *   restores the terminal and exits 0. Non-TTY invocations print a text
 *   summary and exit 0 (pipe/CI safe).
 */
import { realpathSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { ExternalDataPoller } from "../runtime/external-poller";
import { formatCompactSummary } from "../runtime/format";
import { UsageStore } from "../storage";
import {
  filtersFor,
  noopTheme,
  UsageDashboardComponent,
  type DashboardTheme,
  type Scope,
} from "../tui/dashboard";

/** Exit code for CLI usage errors (bad arguments). */
export const EXIT_USAGE = 2;

/** Error carrying a user-facing message (e.g. unknown CLI arguments). */
export class UsageError extends Error {}

/**
 * Parse the positional scope argument: none → `global`; `project` → records
 * of the current working directory; anything else is a usage error.
 */
export function parseScope(argv: readonly string[]): Scope {
  if (argv.length === 0) return "global";
  const [arg] = argv;
  if (argv.length === 1 && (arg === "global" || arg === "project")) return arg;
  const shown = argv.map((a) => `"${a}"`).join(" ");
  throw new UsageError(`Unknown argument: ${shown}\nUsage: pi-usage [global|project]`);
}

/**
 * Text summary for non-TTY invocations: query all-time records for the scope
 * and render the same compact summary the `/pi-usage-statistics` print path
 * uses (shared query + shared formatter, DRY — numbers can never diverge).
 */
export function buildSummary(store: UsageStore, scope: Scope, cwd: string, now: number = Date.now()): string {
  const result = store.query(filtersFor(scope, "all", cwd, now), now);
  return formatCompactSummary(result, scope, cwd);
}

/**
 * Render one full frame: the component's lines for `width` columns. Pure and
 * injectable so tests can assert rendering without a real terminal.
 */
export function paintLines(component: UsageDashboardComponent, width: number): string[] {
  return component.render(width);
}

/** ANSI theme matching pi's accent semantics: cyan selected / red error / grey muted. */
export const ansiTheme: DashboardTheme = {
  normal: (text) => text,
  selected: (text) => `\x1b[36m${text}\x1b[0m`,
  error: (text) => `\x1b[31m${text}\x1b[0m`,
  muted: (text) => `\x1b[90m${text}\x1b[0m`,
};

/** Pick the theme: `NO_COLOR` or `TERM=dumb` disable colors (noop fallback). */
export function resolveTheme(env: NodeJS.ProcessEnv = process.env): DashboardTheme {
  if (env.NO_COLOR !== undefined || env.TERM === "dumb") return noopTheme;
  return ansiTheme;
}

// --- Terminal control -------------------------------------------------------

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const HOME = "\x1b[H";
const CLEAR_TO_END = "\x1b[J";

let restored = false;
let poller: ExternalDataPoller | null = null;

/**
 * Restore the terminal to its pre-viewer state (leave alternate screen, show
 * cursor, exit raw mode, stop the poller). Idempotent — a `restored` guard
 * makes repeated Esc / SIGINT / process-exit calls safe.
 */
export function restoreTerminal(): void {
  if (restored) return;
  restored = true;
  try {
    // Only emit terminal escapes on a real TTY: the init-failure path may run
    // with a piped stdout, and stray escape bytes must not pollute the pipe.
    if (stdout.isTTY) stdout.write(LEAVE_ALT_SCREEN + SHOW_CURSOR);
  } catch {
    // Best-effort: a broken stream must not mask the exit path.
  }
  try {
    if (stdin.isTTY) stdin.setRawMode(false);
  } catch {
    // stdin may already be closed.
  }
  try {
    poller?.stop();
  } catch {
    // Stop is best-effort.
  }
  poller = null;
  try {
    stdin.pause();
  } catch {
    // Already paused/closed.
  }
}

/** Run the interactive TUI loop; resolves with the process exit code. */
function runTui(store: UsageStore, scope: Scope, cwd: string, theme: DashboardTheme): Promise<number> {
  return new Promise((resolveExit) => {
    let exited = false;
    const finish = (code: number): void => {
      if (exited) return;
      exited = true;
      restoreTerminal();
      resolveExit(code);
    };

    // Ctrl+C in raw mode arrives as a byte (\x03), not a signal — handled in
    // the data loop; these cover conventional signals (e.g. from `kill`).
    const onSignal = (code: number) => (): void => {
      restoreTerminal();
      process.exit(code);
    };
    process.once("SIGINT", onSignal(130));
    process.once("SIGTERM", onSignal(143));

    stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
    stdin.setRawMode(true);
    stdin.resume();

    const paint = (): void => {
      try {
        // Resolve the terminal width defensively: in alternate-screen mode
        // `stdout.columns` is usually set, but some terminals expose it late;
        // fall back to getWindowSize()/a sane default so a narrow 80-col frame
        // never renders into a wide terminal (layout looks "broken" while a
        // later paint finally uses the real width).
        let width = stdout.columns !== undefined && stdout.columns > 0 ? stdout.columns : 0;
        if (width === 0) {
          try {
            const [cols] = stdout.getWindowSize?.() ?? [0];
            width = cols > 0 ? cols : 100;
          } catch {
            width = 100;
          }
        }
        const lines = paintLines(component, width);
        // Frame atomicity: reset colors before/after the frame so a stray
        // unterminated SGR from the previous frame can never tint the next
        // one (that is a classic "layout suddenly looks scrambled" cause on
        // Windows Terminal with emoji/colors); HOME + CLEAR_TO_END keeps the
        // whole frame authoritative without full-screen flicker.
        stdout.write(`\x1b[0m${HOME}${lines.join("\n")}\n\x1b[0m${CLEAR_TO_END}`);
      } catch (error) {
        // A failed render/write (resize storm, closed stream) must never leave
        // the terminal in raw mode — restore and exit instead (error-handling
        // spec: failures are non-fatal, terminal state is always recovered).
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`pi-usage: render failed: ${detail}\n`);
        finish(1);
      }
    };

    // Coalesce render requests: key presses, disk-poll reloads, and resize
    // events that land in the same event-loop turn are painted once. Without
    // this, a busy poller + rapid key presses queue several multi-KB frames;
    // Windows Terminal renders them one after another, which reads as
    // stutter and mid-frame "scrambled" snapshots until the queue drains.
    let paintQueued = false;
    const schedulePaint = (): void => {
      if (paintQueued || exited) return;
      paintQueued = true;
      queueMicrotask(() => {
        paintQueued = false;
        if (exited) return;
        paint();
      });
    };

    const component = new UsageDashboardComponent(
      { store, projectCwd: cwd, initialScope: scope },
      theme,
      () => finish(0),
      schedulePaint,
    );

    poller = new ExternalDataPoller(store, () => component.refreshNow(), {});
    void poller.ensureRunning();

    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (text === "\x03") {
        // Raw-mode Ctrl+C: quit directly (SIGINT is not raised in raw mode).
        finish(130);
        return;
      }
      component.handleInput(text);
    };
    stdin.on("data", onData);
    const onResize = (): void => schedulePaint();
    stdout.on("resize", onResize);

    schedulePaint();
  });
}

/**
 * Standalone entry: parse args, load the shared records (read-only), then
 * either print a text summary (non-TTY) or enter the TUI loop. Returns the
 * process exit code. Exported so tests can exercise the pure pieces; the raw
 * terminal loop is verified manually.
 */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let scope: Scope;
  try {
    scope = parseScope(argv);
  } catch (error) {
    process.stderr.write(`pi-usage: ${(error as Error).message}\n`);
    return EXIT_USAGE;
  }

  const store = new UsageStore();
  try {
    await store.init();
  } catch (error) {
    restoreTerminal();
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pi-usage: failed to load usage data: ${detail}\n`);
    return 1;
  }

  const cwd = process.cwd();
  // Non-interactive when EITHER side is not a TTY: `pi-usage | head` would
  // otherwise paint ANSI into a pipe, and a piped stdin cannot drive keys.
  if (!stdin.isTTY || !stdout.isTTY) {
    process.stdout.write(`${buildSummary(store, scope, cwd)}\n`);
    return 0;
  }
  return runTui(store, scope, cwd, resolveTheme(env));
}

// Entry guard: run only when this module is the main script (imports from
// tests must not start the viewer). Compare REAL paths so the guard still
// fires when the bin is reached through an npm-link symlink (process.argv[1]
// is the C:\...\npm shim path, import.meta.url resolves to the D:\...\ real
// path — a raw string compare would miss and the viewer would exit silently).
function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exit(code);
      // code 0: natural exit lets any buffered stdout flush; raw-mode TTY
      // handles were already released by restoreTerminal().
      process.exitCode = 0;
    },
    (error: unknown) => {
      restoreTerminal();
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`pi-usage: ${detail}\n`);
      process.exit(1);
    },
  );
}
