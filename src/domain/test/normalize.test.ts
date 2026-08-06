import { describe, expect, it } from "vitest";
import {
  normalizeAssistantMessage,
  normalizeSummaryUsage,
  normalizeUsage,
  type SessionContext,
} from "../normalize";

const ctx: SessionContext = {
  sessionId: "sess-abc",
  sessionPath: "/sessions/sess-abc.jsonl",
  projectCwd: "/projects/p1",
  entryId: "entry-7",
};

const assistant = (overrides: Record<string, unknown> = {}) => ({
  role: "assistant",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  timestamp: 1_700_000_000_000,
  usage: { input: 100, output: 200, cacheRead: 300, cacheWrite: 400, totalTokens: 99_999 },
  ...overrides,
});

describe("normalizeUsage", () => {
  it("degrades missing/malformed payloads to a safe all-zero core without throwing (DC1)", () => {
    for (const bad of [undefined, null, 42, "usage", [], true]) {
      expect(normalizeUsage(bad)).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      });
    }
  });

  it("degrades non-finite and negative token fields individually (DC1)", () => {
    const result = normalizeUsage({
      input: NaN,
      output: -5,
      cacheRead: 1.9,
      cacheWrite: "12",
      totalTokens: 1_000_000,
    });
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(1);
    expect(result.cacheWriteTokens).toBe(0);
    expect(result.totalTokens).toBe(1);
  });

  it("recomputes the canonical total and never trusts payload totalTokens", () => {
    const result = normalizeUsage({ input: 100, output: 200, cacheRead: 300, cacheWrite: 400, totalTokens: 123 });
    expect(result.totalTokens).toBe(1000);
  });

  it("accepts a valid recorded cost and keeps the provider-reported total (Pi cost.total semantics)", () => {
    const result = normalizeUsage({
      input: 100,
      output: 200,
      cacheRead: 300,
      cacheWrite: 400,
      totalTokens: 1000,
      cost: { input: 0.5, output: 1, cacheRead: 0.25, cacheWrite: 2, total: 3.75 },
    });
    expect(result.recordedCost).toEqual({ input: 0.5, output: 1, cacheRead: 0.25, cacheWrite: 2, total: 3.75 });
  });

  it("preserves the reported total exactly without floating-point recomputation drift", () => {
    const result = normalizeUsage({
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
    });
    expect(result.recordedCost!.total).toBe(0.3);
  });

  it("rejects recorded cost with missing, negative, or non-finite fields", () => {
    const badCosts = [
      { input: 0.5, output: 1, cacheRead: 0.25, cacheWrite: 2 },
      { input: 0.5, output: -1, cacheRead: 0.25, cacheWrite: 2, total: 1 },
      { input: 0.5, output: 1, cacheRead: 0.25, cacheWrite: 2, total: Infinity },
      { input: "0.5", output: 1, cacheRead: 0.25, cacheWrite: 2, total: 3 },
      null,
      "cost",
    ];
    for (const bad of badCosts) {
      expect(normalizeUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: bad }).recordedCost).toBeUndefined();
    }
  });
});

describe("normalizeAssistantMessage", () => {
  it("builds a canonical record with stable identity and assistant sourceKind", () => {
    const record = normalizeAssistantMessage(assistant(), ctx);
    expect(record).not.toBeNull();
    expect(record!.recordId).toBe("sess-abc:entry-7");
    expect(record!.sessionId).toBe("sess-abc");
    expect(record!.sessionPath).toBe("/sessions/sess-abc.jsonl");
    expect(record!.projectCwd).toBe("/projects/p1");
    expect(record!.sourceEntryId).toBe("entry-7");
    expect(record!.sourceKind).toBe("assistant");
    expect(record!.requestCount).toBe(1);
    expect(record!.provider).toBe("anthropic");
    expect(record!.model).toBe("claude-sonnet-4-5");
    expect(record!.timestampMs).toBe(1_700_000_000_000);
    expect(record!.totalTokens).toBe(1000);
  });

  it("yields a zero-token record with unavailable cost for a missing usage object (DC1)", () => {
    const record = normalizeAssistantMessage(assistant({ usage: undefined }), ctx);
    expect(record).not.toBeNull();
    expect(record!.totalTokens).toBe(0);
    expect(record!.costKind).toBe("unavailable");
    expect(record!.recordedCost).toBeUndefined();
    expect(record!.requestCount).toBe(1);
  });

  it("marks costKind recorded when the recorded cost validates", () => {
    const record = normalizeAssistantMessage(
      assistant({ usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } } }),
      ctx,
    );
    expect(record!.costKind).toBe("recorded");
    expect(record!.recordedCost).toBeDefined();
    expect(record!.estimatedCost).toBeUndefined();
  });

  it("keeps token metrics when recorded cost is invalid, with unavailable cost", () => {
    const record = normalizeAssistantMessage(
      assistant({ usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 0, cost: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
      ctx,
    );
    expect(record!.inputTokens).toBe(10);
    expect(record!.totalTokens).toBe(35);
    expect(record!.costKind).toBe("unavailable");
  });

  it("returns null for non-assistant payloads", () => {
    for (const bad of [null, 42, "msg", [], { role: "user" }, { role: "toolResult" }]) {
      expect(normalizeAssistantMessage(bad, ctx)).toBeNull();
    }
  });

  it("falls back to now for a missing timestamp and empty strings for missing provider/model", () => {
    const before = Date.now();
    const record = normalizeAssistantMessage(assistant({ timestamp: undefined, provider: undefined, model: 5 }), ctx);
    const after = Date.now();
    expect(record!.timestampMs).toBeGreaterThanOrEqual(before);
    expect(record!.timestampMs).toBeLessThanOrEqual(after);
    expect(record!.provider).toBe("");
    expect(record!.model).toBe("");
  });
});

describe("normalizeSummaryUsage", () => {
  it("builds a summary record with sourceKind summary", () => {
    const record = normalizeSummaryUsage({ input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 }, {
      ...ctx,
      provider: "openai",
      model: "gpt-4o",
      timestampMs: 1_700_000_000_500,
    });
    expect(record).not.toBeNull();
    expect(record!.sourceKind).toBe("summary");
    expect(record!.recordId).toBe("sess-abc:entry-7");
    expect(record!.totalTokens).toBe(30);
    expect(record!.timestampMs).toBe(1_700_000_000_500);
  });

  it("returns null when there is no usage at all", () => {
    for (const missing of [undefined, null]) {
      expect(normalizeSummaryUsage(missing, ctx)).toBeNull();
    }
  });

  it("still normalizes a malformed summary usage defensively", () => {
    const record = normalizeSummaryUsage({ input: NaN, output: 3, cacheRead: "x", cacheWrite: -2 }, ctx);
    expect(record!.inputTokens).toBe(0);
    expect(record!.outputTokens).toBe(3);
    expect(record!.totalTokens).toBe(3);
    expect(record!.costKind).toBe("unavailable");
  });
});
