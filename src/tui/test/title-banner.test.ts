import { describe, expect, it } from "vitest";
import { displayWidth } from "../format";
import { renderTitleBanner } from "../title-banner";

describe("renderTitleBanner", () => {
  it("renders ANSI Shadow Pi Usage + Statistics on wide terminals", () => {
    const lines = renderTitleBanner(100, { colorize: false });
    const text = lines.join("\n");
    expect(text).toContain("██████");
    // Both wordmarks use ANSI Shadow block letters (Statistics starts with ███████╗).
    expect(text).toContain("███████╗████████╗");
    expect(lines.filter((line) => line.includes("██")).length).toBeGreaterThanOrEqual(10);
    for (const line of lines) {
      expect(displayWidth(line)).toBe(100);
    }
  });

  it("keeps Pi Usage art and a Statistics label at mid widths", () => {
    const lines = renderTitleBanner(64, { colorize: false });
    const text = lines.join("\n");
    expect(text).toContain("██████");
    expect(text).toContain("Statistics");
    expect(text).not.toContain("███████╗████████╗");
  });

  it("falls back to fullwidth title when too narrow for the art", () => {
    const lines = renderTitleBanner(40, { colorize: false });
    expect(lines.join("\n")).toContain("Ｐｉ");
    expect(lines.join("\n")).not.toContain("██████");
  });

  it("applies cyan ANSI when colorize is on", () => {
    const lines = renderTitleBanner(100, { colorize: true });
    expect(lines.some((line) => line.includes("\u001b[96m"))).toBe(true);
  });
});
