/**
 * Best-effort OS browser open for the loopback dashboard (design §5.1).
 *
 * Failure is non-fatal by contract: the URL was already reported through the
 * UI before the open is attempted, so a failed open leaves the dashboard
 * reachable. No browser is ever launched from the factory or session hooks —
 * only from the explicit `web` command.
 */
import { spawn } from "node:child_process";

export function openInBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  // Windows `start` needs an empty title argument: cmd /c start "" <url>.
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  // Swallow spawn errors (e.g. xdg-open missing) — the URL remains usable.
  child.on("error", () => {});
  child.unref();
}
