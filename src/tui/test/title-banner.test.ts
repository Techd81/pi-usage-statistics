import { describe, expect, it } from "vitest";
import { displayWidth } from "../format";
import { renderTitleBanner } from "../title-banner";

describe("renderTitleBanner", () => {
  it("renders ANSI Shadow π above a single USAGE STATISTICS wordmark on very wide terminals", () => {
    const lines = renderTitleBanner(130, { colorize: false });
    const text = lines.join("\n");
    expect(text).toContain("████████████╗");
    expect(text).toContain("╚═██╔═══██╔═╝");
    expect(text).toContain("██╗   ██╗███████╗ █████╗  ██████╗ ███████╗    ███████╗████████╗");
    // π art (6) + spacer + USAGE STATISTICS face rows (5 with ██).
    expect(lines.filter((line) => line.includes("██")).length).toBeGreaterThanOrEqual(10);
    for (const line of lines) {
      expect(displayWidth(line)).toBe(130);
    }
  });

  it("renders ANSI Shadow π above stacked USAGE + Statistics when Statistics fits", () => {
    const lines = renderTitleBanner(100, { colorize: false });
    const text = lines.join("\n");
    expect(text).toContain("████████████╗");
    expect(text).toContain("╚═██╔═══██╔═╝");
    expect(text).toContain("███████╗████████╗");
    expect(lines.filter((line) => line.includes("██")).length).toBeGreaterThanOrEqual(14);
    for (const line of lines) {
      expect(displayWidth(line)).toBe(100);
    }
  });

  it("keeps π + USAGE art and a STATISTICS label at mid widths", () => {
    const lines = renderTitleBanner(50, { colorize: false });
    const text = lines.join("\n");
    expect(text).toContain("████████████╗");
    expect(text).toContain("╚═██╔═══██╔═╝");
    expect(text).toContain("██████");
    expect(text).toContain("STATISTICS");
    expect(text).not.toContain("███████╗████████╗");
  });

  it("uses a plain π + USAGE STATISTICS label when art does not fit", () => {
    const lines = renderTitleBanner(40, { colorize: false });
    const text = lines.join("\n");
    expect(text).toContain("π");
    expect(text).toContain("USAGE STATISTICS");
    expect(text).not.toContain("████████████╗");
  });

  it("falls back to fullwidth title when too narrow for the plain label", () => {
    const lines = renderTitleBanner(17, { colorize: false });
    const text = lines.join("\n");
    expect(text).toContain("π");
    expect(text).toMatch(/Ｕ/);
    expect(text).not.toContain("USAGE STATISTICS");
    expect(text).not.toContain("██████");
  });

  it("applies cyan ANSI when colorize is on", () => {
    const lines = renderTitleBanner(100, { colorize: true });
    expect(lines.some((line) => line.includes("\u001b[96m"))).toBe(true);
  });
});
