/**
 * Terminal art title banner (FIGlet “ANSI Shadow” style), matching the
 * cyan block-letter look used by tools like Trellis. Art is hardcoded so
 * the package stays zero-dependency at runtime.
 *
 * Full title: **Pi Usage Statistics** (two ANSI Shadow rows).
 */
import { centerInWidth, displayWidth } from "./format";

/** Bright cyan face (Trellis-like terminal art). */
const CYAN = "\u001b[96m";
const RESET = "\u001b[0m";

/**
 * FIGlet font "ANSI Shadow" for "Pi Usage" (57 columns).
 * Generated once; do not regenerate at runtime.
 */
const ANSI_SHADOW_PI_USAGE = [
  "██████╗ ██╗    ██╗   ██╗███████╗ █████╗  ██████╗ ███████╗",
  "██╔══██╗██║    ██║   ██║██╔════╝██╔══██╗██╔════╝ ██╔════╝",
  "██████╔╝██║    ██║   ██║███████╗███████║██║  ███╗█████╗  ",
  "██╔═══╝ ██║    ██║   ██║╚════██║██╔══██║██║   ██║██╔══╝  ",
  "██║     ██║    ╚██████╔╝███████║██║  ██║╚██████╔╝███████╗",
  "╚═╝     ╚═╝     ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
] as const;

/**
 * FIGlet font "ANSI Shadow" for "Statistics" (73 columns).
 * Same face/shadow style as the Pi Usage row above.
 */
const ANSI_SHADOW_STATISTICS = [
  "███████╗████████╗ █████╗ ████████╗██╗███████╗████████╗██╗ ██████╗███████╗",
  "██╔════╝╚══██╔══╝██╔══██╗╚══██╔══╝██║██╔════╝╚══██╔══╝██║██╔════╝██╔════╝",
  "███████╗   ██║   ███████║   ██║   ██║███████╗   ██║   ██║██║     ███████╗",
  "╚════██║   ██║   ██╔══██║   ██║   ██║╚════██║   ██║   ██║██║     ╚════██║",
  "███████║   ██║   ██║  ██║   ██║   ██║███████║   ██║   ██║╚██████╗███████║",
  "╚══════╝   ╚═╝   ╚═╝  ╚═╝   ╚═╝   ╚═╝╚══════╝   ╚═╝   ╚═╝ ╚═════╝╚══════╝",
] as const;

/** Narrow fallback: fullwidth ornamental one-liner. */
const FULLWIDTH_TITLE = "Ｐｉ Ｕｓａｇｅ Ｓｔａｔｉｓｔｉｃｓ";

export type TitleBannerOptions = {
  /** Apply bright-cyan ANSI (default true). Tests may pass false. */
  colorize?: boolean;
};

const paint = (line: string, colorize: boolean): string =>
  colorize ? `${CYAN}${line}${RESET}` : line;

const maxArtWidth = (rows: readonly string[]): number =>
  Math.max(...rows.map((line) => displayWidth(line)));

/**
 * Centered ANSI-Shadow banner for the full title **Pi Usage Statistics**
 * (two stacked wordmarks). Falls back to a fullwidth one-liner when narrow.
 */
export function renderTitleBanner(width: number, options: TitleBannerOptions = {}): string[] {
  const w = Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
  if (w <= 0) return [];
  const colorize = options.colorize !== false;

  const statsWidth = maxArtWidth(ANSI_SHADOW_STATISTICS);
  const piWidth = maxArtWidth(ANSI_SHADOW_PI_USAGE);

  // Full two-line ANSI Shadow title when both wordmarks fit.
  if (w >= statsWidth + 2) {
    return [
      ...ANSI_SHADOW_PI_USAGE.map((line) => paint(centerInWidth(line, w), colorize)),
      centerInWidth("", w),
      ...ANSI_SHADOW_STATISTICS.map((line) => paint(centerInWidth(line, w), colorize)),
    ];
  }

  // Mid width: keep "Pi Usage" art only + a plain Statistics label.
  if (w >= piWidth + 2) {
    return [
      ...ANSI_SHADOW_PI_USAGE.map((line) => paint(centerInWidth(line, w), colorize)),
      centerInWidth("", w),
      paint(centerInWidth("Statistics", w), colorize),
    ];
  }

  const orn = w >= displayWidth(`✦ ${FULLWIDTH_TITLE} ✦`) ? `✦ ${FULLWIDTH_TITLE} ✦` : FULLWIDTH_TITLE;
  return [paint(centerInWidth(orn, w), colorize)];
}
