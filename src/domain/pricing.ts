/**
 * Versioned pricing: built-in price table, validated local overrides, and
 * the recorded -> estimated -> unavailable cost policy (parent design §2.2).
 *
 * Prices are USD per 1K tokens and are a curated snapshot; provenance is
 * always marked "estimated" so stale prices are never presented as fact.
 * Unknown provider/model combinations yield no estimate and the record keeps
 * "unavailable" — a zero price is never fabricated.
 */
import type { CostBreakdown, UsageRecord } from "./types";

export const PRICE_TABLE_SCHEMA_VERSION = 1;
export const PRICE_CURRENCY = "USD";

/** Wildcard token usable in `provider`/`model` — only when explicitly authored. */
export const PRICE_WILDCARD = "*";

/** One price row: USD per 1K tokens. `provider`/`model` may be "*" as an explicit wildcard. */
export type PriceRow = {
  provider: string;
  model: string;
  inputPer1k: number;
  outputPer1k: number;
  cacheReadPer1k: number;
  cacheWritePer1k: number;
};

export type PricingTable = {
  schemaVersion: number;
  currency: string;
  rows: PriceRow[];
};

/**
 * Built-in table snapshot (list prices, approximate, as of 2025-06).
 * No wildcard rows are shipped: estimation requires a specific known row so
 * unknown models fall back to "unavailable" instead of fake precision.
 */
export const BUILTIN_PRICE_TABLE: PricingTable = {
  schemaVersion: PRICE_TABLE_SCHEMA_VERSION,
  currency: PRICE_CURRENCY,
  rows: [
    // Anthropic
    { provider: "anthropic", model: "claude-opus-4-1", inputPer1k: 0.015, outputPer1k: 0.075, cacheReadPer1k: 0.0015, cacheWritePer1k: 0.01875 },
    { provider: "anthropic", model: "claude-opus-4", inputPer1k: 0.015, outputPer1k: 0.075, cacheReadPer1k: 0.0015, cacheWritePer1k: 0.01875 },
    { provider: "anthropic", model: "claude-sonnet-4-5", inputPer1k: 0.003, outputPer1k: 0.015, cacheReadPer1k: 0.0003, cacheWritePer1k: 0.00375 },
    { provider: "anthropic", model: "claude-sonnet-4", inputPer1k: 0.003, outputPer1k: 0.015, cacheReadPer1k: 0.0003, cacheWritePer1k: 0.00375 },
    { provider: "anthropic", model: "claude-3-7-sonnet", inputPer1k: 0.003, outputPer1k: 0.015, cacheReadPer1k: 0.0003, cacheWritePer1k: 0.00375 },
    { provider: "anthropic", model: "claude-3-5-sonnet", inputPer1k: 0.003, outputPer1k: 0.015, cacheReadPer1k: 0.0003, cacheWritePer1k: 0.00375 },
    { provider: "anthropic", model: "claude-3-5-haiku", inputPer1k: 0.0008, outputPer1k: 0.004, cacheReadPer1k: 0.00008, cacheWritePer1k: 0.001 },
    { provider: "anthropic", model: "claude-3-haiku", inputPer1k: 0.00025, outputPer1k: 0.00125, cacheReadPer1k: 0.000025, cacheWritePer1k: 0.0003125 },
    { provider: "anthropic", model: "claude-3-opus", inputPer1k: 0.015, outputPer1k: 0.075, cacheReadPer1k: 0.0015, cacheWritePer1k: 0.01875 },
    // OpenAI
    { provider: "openai", model: "gpt-5", inputPer1k: 0.00125, outputPer1k: 0.01, cacheReadPer1k: 0.000125, cacheWritePer1k: 0.00125 },
    { provider: "openai", model: "gpt-5-mini", inputPer1k: 0.00025, outputPer1k: 0.002, cacheReadPer1k: 0.000025, cacheWritePer1k: 0.00025 },
    { provider: "openai", model: "gpt-5-nano", inputPer1k: 0.00005, outputPer1k: 0.0004, cacheReadPer1k: 0.000005, cacheWritePer1k: 0.00005 },
    { provider: "openai", model: "gpt-4o", inputPer1k: 0.0025, outputPer1k: 0.01, cacheReadPer1k: 0.00125, cacheWritePer1k: 0.0025 },
    { provider: "openai", model: "gpt-4o-mini", inputPer1k: 0.00015, outputPer1k: 0.0006, cacheReadPer1k: 0.000075, cacheWritePer1k: 0.00015 },
    { provider: "openai", model: "gpt-4.1", inputPer1k: 0.002, outputPer1k: 0.008, cacheReadPer1k: 0.0005, cacheWritePer1k: 0.002 },
    { provider: "openai", model: "gpt-4.1-mini", inputPer1k: 0.0004, outputPer1k: 0.0016, cacheReadPer1k: 0.0001, cacheWritePer1k: 0.0004 },
    { provider: "openai", model: "gpt-4.1-nano", inputPer1k: 0.0001, outputPer1k: 0.0004, cacheReadPer1k: 0.000025, cacheWritePer1k: 0.0001 },
    { provider: "openai", model: "o4-mini", inputPer1k: 0.0011, outputPer1k: 0.0044, cacheReadPer1k: 0.00055, cacheWritePer1k: 0.0011 },
    { provider: "openai", model: "o3", inputPer1k: 0.01, outputPer1k: 0.04, cacheReadPer1k: 0.005, cacheWritePer1k: 0.01 },
    // Google
    { provider: "google", model: "gemini-2.5-pro", inputPer1k: 0.00125, outputPer1k: 0.01, cacheReadPer1k: 0.0000625, cacheWritePer1k: 0.005 },
    { provider: "google", model: "gemini-2.5-flash", inputPer1k: 0.0003, outputPer1k: 0.0025, cacheReadPer1k: 0.000015, cacheWritePer1k: 0.00125 },
    { provider: "google", model: "gemini-2.0-flash", inputPer1k: 0.0001, outputPer1k: 0.0004, cacheReadPer1k: 0.000005, cacheWritePer1k: 0.0001 },
    // DeepSeek
    { provider: "deepseek", model: "deepseek-chat", inputPer1k: 0.00027, outputPer1k: 0.0011, cacheReadPer1k: 0.00007, cacheWritePer1k: 0.0011 },
    { provider: "deepseek", model: "deepseek-reasoner", inputPer1k: 0.00055, outputPer1k: 0.00219, cacheReadPer1k: 0.00014, cacheWritePer1k: 0.00219 },
  ],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const validKey = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const validPrice = (value: unknown): number | null => (isFiniteNonNegative(value) ? value : null);

const validatePriceRow = (value: unknown): PriceRow | null => {
  if (!isObject(value)) return null;
  const provider = validKey(value.provider);
  const model = validKey(value.model);
  if (provider === null || model === null) return null;
  const inputPer1k = validPrice(value.inputPer1k);
  const outputPer1k = validPrice(value.outputPer1k);
  const cacheReadPer1k = validPrice(value.cacheReadPer1k);
  const cacheWritePer1k = validPrice(value.cacheWritePer1k);
  if (inputPer1k === null || outputPer1k === null || cacheReadPer1k === null || cacheWritePer1k === null) {
    return null;
  }
  return { provider, model, inputPer1k, outputPer1k, cacheReadPer1k, cacheWritePer1k };
};

/**
 * Validate an override table. Returns null for any structural problem —
 * overrides are all-or-nothing: an invalid file is ignored entirely, never
 * partially applied (DC4). A mismatched schema version or a non-USD currency
 * (no conversion path) is also rejected.
 */
export function validatePricingTable(value: unknown): PricingTable | null {
  if (!isObject(value)) return null;
  if (value.schemaVersion !== PRICE_TABLE_SCHEMA_VERSION) return null;
  if (value.currency !== undefined && value.currency !== PRICE_CURRENCY) return null;
  if (!Array.isArray(value.rows)) return null;
  const rows: PriceRow[] = [];
  for (const raw of value.rows) {
    const row = validatePriceRow(raw);
    if (row === null) return null;
    rows.push(row);
  }
  return { schemaVersion: PRICE_TABLE_SCHEMA_VERSION, currency: PRICE_CURRENCY, rows };
}

/** Parse and validate an override file's JSON text. Returns null on any failure. */
export function parsePricingTableJson(text: string): PricingTable | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return validatePricingTable(value);
}

/**
 * Merge tables with earlier tables taking precedence (used as
 * `mergePricingTables(override, BUILTIN_PRICE_TABLE)` so local overrides win
 * on exact key matches). Rows keep their own order within each table.
 */
export function mergePricingTables(...tables: readonly PricingTable[]): PricingTable {
  const rows: PriceRow[] = [];
  for (const table of tables) rows.push(...table.rows);
  return { schemaVersion: PRICE_TABLE_SCHEMA_VERSION, currency: PRICE_CURRENCY, rows };
}

/**
 * Find the best price row for a provider/model. Precedence is deterministic
 * regardless of row order: exact key > provider wildcard > model wildcard >
 * both wildcards. Empty provider/model never match.
 */
export function findPriceRow(table: PricingTable, provider: string, model: string): PriceRow | undefined {
  if (provider === "" || model === "") return undefined;
  const exact = table.rows.find((r) => r.provider === provider && r.model === model);
  if (exact) return exact;
  const providerWildcard = table.rows.find((r) => r.provider === provider && r.model === PRICE_WILDCARD);
  if (providerWildcard) return providerWildcard;
  const modelWildcard = table.rows.find((r) => r.provider === PRICE_WILDCARD && r.model === model);
  if (modelWildcard) return modelWildcard;
  return table.rows.find((r) => r.provider === PRICE_WILDCARD && r.model === PRICE_WILDCARD);
}

/**
 * Estimate a cost breakdown from the price table. Returns null when no row
 * matches (costKind stays "unavailable" — token metrics are unaffected).
 */
export function resolveCostEstimate(
  provider: string,
  model: string,
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  table: PricingTable = BUILTIN_PRICE_TABLE,
): CostBreakdown | null {
  const row = findPriceRow(table, provider, model);
  if (!row) return null;
  const input = (tokens.inputTokens * row.inputPer1k) / 1000;
  const output = (tokens.outputTokens * row.outputPer1k) / 1000;
  const cacheRead = (tokens.cacheReadTokens * row.cacheReadPer1k) / 1000;
  const cacheWrite = (tokens.cacheWriteTokens * row.cacheWritePer1k) / 1000;
  const total = input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
}

/**
 * Apply the cost policy to a normalized record:
 *   valid recorded cost -> keep "recorded";
 *   otherwise estimate from the price table -> "estimated";
 *   unknown price -> "unavailable" (never a fabricated zero);
 *   no tokens at all -> stays "unavailable": a zero-token record has
 *   nothing to estimate, and a fabricated $0 would misread missing usage
 *   as free usage (spec: never treat missing cost as 0).
 * Returns a new record; the input is not mutated.
 */
export function applyCostPolicy(record: UsageRecord, table: PricingTable = BUILTIN_PRICE_TABLE): UsageRecord {
  if (record.costKind === "recorded") return record;
  if (record.totalTokens === 0) return record;
  const estimate = resolveCostEstimate(record.provider, record.model, record, table);
  if (estimate) {
    return { ...record, estimatedCost: estimate, costKind: "estimated" };
  }
  return { ...record, costKind: "unavailable" };
}
