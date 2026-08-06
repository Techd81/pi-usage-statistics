/**
 * Live `message_end` collector (design §7; RC1/RC2).
 *
 * Recording rule:
 * - assistant messages -> exactly one normalized record (`sourceKind:
 *   "assistant"`) per stable recordId. Pi persists the session entry only
 *   AFTER `message_end` fires, so the future entry.id is not knowable at event
 *   time; the live identity therefore uses the shared domain rule
 *   `assistantMessageEntryId` (`responseId` when present, else `timestamp +
 *   content fingerprint`), which is the SAME rule the session scanner uses.
 *   A missing/malformed usage still yields a zero-token record so
 *   requestCount stays accurate (DC1).
 * - toolResult messages carrying `usage` -> one `sourceKind: "summary"`
 *   record keyed by toolCallId. The scanner never records tool usage, so the
 *   live event is the only path for it (documented rule: summaries are
 *   tracked separately and included only per query flag).
 * - `message_update` is deliberately NOT subscribed anywhere in the runtime:
 *   streaming updates never create records (RC2).
 *
 * Reconciliation rule (documented): live records and scanned records share
 * the domain identity rule (responseId / timestamp+content fingerprint) and
 * the store upserts by recordId, so re-delivery and re-scanning never change
 * totals for the same message. Legacy session entries without a responseId
 * fall back to the session entry id on the scan side only — the documented
 * corner case where a live fingerprint record and a scanned entry-id record
 * could coexist is limited to messages missing BOTH responseId and timestamp.
 */
import type { ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import type { UsageRecord } from "../domain";
import { applyCostPolicy, assistantMessageEntryId, normalizeAssistantMessage, normalizeSummaryUsage } from "../domain";
import type { UsageStore } from "../storage";

export type SessionIdentity = {
  sessionId: string;
  sessionPath: string;
  projectCwd: string;
};

/** Session identity for live events, read from the extension context. */
export function sessionIdentityFromContext(ctx: ExtensionContext): SessionIdentity {
  const manager = ctx.sessionManager;
  return {
    sessionId: manager.getSessionId() ?? "",
    // Ephemeral sessions have no backing file yet; "" keeps records valid.
    sessionPath: manager.getSessionFile() ?? "",
    projectCwd: manager.getCwd() ?? ctx.cwd ?? "",
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown): string => (typeof value === "string" ? value : "");

const readTimestampMs = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : Date.now();

/** Apply the cost policy (recorded -> estimated -> unavailable) and upsert. */
function upsertPriced(store: UsageStore, record: UsageRecord): UsageRecord {
  const priced = applyCostPolicy(record);
  store.upsertRecord(priced);
  return priced;
}

/**
 * Collect usage from a finalized message. Returns the stored record, or null
 * when the message carries nothing countable. Never throws.
 */
export function collectMessageEnd(
  store: UsageStore,
  event: MessageEndEvent,
  ctx: ExtensionContext,
): UsageRecord | null {
  const message = event.message;
  const identity = sessionIdentityFromContext(ctx);
  const role = isObject(message) ? readString(message.role) : "";

  if (role === "assistant") {
    const record = normalizeAssistantMessage(message, { ...identity, entryId: assistantMessageEntryId(message, "") });
    return record ? upsertPriced(store, record) : null;
  }

  if (role === "toolResult") {
    const usage = isObject(message) ? message.usage : undefined;
    if (usage === undefined || usage === null) return null; // a summary without usage counts nothing
    const toolCallId = isObject(message) ? readString(message.toolCallId) : "";
    const record = normalizeSummaryUsage(usage, {
      ...identity,
      entryId: toolCallId !== "" ? `summary:${toolCallId}` : assistantMessageEntryId(message, ""),
      timestampMs: isObject(message) ? readTimestampMs(message.timestamp) : Date.now(),
    });
    return record ? upsertPriced(store, record) : null;
  }

  return null;
}
