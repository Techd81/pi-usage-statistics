/**
 * Terminal art title banner (FIGlet “ANSI Shadow” style), matching the
 * cyan block-letter look used by tools like Trellis. Art is hardcoded so
 * the package stays zero-dependency at runtime.
 *
 * Full title: **π / USAGE STATISTICS** (π mark above the wordmark, same face).
 */
import { centerInWidth, displayWidth } from "./format";

/** Bright cyan face (Trellis-like terminal art). */
const CYAN = "\u001b[96m";
const RESET = "\u001b[0m";

/**
 * Hand-drawn ANSI Shadow–style **π** (6 rows, same face as USAGE).
 * Top bar + two legs only (the previous three-stem glyph read as “m”).
 */
const ANSI_SHADOW_PI = [
  "████████████╗",
  "╚═██╔═══██╔═╝",
  "  ██║   ██║  ",
  "  ██║   ██║  ",
  "  ██║   ██║  ",
  "  ╚═╝   ╚═╝  ",
] as const;

/**
 * FIGlet font "ANSI Shadow" for "USAGE" (42 columns).
 * Generated once; do not regenerate at runtime.
 */
const ANSI_SHADOW_USAGE = [
  "██╗   ██╗███████╗ █████╗  ██████╗ ███████╗",
  "██║   ██║██╔════╝██╔══██╗██╔════╝ ██╔════╝",
  "██║   ██║███████╗███████║██║  ███╗█████╗  ",
  "██║   ██║╚════██║██╔══██║██║   ██║██╔══╝  ",
  "╚██████╔╝███████║██║  ██║╚██████╔╝███████╗",
  " ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
] as const;

/**
 * FIGlet font "ANSI Shadow" for "Statistics" (73 columns).
 * Same face/shadow style as the USAGE row above.
 */
const ANSI_SHADOW_STATISTICS = [
  "███████╗████████╗ █████╗ ████████╗██╗███████╗████████╗██╗ ██████╗███████╗",
  "██╔════╝╚══██╔══╝██╔══██╗╚══██╔══╝██║██╔════╝╚══██╔══╝██║██╔════╝██╔════╝",
  "███████╗   ██║   ███████║   ██║   ██║███████╗   ██║   ██║██║     ███████╗",
  "╚════██║   ██║   ██╔══██║   ██║   ██║╚════██║   ██║   ██║██║     ╚════██║",
  "███████║   ██║   ██║  ██║   ██║   ██║███████║   ██║   ██║╚██████╗███████║",
  "╚══════╝   ╚═╝   ╚═╝  ╚═╝   ╚═╝   ╚═╝╚══════╝   ╚═╝   ╚═╝ ╚═════╝╚══════╝",
] as const;

/**
 * FIGlet font "ANSI Shadow" for "USAGE STATISTICS" (119 columns).
 * Preferred when the terminal is wide enough for a single wordmark row.
 */
const ANSI_SHADOW_USAGE_STATISTICS = [
  "██╗   ██╗███████╗ █████╗  ██████╗ ███████╗    ███████╗████████╗ █████╗ ████████╗██╗███████╗████████╗██╗ ██████╗███████╗",
  "██║   ██║██╔════╝██╔══██╗██╔════╝ ██╔════╝    ██╔════╝╚══██╔══╝██╔══██╗╚══██╔══╝██║██╔════╝╚══██╔══╝██║██╔════╝██╔════╝",
  "██║   ██║███████╗███████║██║  ███╗█████╗      ███████╗   ██║   ███████║   ██║   ██║███████╗   ██║   ██║██║     ███████╗",
  "██║   ██║╚════██║██╔══██║██║   ██║██╔══╝      ╚════██║   ██║   ██╔══██║   ██║   ██║╚════██║   ██║   ██║██║     ╚════██║",
  "╚██████╔╝███████║██║  ██║╚██████╔╝███████╗    ███████║   ██║   ██║  ██║   ██║   ██║███████║   ██║   ██║╚██████╗███████║",
  " ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝    ╚══════╝   ╚═╝   ╚═╝  ╚═╝   ╚═╝   ╚═╝╚══════╝   ╚═╝   ╚═╝ ╚═════╝╚══════╝",
] as const;

/** Narrow fallback: fullwidth ornamental one-liner. */
const FULLWIDTH_TITLE = "π Ｕｓａｇｅ Ｓｔａｔｉｓｔｉｃｓ";

export type TitleBannerOptions = {
  /** Apply bright-cyan ANSI (default true). Tests may pass false. */
  colorize?: boolean;
};

const paint = (line: string, colorize: boolean): string =>
  colorize ? `${CYAN}${line}${RESET}` : line;

const maxArtWidth = (rows: readonly string[]): number =>
  Math.max(...rows.map((line) => displayWidth(line)));

const paintArt = (rows: readonly string[], w: number, colorize: boolean): string[] =>
  rows.map((line) => paint(centerInWidth(line, w), colorize));

/**
 * Centered banner: ANSI-Shadow **π** above **USAGE STATISTICS**.
 * Falls back to stacked USAGE + Statistics art, then plain / fullwidth labels.
 */
export function renderTitleBanner(width: number, options: TitleBannerOptions = {}): string[] {
  const w = Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
  if (w <= 0) return [];
  const colorize = options.colorize !== false;

  const usageStatsWidth = maxArtWidth(ANSI_SHADOW_USAGE_STATISTICS);
  const statsWidth = maxArtWidth(ANSI_SHADOW_STATISTICS);
  const usageWidth = maxArtWidth(ANSI_SHADOW_USAGE);
  const piWidth = maxArtWidth(ANSI_SHADOW_PI);
  const spacer = centerInWidth("", w);

  const withPiArt = (below: string[]): string[] => [
    ...paintArt(ANSI_SHADOW_PI, w, colorize),
    spacer,
    ...below,
  ];

  // Wide: single "USAGE STATISTICS" wordmark under π art.
  if (w >= usageStatsWidth + 2) {
    return withPiArt(paintArt(ANSI_SHADOW_USAGE_STATISTICS, w, colorize));
  }

  // Fits Statistics art: stack USAGE + Statistics under π art.
  if (w >= statsWidth + 2) {
    return withPiArt([
      ...paintArt(ANSI_SHADOW_USAGE, w, colorize),
      spacer,
      ...paintArt(ANSI_SHADOW_STATISTICS, w, colorize),
    ]);
  }

  // Mid width: π + USAGE art + plain Statistics label.
  if (w >= Math.max(usageWidth, piWidth) + 2) {
    return withPiArt([
      ...paintArt(ANSI_SHADOW_USAGE, w, colorize),
      spacer,
      paint(centerInWidth("STATISTICS", w), colorize),
    ]);
  }

  // Compact: plain π + wordmark (art no longer fits).
  if (w >= displayWidth("π USAGE STATISTICS") + 2) {
    return [
      paint(centerInWidth("π", w), colorize),
      spacer,
      paint(centerInWidth("USAGE STATISTICS", w), colorize),
    ];
  }

  const orn = w >= displayWidth(`✦ ${FULLWIDTH_TITLE} ✦`) ? `✦ ${FULLWIDTH_TITLE} ✦` : FULLWIDTH_TITLE;
  return [paint(centerInWidth(orn, w), colorize)];
}
