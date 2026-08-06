/**
 * Shared test helpers: build session JSONL fixtures and UsageRecords.
 */
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CostBreakdown, UsageRecord } from "../../domain";

export type FixtureEntry = {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  message?: Record<string, unknown>;
  usage?: unknown;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  fromId?: string;
};

export const headerLine = (id: string, cwd: string): string =>
  JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-06T00:00:00.000Z", cwd });

/** Build one JSONL line from a fixture entry. */
export const entryLine = (entry: FixtureEntry): string => JSON.stringify(entry);

/**
 * Create a temp session directory containing the given session files.
 * Each file is `{ "name": [lines...] }`; a string line is written verbatim
 * (allows malformed/truncated fixtures).
 */
export async function makeSessionDir(files: Record<string, (string | FixtureEntry)[]>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-usage-sessions-"));
  for (const [name, lines] of Object.entries(files)) {
    const text = lines
      .map((line) => (typeof line === "string" ? line : entryLine(line)))
      .join("\n");
    await writeFile(join(dir, name), text, "utf8");
  }
  return dir;
}

/** Write an arbitrary file into a directory (e.g. store dir fixtures). */
export async function writeStoreFile(dir: string, name: string, contents: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), contents, "utf8");
}

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
    sessionPath: overrides.sessionPath ?? `/sessions/${sessionId}.jsonl`,
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

export const assistantEntry = (id: string, overrides: Record<string, unknown> = {}): FixtureEntry => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-08-06T00:01:00.000Z",
  message: {
    role: "assistant",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
    ...overrides,
  },
});
