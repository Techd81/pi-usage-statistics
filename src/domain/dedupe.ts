/**
 * Record identity and deduplication policy (parent design §2.4).
 *
 * `recordId` is the single source identity shared by live `message_end`
 * records and scanned session entries. Upserts replace by `recordId` — a
 * second occurrence never adds a second copy.
 */
import type { UsageRecord } from "./types";

/**
 * Canonical stable identity: `${sessionId}:${entryId}`. The same record
 * arriving from a live event and from a session scan maps to the same key.
 */
export function makeRecordId(sessionId: string, entryId: string): string {
  return `${sessionId}:${entryId}`;
}

/** Upsert a record by `recordId`: replaces an existing record, otherwise appends. */
export function upsertRecord(records: readonly UsageRecord[], record: UsageRecord): UsageRecord[] {
  const next = [...records];
  const index = next.findIndex((existing) => existing.recordId === record.recordId);
  if (index === -1) next.push(record);
  else next[index] = record;
  return next;
}

/** Bulk upsert; on a `recordId` collision the later record wins. */
export function mergeRecords(base: readonly UsageRecord[], incoming: readonly UsageRecord[]): UsageRecord[] {
  const byId = new Map<string, UsageRecord>();
  for (const record of base) byId.set(record.recordId, record);
  for (const record of incoming) byId.set(record.recordId, record);
  return [...byId.values()];
}

/** Index records by `recordId` (last occurrence wins). */
export function indexByRecordId(records: readonly UsageRecord[]): Map<string, UsageRecord> {
  const byId = new Map<string, UsageRecord>();
  for (const record of records) byId.set(record.recordId, record);
  return byId;
}
