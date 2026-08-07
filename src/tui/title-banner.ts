/**
 * Decorative title banner for the dashboard hero page.
 * Fullwidth / ornamental glyphs read as “art font” in the terminal
 * without needing an external figlet dependency.
 */
import { centerInWidth, displayWidth } from "./format";

/** Fullwidth Latin title: roughly 2 columns per letter. */
const FULLWIDTH_TITLE = "Ｐｉ Ｕｓａｇｅ Ｓｔａｔｉｓｔｉｃｓ";

/**
 * Compact 4-line ASCII wordmark (fits ~48+ columns when centered).
 * Source: hand-tuned small banner for "Pi Usage".
 */
const ASCII_WORDMARK = [
  " ____  _   _   _                  ",
  "|  _ \\(_) | | | |___  __ _  __ _  ___",
  "| |_) | | | | | / __|/ _` |/ _` |/ _ \\",
  "|  __/| | | |_| \\__ \\ (_| | (_| |  __/",
  "|_|   |_|  \\___/|___/\\__,_|\\__, |\\___|",
  "                           |___/     ",
] as const;

/**
 * Render a centered artistic title. Wide terminals get the ASCII wordmark;
 * narrower ones get a single fullwidth ornamental line + underline.
 */
export function renderTitleBanner(width: number): string[] {
  const w = Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
  if (w <= 0) return [];

  const wordmarkWidth = Math.max(...ASCII_WORDMARK.map((line) => displayWidth(line)));
  if (w >= wordmarkWidth + 2) {
    return ASCII_WORDMARK.map((line) => centerInWidth(line, w));
  }

  const orn = w >= displayWidth(`✦ ${FULLWIDTH_TITLE} ✦`) ? `✦ ${FULLWIDTH_TITLE} ✦` : FULLWIDTH_TITLE;
  const title = centerInWidth(orn, w);
  const rule = centerInWidth("━".repeat(Math.min(w, Math.max(8, displayWidth(orn) - 2))), w);
  return [title, rule];
}
