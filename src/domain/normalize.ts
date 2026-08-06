/**
 * Defensive normalization: untrusted Pi payloads / session JSONL -> UsageRecord.
 *
 * This module is the single owner of the `Usage` -> `UsageRecord` conversion
 * (see .trellis/spec/typescript/type-safety.md). It never throws on malformed
 * input: token counts degrade to zero and cost degrades to "unavailable".
 * The canonical token total is always recomputed — payload `totalTokens` is
 * never trusted.
 */
import type { CostBreakdown, CostKind, SourceKind, UsageRecord } from "./types";
import { makeRecordId } from "./dedupe";

/** Identity of the source session entry; supplied by the collector/scanner. */
export type SessionContext = {
  sessionId: string;
  sessionPath: string;
  projectCwd: string;
  entryId: string;
};

/** The normalized, validated numeric core of a usage payload. */
export type NormalizedUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Present only when the recorded cost validated (all five fields finite non-negative). */
  recordedCost?: CostBreakdown;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Token counts are discrete; anything non-numeric, non-finite, or negative
 * degrades to zero, and fractional values are floored.
 */
const tokenCount = (value: unknown): number => {
  if (!isFiniteNonNegative(value)) return 0;
  return Number.isInteger(value) ? value : Math.floor(value);
};

const readString = (value: unknown): string => (typeof value === "string" ? value : "");

/** Fallback for a missing/invalid timestamp: "now". */
const readTimestampMs = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : Date.now();

/**
 * Validate a recorded Pi cost object. All five documented fields must be
 * present and finite non-negative. The provider-reported `total` is kept
 * as-is: Pi's own aggregation sums `usage.cost.total` (see
 * `dist/core/usage-totals.js`), so recomputing the total from components
 * would drift from Pi's built-in recorded-cost display and introduce
 * floating-point noise (e.g. 0.1 + 0.2 !== 0.3).
 */
const extractRecordedCost = (value: unknown): CostBreakdown | undefined => {
  if (!isObject(value)) return undefined;
  const input = value.input;
  const output = value.output;
  const cacheRead = value.cacheRead;
  const cacheWrite = value.cacheWrite;
  const total = value.total;
  if (
    !isFiniteNonNegative(input) ||
    !isFiniteNonNegative(output) ||
    !isFiniteNonNegative(cacheRead) ||
    !isFiniteNonNegative(cacheWrite) ||
    !isFiniteNonNegative(total)
  ) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, total };
};

/**
 * Normalize a Pi usage payload (tokens + optional recorded cost) without
 * throwing. A missing/malformed payload yields a safe all-zero core.
 */
export function normalizeUsage(usage: unknown): NormalizedUsage {
  if (!isObject(usage)) {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  }
  const inputTokens = tokenCount(usage.input);
  const outputTokens = tokenCount(usage.output);
  const cacheReadTokens = tokenCount(usage.cacheRead);
  const cacheWriteTokens = tokenCount(usage.cacheWrite);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const recordedCost = extractRecordedCost(usage.cost);
  if (recordedCost) {
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, recordedCost };
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
}

type BuildInput = {
  sessionId: string;
  sessionPath: string;
  projectCwd: string;
  entryId: string;
  timestampMs: number;
  provider: string;
  model: string;
  sourceKind: SourceKind;
  usage: NormalizedUsage;
};

const buildRecord = (input: BuildInput): UsageRecord => {
  const { sessionId, entryId, usage, sourceKind, ...rest } = input;
  const costKind: CostKind = usage.recordedCost ? "recorded" : "unavailable";
  const record: UsageRecord = {
    recordId: makeRecordId(sessionId, entryId),
    sessionId,
    sessionPath: rest.sessionPath,
    projectCwd: rest.projectCwd,
    timestampMs: rest.timestampMs,
    provider: rest.provider,
    model: rest.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    requestCount: 1,
    costKind,
    sourceEntryId: entryId,
    sourceKind,
  };
  if (usage.recordedCost) {
    record.recordedCost = usage.recordedCost;
  }
  return record;
};

/**
 * Normalize a finalized Pi assistant message into one canonical record.
 * Returns null when the payload is not an assistant message at all; a
 * missing/malformed `usage` still yields a record with zero tokens and
 * "unavailable" cost (DC1).
 */
export function normalizeAssistantMessage(message: unknown, ctx: SessionContext): UsageRecord | null {
  if (!isObject(message) || message.role !== "assistant") return null;
  return buildRecord({
    sessionId: ctx.sessionId,
    sessionPath: ctx.sessionPath,
    projectCwd: ctx.projectCwd,
    entryId: ctx.entryId,
    timestampMs: readTimestampMs(message.timestamp),
    provider: readString(message.provider),
    model: readString(message.model),
    sourceKind: "assistant",
    usage: normalizeUsage(message.usage),
  });
}

/** Extra context for summary usage (compaction / branch summaries). */
export type SummaryContext = SessionContext & {
  provider?: string;
  model?: string;
  timestampMs?: number;
};

/**
 * Normalize summary-generation usage (compaction / branch summaries) into a
 * record with `sourceKind: "summary"`. Returns null when there is no usage
 * payload at all — a summary without usage is nothing to count — while any
 * present-but-malformed payload still normalizes defensively.
 */
export function normalizeSummaryUsage(usage: unknown, ctx: SummaryContext): UsageRecord | null {
  if (usage === undefined || usage === null) return null;
  return buildRecord({
    sessionId: ctx.sessionId,
    sessionPath: ctx.sessionPath,
    projectCwd: ctx.projectCwd,
    entryId: ctx.entryId,
    timestampMs: ctx.timestampMs ?? Date.now(),
    provider: ctx.provider ?? "",
    model: ctx.model ?? "",
    sourceKind: "summary",
    usage: normalizeUsage(usage),
  });
}
