import { describe, expect, it } from "vitest";
import {
  BUILTIN_PRICE_TABLE,
  PRICE_CURRENCY,
  PRICE_TABLE_SCHEMA_VERSION,
  applyCostPolicy,
  findPriceRow,
  mergePricingTables,
  parsePricingTableJson,
  resolveCostEstimate,
  validatePricingTable,
  type PricingTable,
} from "../pricing";
import { makeRecord } from "./helpers";
import { normalizeAssistantMessage } from "../normalize";

const validTable = (): PricingTable => ({
  schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
  currency: PRICE_CURRENCY,
  rows: [
    { provider: "acme", model: "m1", inputPer1k: 0.01, outputPer1k: 0.02, cacheReadPer1k: 0.001, cacheWritePer1k: 0.01 },
    { provider: "acme", model: "m2", inputPer1k: 0.1, outputPer1k: 0.2, cacheReadPer1k: 0.01, cacheWritePer1k: 0.1 },
  ],
});

describe("built-in price table", () => {
  it("is versioned and keyed by provider/model with USD prices", () => {
    expect(BUILTIN_PRICE_TABLE.schemaVersion).toBe(1);
    expect(BUILTIN_PRICE_TABLE.currency).toBe("USD");
    expect(BUILTIN_PRICE_TABLE.rows.length).toBeGreaterThan(0);
    for (const row of BUILTIN_PRICE_TABLE.rows) {
      expect(row.provider).not.toBe("");
      expect(row.model).not.toBe("");
      for (const price of [row.inputPer1k, row.outputPer1k, row.cacheReadPer1k, row.cacheWritePer1k]) {
        expect(Number.isFinite(price)).toBe(true);
        expect(price).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("estimates a known model from the built-in table", () => {
    const estimate = resolveCostEstimate("anthropic", "claude-sonnet-4-5", {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(estimate).toEqual({ input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0, total: 0.018 });
  });

  it("returns null for unknown provider/model — never a fabricated price", () => {
    expect(resolveCostEstimate("acme", "unknown-model", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
    expect(resolveCostEstimate("", "claude-sonnet-4-5", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });
});

describe("findPriceRow precedence", () => {
  const wildcardTable: PricingTable = {
    schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
    currency: PRICE_CURRENCY,
    rows: [
      { provider: "acme", model: "*", inputPer1k: 1, outputPer1k: 1, cacheReadPer1k: 1, cacheWritePer1k: 1 },
      { provider: "*", model: "m1", inputPer1k: 2, outputPer1k: 2, cacheReadPer1k: 2, cacheWritePer1k: 2 },
      { provider: "acme", model: "m1", inputPer1k: 3, outputPer1k: 3, cacheReadPer1k: 3, cacheWritePer1k: 3 },
      { provider: "*", model: "*", inputPer1k: 4, outputPer1k: 4, cacheReadPer1k: 4, cacheWritePer1k: 4 },
    ],
  };

  it("prefers exact key, then provider wildcard, then model wildcard, then both", () => {
    expect(findPriceRow(wildcardTable, "acme", "m1")!.inputPer1k).toBe(3);
    expect(findPriceRow(wildcardTable, "acme", "other")!.inputPer1k).toBe(1);
    expect(findPriceRow(wildcardTable, "other", "m1")!.inputPer1k).toBe(2);
    expect(findPriceRow(wildcardTable, "other", "other")!.inputPer1k).toBe(4);
  });
});

describe("override loading and precedence (DC4)", () => {
  it("rejects invalid override files entirely (all-or-nothing)", () => {
    expect(parsePricingTableJson("{ not json")).toBeNull();
    expect(parsePricingTableJson("42")).toBeNull();
    expect(parsePricingTableJson(JSON.stringify({ schemaVersion: 2, currency: "USD", rows: [] }))).toBeNull();
    expect(parsePricingTableJson(JSON.stringify({ schemaVersion: 1, currency: "EUR", rows: [] }))).toBeNull();
    expect(parsePricingTableJson(JSON.stringify({ schemaVersion: 1, currency: "USD", rows: "x" }))).toBeNull();
    expect(
      parsePricingTableJson(
        JSON.stringify({ schemaVersion: 1, currency: "USD", rows: [{ provider: "acme", model: "m1", inputPer1k: -1, outputPer1k: 0, cacheReadPer1k: 0, cacheWritePer1k: 0 }] }),
      ),
    ).toBeNull();
    expect(
      parsePricingTableJson(
        JSON.stringify({ schemaVersion: 1, currency: "USD", rows: [{ provider: "", model: "m1", inputPer1k: 1, outputPer1k: 0, cacheReadPer1k: 0, cacheWritePer1k: 0 }] }),
      ),
    ).toBeNull();
  });

  it("accepts a structurally valid override table", () => {
    const override = parsePricingTableJson(
      JSON.stringify({
        schemaVersion: 1,
        currency: "USD",
        rows: [{ provider: "anthropic", model: "claude-sonnet-4-5", inputPer1k: 0.5, outputPer1k: 1, cacheReadPer1k: 0.05, cacheWritePer1k: 0.6 }],
      }),
    );
    expect(override).not.toBeNull();
    expect(validatePricingTable(validTable())).not.toBeNull();
  });

  it("override exact key wins over the built-in price", () => {
    const override = parsePricingTableJson(
      JSON.stringify({
        schemaVersion: 1,
        currency: "USD",
        rows: [{ provider: "anthropic", model: "claude-sonnet-4-5", inputPer1k: 0.5, outputPer1k: 1, cacheReadPer1k: 0.05, cacheWritePer1k: 0.6 }],
      }),
    )!;
    const merged = mergePricingTables(override, BUILTIN_PRICE_TABLE);
    const estimate = resolveCostEstimate("anthropic", "claude-sonnet-4-5", {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }, merged);
    expect(estimate!.total).toBe(1.5);
  });

  it("unknown keys still resolve from the built-in table when an override exists", () => {
    const override = parsePricingTableJson(
      JSON.stringify({
        schemaVersion: 1,
        currency: "USD",
        rows: [{ provider: "anthropic", model: "claude-sonnet-4-5", inputPer1k: 0.5, outputPer1k: 1, cacheReadPer1k: 0.05, cacheWritePer1k: 0.6 }],
      }),
    )!;
    const merged = mergePricingTables(override, BUILTIN_PRICE_TABLE);
    const estimate = resolveCostEstimate("openai", "gpt-4o", {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }, merged);
    expect(estimate!.total).toBe(0.0125);
  });
});

describe("normalize -> cost policy (DC3 end-to-end)", () => {
  const ctx = { sessionId: "sess-e2e", sessionPath: "/sessions/sess-e2e.jsonl", projectCwd: "/projects/p1", entryId: "entry-1" };

  it("upgrades a normalized record to estimated when the price is known", () => {
    const record = normalizeAssistantMessage(
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        timestamp: 1_700_000_000_000,
        usage: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 },
      },
      ctx,
    );
    const result = applyCostPolicy(record!);
    expect(result.costKind).toBe("estimated");
    expect(result.estimatedCost!.total).toBe(0.018);
    expect(result.totalTokens).toBe(2000);
  });

  it("keeps a validated recorded cost as recorded through the policy", () => {
    const record = normalizeAssistantMessage(
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        timestamp: 1_700_000_000_000,
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
        },
      },
      ctx,
    );
    const result = applyCostPolicy(record!);
    expect(result.costKind).toBe("recorded");
    expect(result.recordedCost!.total).toBe(0.3);
    expect(result.estimatedCost).toBeUndefined();
  });

  it("stays unavailable end-to-end for an unknown model and keeps token metrics", () => {
    const record = normalizeAssistantMessage(
      {
        role: "assistant",
        provider: "local",
        model: "ollama-x",
        timestamp: 1_700_000_000_000,
        usage: { input: 100, output: 100 },
      },
      ctx,
    );
    const result = applyCostPolicy(record!);
    expect(result.costKind).toBe("unavailable");
    expect(result.estimatedCost).toBeUndefined();
    expect(result.totalTokens).toBe(200);
  });
});

describe("applyCostPolicy", () => {
  it("keeps a recorded cost untouched", () => {
    const record = makeRecord({ recordedCost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } });
    const result = applyCostPolicy(record);
    expect(result.costKind).toBe("recorded");
    expect(result.recordedCost!.total).toBe(3);
    expect(result.estimatedCost).toBeUndefined();
  });

  it("falls back to estimated for an all-zero recorded cost when the price is known (Pi writes zero placeholders for unpriced models)", () => {
    const record = makeRecord({
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      recordedCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    expect(record.costKind).toBe("recorded");
    const result = applyCostPolicy(record);
    expect(result.costKind).toBe("estimated");
    expect(result.estimatedCost!.total).toBe(0.018);
  });

  it("keeps an all-zero recorded cost when no price is known (no fabricated spend)", () => {
    const record = makeRecord({
      provider: "local",
      model: "ollama-xyz",
      inputTokens: 500,
      outputTokens: 250,
      recordedCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const result = applyCostPolicy(record);
    expect(result.costKind).toBe("recorded");
    expect(result.estimatedCost).toBeUndefined();
  });

  it("upgrades unavailable to estimated when a price is known", () => {
    const record = makeRecord({ inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(record.costKind).toBe("unavailable");
    const result = applyCostPolicy(record);
    expect(result.costKind).toBe("estimated");
    expect(result.estimatedCost!.total).toBe(0.018);
  });

  it("stays unavailable for unknown prices and preserves token metrics (DC3)", () => {
    const record = makeRecord({ provider: "local", model: "ollama-xyz", inputTokens: 500, outputTokens: 250 });
    const result = applyCostPolicy(record);
    expect(result.costKind).toBe("unavailable");
    expect(result.estimatedCost).toBeUndefined();
    expect(result.inputTokens).toBe(500);
    expect(result.outputTokens).toBe(250);
    expect(result.totalTokens).toBe(750);
  });

  it("is pure — the input record is not mutated", () => {
    const record = makeRecord({ inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    applyCostPolicy(record);
    expect(record.costKind).toBe("unavailable");
    expect(record.estimatedCost).toBeUndefined();
  });

  it("stays unavailable for a zero-token record even when the price is known (missing usage is not free)", () => {
    const record = makeRecord(); // anthropic/claude-sonnet-4-5, price known, zero tokens
    expect(record.totalTokens).toBe(0);
    const result = applyCostPolicy(record);
    expect(result.costKind).toBe("unavailable");
    expect(result.estimatedCost).toBeUndefined();
  });
});
