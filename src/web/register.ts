/**
 * Package-manifest extension entry for the web dashboard (design §5.1).
 *
 * `package.json` lists this module in `pi.extensions` alongside
 * `src/extension.ts` so Pi loads the dashboard module at startup. The import
 * of `./server` registers the loopback-server factory (idempotent); this
 * factory is what the `/usage-stats web` command constructs via
 * `createWebServer()`.
 *
 * No hooks, timers, or servers are started here — per design §7 the factory
 * must only register, never run. All lifecycle work happens on the explicit
 * `web` command (start) and `session_shutdown` (stop).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import "./server";

/** Register the dashboard server factory; nothing else starts at load time. */
export default function registerWebDashboard(_pi: ExtensionAPI): void {
  // Side effects live in ./server; an empty factory keeps this module a valid
  // Pi extension while staying lifecycle-neutral.
}
