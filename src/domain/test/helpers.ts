/**
 * Test helper: build a complete UsageRecord with sane defaults so tests can
 * override only the fields they care about.
 */
import type { CostBreakdown, UsageRecord } from "../types";

export type RecordOverrides = Partial<
  Pick<
    UsageRecord,
    | "sessionId"
    | "sessionPath"
    | "projectCwd"
    | "timestampMs"
    | "provider"
    | "model"
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "costKind"
    | "sourceEntryId"
    | "sourceKind"
  >
> & {
  recordedCost?: CostBreakdown;
  estimatedCost?: CostBreakdown;
};

export const makeRecord = (overrides: RecordOverrides = {}): UsageRecord => {
  const inputTokens = overrides.inputTokens ?? 0;
  const outputTokens = overrides.outputTokens ?? 0;
  const cacheReadTokens = overrides.cacheReadTokens ?? 0;
  const cacheWriteTokens = overrides.cacheWriteTokens ?? 0;
  const sessionId = overrides.sessionId ?? "session-1";
  const sourceEntryId = overrides.sourceEntryId ?? "entry-1";
  const recordId = `${sessionId}:${sourceEntryId}`;
  const costKind = overrides.costKind ?? (overrides.recordedCost ? "recorded" : "unavailable");
  const record: UsageRecord = {
    recordId,
    sessionId,
    sessionPath: overrides.sessionPath ?? "/sessions/session-1.jsonl",
    projectCwd: overrides.projectCwd ?? "/projects/project-a",
    timestampMs: overrides.timestampMs ?? 1_700_000_000_000,
    provider: overrides.provider ?? "anthropic",
    model: overrides.model ?? "claude-sonnet-4-5",
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    requestCount: 1,
    costKind,
    sourceEntryId,
    sourceKind: overrides.sourceKind ?? "assistant",
  };
  if (overrides.recordedCost) record.recordedCost = overrides.recordedCost;
  if (overrides.estimatedCost) record.estimatedCost = overrides.estimatedCost;
  return record;
};

export const cost = (input: number, output: number, cacheRead: number, cacheWrite: number): CostBreakdown => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  total: input + output + cacheRead + cacheWrite,
});
