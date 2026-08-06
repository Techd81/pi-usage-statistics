/**
 * Terminal-safe text formatting for the shared query contract. No ANSI codes
 * and no terminal imports: the same functions serve print/rpc/json modes and
 * the TUI dashboard child task.
 */
import type { UsageQueryResult } from "../domain";
import type { ScanSummary } from "../storage";

/** Compact summary for the /pi-usage-statistics command (shared query). */
export function formatCompactSummary(result: UsageQueryResult, scope: "global" | "project" = "global", cwd = ""): string {
  const totals = result.totals;
  const cost =
    totals.cost.amount === null ? "--" : `$${totals.cost.amount.toFixed(4)} (${totals.cost.status})`;
  const hitRate = totals.cacheHitRate === null ? "--" : `${totals.cacheHitRate.toFixed(1)}%`;
  const scopeLine = scope === "project" ? `  scope:         project (${cwd})` : "  scope:         global";
  return [
    "Token usage statistics",
    scopeLine,
    `  requests:      ${totals.requestCount}`,
    `  total tokens:  ${totals.totalTokens}`,
    `    input:       ${totals.inputTokens}`,
    `    output:      ${totals.outputTokens}`,
    `    cache write: ${totals.cacheWriteTokens}`,
    `    cache read:  ${totals.cacheReadTokens}`,
    `  cache hit:     ${hitRate}`,
    `  cost:          ${cost}`,
    `  models:        ${result.dimensions.models.length}`,
    `  projects:      ${result.dimensions.projects.length}`,
    `  sessions:      ${result.dimensions.sessions.length}`,
    `  refreshed:     ${new Date(result.refreshedAtMs).toISOString()}`,
  ].join("\n");
}

/** One-line scan result for the refresh action / background scan status. */
export function formatScanSummary(summary: ScanSummary): string {
  const details: string[] = [];
  if (summary.sessionErrors > 0) details.push(`${summary.sessionErrors} session errors`);
  if (summary.entryErrors > 0) details.push(`${summary.entryErrors} entry errors`);
  if (summary.rebuilt) details.push("rebuild");
  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return (
    `Scan finished: ${summary.recordsMerged} records merged from ` +
    `${summary.sessionsScanned}/${summary.sessionsFound} sessions${suffix}`
  );
}
