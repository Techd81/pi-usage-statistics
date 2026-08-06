/**
 * TUI dashboard surface (design §6): a `ctx.ui.custom()` overlay component
 * that renders the shared `UsageQueryResult` with terminal-safe formatting.
 *
 * - Renders the same metrics as the Web surface (totals, five token cards,
 *   cache-hit rate, cost provenance) plus a compact trend bar.
 * - Narrow widths hide secondary rows and truncate labels; render() never
 *   throws on overflow (TC2/TC3).
 * - Loading / error / empty / estimated / unavailable states render
 *   distinctly (TC3/TC4).
 *
 * The component satisfies Pi's `Component` structural interface
 * (`render(width): string[]`, `handleInput?`, `invalidate()`) with zero
 * runtime dependency on `pi-tui` — the extension lazily imports this module
 * only inside the TUI-mode command path.
 */
import type { UsageQueryResult } from "../domain";
import { formatCost, formatHitRate, formatTokens, trendBar, truncateToWidth } from "./format";

/** Color functions consumed by the component; injectable for tests. */
export type DashboardTheme = {
  normal: (text: string) => string;
  selected: (text: string) => string;
  error: (text: string) => string;
  muted: (text: string) => string;
};

/** No-op theme: plain text, safe in print/rpc modes and deterministic in tests. */
export const noopTheme: DashboardTheme = {
  normal: (text) => text,
  selected: (text) => text,
  error: (text) => text,
  muted: (text) => text,
};

/** Presentation state driving the overlay; the caller owns data loading. */
export type OverlayState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; result: UsageQueryResult };

const KEY_QUIT = "q";
const KEY_ESC = "\u001b";

/**
 * Interactive usage overlay. Key bindings: `q` or `Esc` closes the overlay.
 */
export class UsageDashboardComponent {
  constructor(
    private readonly state: OverlayState,
    private readonly theme: DashboardTheme = noopTheme,
    private readonly onDone: () => void = () => {},
  ) {}

  render(width: number): string[] {
    const w = Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
    const lines: string[] = [];

    if (this.state.kind === "loading") {
      lines.push(this.theme.muted("Loading usage data…"));
    } else if (this.state.kind === "error") {
      lines.push(this.theme.error("⚠ Usage data unavailable"));
      lines.push(this.theme.muted(truncateToWidth(this.state.message, w)));
    } else {
      const result = this.state.result;
      if (result.totals.requestCount === 0 && result.totals.totalTokens === 0) {
        lines.push(this.theme.normal("No usage data in the selected range."));
      }
      this.renderMetrics(lines, result, w);
      const bar = trendBar(result.trend.map((point) => point.totalTokens));
      if (bar !== "") {
        lines.push(this.theme.selected(truncateToWidth(`trend ${bar}`, w)));
      }
      if (w >= 60) {
        const dims = result.dimensions;
        lines.push(
          this.theme.muted(
            truncateToWidth(
              `models ${dims.models.length} · projects ${dims.projects.length} · sessions ${dims.sessions.length}`,
              w,
            ),
          ),
        );
      }
    }

    lines.push(this.theme.muted("[q] close"));
    return lines.map((line) => truncateToWidth(line, w));
  }

  handleInput(data: string): void {
    if (data === KEY_QUIT || data === KEY_ESC) this.onDone();
  }

  invalidate(): void {
    // No cached rendering state; nothing to invalidate.
  }

  private renderMetrics(lines: string[], result: UsageQueryResult, width: number): void {
    const totals = result.totals;
    const labelWidth = Math.min(14, Math.max(0, Math.floor(width / 3)));
    const row = (label: string, value: string, style: (s: string) => string = this.theme.normal): void => {
      // Truncate plain text to its column budget BEFORE applying color, so the
      // ANSI sequences always fit intact (no split escapes, no lost resets).
      const labelCol = truncateToWidth(label, labelWidth).padEnd(labelWidth);
      const valueCol = style(truncateToWidth(value, Math.max(0, width - labelWidth)));
      lines.push(`${labelCol}${valueCol}`);
    };
    // Only the first two rows are "wide" values; narrow terminals hide the
    // token breakdown but keep the essential totals and cost.
    row("requests", formatTokens(totals.requestCount));
    row("total tokens", formatTokens(totals.totalTokens));
    if (width >= 60) {
      row("input", formatTokens(totals.inputTokens));
      row("output", formatTokens(totals.outputTokens));
      row("cache write", formatTokens(totals.cacheWriteTokens));
      row("cache read", formatTokens(totals.cacheReadTokens));
    }
    row("cache hit", formatHitRate(totals.cacheHitRate));
    row("cost", formatCost(totals.cost), this.theme.selected);
  }
}

/**
 * Build the overlay factory for `ctx.ui.custom()`. Maps the Pi `theme`
 * argument onto the small `DashboardTheme`; any failure falls back to
 * `noopTheme` so rendering never crashes Pi (non-fatal by contract).
 */
export function makeOverlayFactory(state: () => OverlayState) {
  return (tui: { requestRender(): void }, theme: unknown, _keybindings: unknown, done: (value: null) => void) => {
    void tui; // state changes are externally driven via setState; render is pull-based
    let paint = noopTheme;
    try {
      const piTheme = theme as { fg?: (color: string, text: string) => string } | null;
      if (piTheme?.fg) {
        paint = {
          normal: (text) => piTheme.fg!("text", text),
          selected: (text) => piTheme.fg!("accent", text),
          error: (text) => piTheme.fg!("error", text),
          muted: (text) => piTheme.fg!("muted", text),
        };
      }
    } catch {
      paint = noopTheme;
    }
    return new UsageDashboardComponent(state(), paint, () => done(null));
  };
}
