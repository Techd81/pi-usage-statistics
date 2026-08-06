/**
 * HTTP API parameter parsing and validation for the dashboard server.
 *
 * This module owns the query-string -> UsageFilters boundary (spec
 * type-safety.md: decode once at the boundary, project everywhere else).
 * Parsing is strict: numbers must be plain non-negative decimal integers,
 * arrays are comma-separated, booleans are literal "true"/"false". Every
 * failure returns a bounded `{ error }` payload that the server maps to a
 * 400 response. The domain's `validateFilters` remains the single structural
 * gate after the string-to-value decode.
 */
import type { UsageFilters, UsageQueryResult } from "../domain";
import { DEFAULT_BUCKET_MS, validateFilters } from "../domain";
import type { UsageStore } from "../storage";

/** Result of parsing a `/api/usage` query string. */
export type UsageQueryParams =
  | { ok: true; filters: UsageFilters }
  | { ok: false; error: string };

/** Upper bound on values per dimension parameter (bounded response size). */
export const MAX_DIMENSION_VALUES = 200;

const DIGITS_ONLY = /^\d+$/;

const parseStringArray = (
  raw: string | null,
  name: string,
): { value?: string[]; error?: string } => {
  if (raw === null) return { value: [] };
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length > MAX_DIMENSION_VALUES) {
    return { error: `invalid query parameter "${name}": too many values (max ${MAX_DIMENSION_VALUES})` };
  }
  return { value: parts };
};

const parseNonNegativeInt = (
  raw: string | null,
  name: string,
): { value?: number; error?: string } => {
  if (raw === null) return {};
  if (!DIGITS_ONLY.test(raw)) {
    return { error: `invalid query parameter "${name}": expected a non-negative integer` };
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    return { error: `invalid query parameter "${name}": expected a non-negative integer` };
  }
  return { value };
};

const parseBoolean = (
  raw: string | null,
  name: string,
): { value?: boolean; error?: string } => {
  if (raw === null) return {};
  if (raw === "true") return { value: true };
  if (raw === "false") return { value: false };
  return { error: `invalid query parameter "${name}": expected "true" or "false"` };
};

/**
 * Parse and validate the query parameters of a `/api/usage` request. Absent
 * numeric parameters fall back to domain defaults (fromMs 0, toMs
 * MAX_SAFE_INTEGER, bucketMs DEFAULT_BUCKET_MS); absent booleans default to
 * false.
 *
 * The toMs default is MAX_SAFE_INTEGER rather than +Infinity (the domain's
 * literal default in `validateFilters`) because the echoed filters must
 * survive JSON serialization: `JSON.stringify` renders +Infinity as null,
 * which would violate the documented `UsageQueryResult.filters.toMs: number`
 * contract. Semantics are identical — the domain itself maps non-finite toMs
 * to MAX_SAFE_INTEGER for matching and bucketing — so the JSON-safe value is
 * chosen at this single decode boundary.
 */
export function parseUsageQuery(params: URLSearchParams): UsageQueryParams {
  const providers = parseStringArray(params.get("providers"), "providers");
  if (providers.error) return { ok: false, error: providers.error };
  const models = parseStringArray(params.get("models"), "models");
  if (models.error) return { ok: false, error: models.error };
  const projects = parseStringArray(params.get("projects"), "projects");
  if (projects.error) return { ok: false, error: projects.error };
  const sessions = parseStringArray(params.get("sessions"), "sessions");
  if (sessions.error) return { ok: false, error: sessions.error };

  const fromMs = parseNonNegativeInt(params.get("fromMs"), "fromMs");
  if (fromMs.error) return { ok: false, error: fromMs.error };
  const toMs = parseNonNegativeInt(params.get("toMs"), "toMs");
  if (toMs.error) return { ok: false, error: toMs.error };
  const bucketMs = parseNonNegativeInt(params.get("bucketMs"), "bucketMs");
  if (bucketMs.error) return { ok: false, error: bucketMs.error };

  const includeSummary = parseBoolean(params.get("includeSummary"), "includeSummary");
  if (includeSummary.error) return { ok: false, error: includeSummary.error };

  if (bucketMs.value !== undefined && bucketMs.value < 1) {
    return { ok: false, error: 'invalid query parameter "bucketMs": expected a positive integer' };
  }

  // Build the candidate once and let the domain validator be the single
  // structural gate. Absent fields stay undefined so `validateFilters`
  // applies its documented defaults.
  const candidate: Record<string, unknown> = {
    providers: providers.value ?? [],
    models: models.value ?? [],
    projects: projects.value ?? [],
    sessions: sessions.value ?? [],
    bucketMs: bucketMs.value ?? DEFAULT_BUCKET_MS,
    includeSummaryUsage: includeSummary.value ?? false,
  };
  if (fromMs.value !== undefined) candidate.fromMs = fromMs.value;
  candidate.toMs = toMs.value ?? Number.MAX_SAFE_INTEGER;

  const filters = validateFilters(candidate);
  if (filters === null) return { ok: false, error: "invalid query parameters" };
  return { ok: true, filters };
}

/**
 * Dimensions over ALL records regardless of the current filter selection,
 * used to populate the dashboard filter dropdowns (`/api/filters`). The query
 * is bounded to a single trend bucket so the call stays cheap even on large
 * histories.
 */
export function queryGlobalDimensions(store: UsageStore): UsageQueryResult["dimensions"] {
  const now = Date.now();
  const result = store.query(
    {
      providers: [],
      models: [],
      projects: [],
      sessions: [],
      fromMs: 0,
      toMs: now,
      bucketMs: Math.max(1, now),
      includeSummaryUsage: true,
    },
    now,
  );
  return result.dimensions;
}
