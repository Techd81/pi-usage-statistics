/**
 * Web-dashboard integration tests (WC1–WC6).
 *
 * Covers:
 * - loopback-only binding and URL reporting (WC1);
 * - free-port selection, configured-port honor, and port-in-use fallback;
 * - /api/health, /api/filters, /api/usage response shapes and filtering
 *   (WC2/WC4);
 * - invalid query parameters -> bounded 400 JSON (WC2);
 * - static whitelist serving + path-traversal rejection;
 * - graceful, idempotent shutdown (WC1);
 * - fixture-dataset smoke: the dashboard page and assets are served and the
 *   API reports the exact expected values (WC6 — HTTP-level alternative to a
 *   real browser when no browser automation is available).
 */
import { mkdtemp } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CostBreakdown, UsageRecord } from "../../domain";
import { DEFAULT_BUCKET_MS } from "../../domain";
import { UsageStore } from "../../storage";
import { makeRecord } from "../../storage/test/helpers";
import { createWebServer, hasWebServerFactory } from "../../runtime/web-server";
import { parseUsageQuery } from "../http-api";
import { createUsageDashboardServer } from "../server";

// Mock the Pi runtime module so store dirs are isolated and session scans are
// no-ops (same pattern as the runtime test suite).
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => process.env.PI_AGENT_DIR_TEST ?? "/tmp/pi-agent",
  SessionManager: {
    listAll: vi.fn(async () => []),
    open: vi.fn(() => ({ getEntries: () => [] })),
  },
}));

// --- Fixture data -----------------------------------------------------------

/** Epoch-aligned to the 30s bucket grid (T0 % 30000 === 0). */
const T0 = 1_700_000_010_000;

const RECORDED_COST: CostBreakdown = { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375, total: 0.02205 };
const ESTIMATED_COST: CostBreakdown = { input: 0.2, output: 0.25, cacheRead: 0.03, cacheWrite: 0.02, total: 0.5 };

const assistantAnthropic = (): UsageRecord =>
  makeRecord({
    sessionId: "s1",
    projectCwd: "/projects/p1",
    sourceEntryId: "entry-1",
    timestampMs: T0,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    costKind: "recorded",
    recordedCost: RECORDED_COST,
  });

const assistantOpenai = (): UsageRecord =>
  makeRecord({
    sessionId: "s2",
    projectCwd: "/projects/p2",
    sourceEntryId: "entry-2",
    timestampMs: T0 + 60_000,
    provider: "openai",
    model: "gpt-4o",
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: 50,
    cacheWriteTokens: 25,
    costKind: "estimated",
    estimatedCost: ESTIMATED_COST,
  });

const summaryRecord = (): UsageRecord =>
  makeRecord({
    sessionId: "s1",
    projectCwd: "/projects/p1",
    sourceEntryId: "summary:call-1",
    timestampMs: T0 + 30_000,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sourceKind: "summary",
  });

const FIXTURE = [assistantAnthropic(), assistantOpenai(), summaryRecord()];

// --- Harness ----------------------------------------------------------------

let storeDir: string;
let sessionDir: string;
const servers: ReturnType<typeof createUsageDashboardServer>[] = [];

beforeEach(async () => {
  process.env.PI_AGENT_DIR_TEST = await mkdtemp(join(tmpdir(), "pi-web-agent-"));
  storeDir = await mkdtemp(join(tmpdir(), "pi-web-store-"));
  sessionDir = await mkdtemp(join(tmpdir(), "pi-web-sessions-"));
  servers.length = 0;
});

afterEach(async () => {
  for (const server of servers) {
    try {
      await server.stop();
    } catch {
      // already stopped or failed to start
    }
  }
  delete process.env.PI_AGENT_DIR_TEST;
});

async function makeStore(records: UsageRecord[] = []): Promise<UsageStore> {
  const store = new UsageStore({ storeDir, sessionDir });
  await store.init();
  for (const record of records) store.upsertRecord(record);
  return store;
}

async function startServer(store: UsageStore, options: { port?: number } = {}): Promise<{ url: string; port: number }> {
  const server = createUsageDashboardServer(store, options);
  servers.push(server);
  const url = await server.start();
  return { url, port: Number(new URL(url).port) };
}

async function get(url: string): Promise<{ status: number; text: string; contentType: string | null; contentLength: string | null }> {
  const res = await fetch(url);
  return {
    status: res.status,
    text: await res.text(),
    contentType: res.headers.get("content-type"),
    contentLength: res.headers.get("content-length"),
  };
}

/** Raw-path GET that bypasses client-side URL normalization (traversal tests). */
function rawGet(port: number, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

// --- WC1: binding, port selection, lifecycle ---------------------------------

describe("server lifecycle", () => {
  it("WC1: binds to 127.0.0.1 only and reports the URL", async () => {
    const { url, port } = await startServer(await makeStore());
    expect(url).toBe(`http://127.0.0.1:${port}`);
    expect(port).toBeGreaterThan(0);
    const server = servers[0]!;
    expect(server.isRunning()).toBe(true);
    expect(server.getUrl()).toBe(url);
  });

  it("uses a free port by default and honors a configured free port", async () => {
    // Discover a free port with a throwaway server, then reuse it.
    const probe = createUsageDashboardServer(await makeStore());
    servers.push(probe);
    const probeUrl = await probe.start();
    const freePort = Number(new URL(probeUrl).port);
    await probe.stop();

    const { port } = await startServer(await makeStore(), { port: freePort });
    expect(port).toBe(freePort);
  });

  it("falls back to a free port when the configured port is taken", async () => {
    const first = createUsageDashboardServer(await makeStore());
    servers.push(first);
    const firstUrl = await first.start();
    const takenPort = Number(new URL(firstUrl).port);

    const second = createUsageDashboardServer(await makeStore(), { port: takenPort });
    servers.push(second);
    const secondUrl = await second.start();
    expect(Number(new URL(secondUrl).port)).not.toBe(takenPort);
    expect(secondUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("WC1: stop is graceful and idempotent; isRunning/getUrl clear", async () => {
    const store = await makeStore();
    const server = createUsageDashboardServer(store);
    servers.push(server);
    const url = await server.start();
    const port = Number(new URL(url).port);

    await expect(fetch(`${url}/api/health`)).resolves.toBeDefined();
    await server.stop();

    expect(server.isRunning()).toBe(false);
    expect(server.getUrl()).toBeUndefined();
    // The port is released: a new connection is refused.
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
    // Idempotent second stop.
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it("registers its factory so createWebServer() builds a working server", async () => {
    expect(hasWebServerFactory()).toBe(true);
    const handle = createWebServer({ port: 0 });
    expect(handle).not.toBeNull();
    const url = await handle!.start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await fetch(`${url}/api/health`);
    expect(health.status).toBe(200);
    await handle!.stop();
    expect(handle!.isRunning()).toBe(false);
  });
});

// --- WC2: API endpoints -------------------------------------------------------

describe("API endpoints", () => {
  it("WC2: /api/health returns a bounded ok payload", async () => {
    const { url } = await startServer(await makeStore(FIXTURE));
    const res = await get(`${url}/api/health`);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/json");
    const body = JSON.parse(res.text) as { status: string; refreshedAtMs: number };
    expect(body.status).toBe("ok");
    expect(typeof body.refreshedAtMs).toBe("number");
  });

  it("WC2: /api/filters returns the global dimension lists", async () => {
    const { url } = await startServer(await makeStore(FIXTURE));
    const res = await get(`${url}/api/filters`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as {
      providers: string[];
      models: string[];
      projects: string[];
      sessions: string[];
    };
    expect(body.providers).toEqual(["anthropic", "openai"]);
    expect(body.models).toEqual(["claude-sonnet-4-5", "gpt-4o"]);
    expect(body.projects).toEqual(["/projects/p1", "/projects/p2"]);
    expect(body.sessions).toEqual(["s1", "s2"]);
  });

  it("WC2: /api/usage echoes the documented UsageQueryResult shape", async () => {
    const { url } = await startServer(await makeStore(FIXTURE));
    const res = await get(
      `${url}/api/usage?fromMs=${T0 - 60_000}&toMs=${T0 + 120_000}&bucketMs=30000`,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as {
      filters: { fromMs: number; toMs: number; bucketMs: number; providers: string[] };
      totals: {
        totalTokens: number;
        requestCount: number;
        inputTokens: number;
        outputTokens: number;
        cacheWriteTokens: number;
        cacheReadTokens: number;
        cacheHitRate: number | null;
        cost: { amount: number | null; status: string; currency: string };
      };
      trend: { startMs: number; totalTokens: number }[];
      dimensions: { providers: string[]; models: string[] };
      refreshedAtMs: number;
    };

    // Filters echo.
    expect(body.filters.fromMs).toBe(T0 - 60_000);
    expect(body.filters.toMs).toBe(T0 + 120_000);
    expect(body.filters.bucketMs).toBe(30000);
    expect(body.filters.providers).toEqual([]);

    // Totals across both assistant records (summary excluded by default).
    expect(body.totals.inputTokens).toBe(300);
    expect(body.totals.outputTokens).toBe(150);
    expect(body.totals.cacheReadTokens).toBe(70);
    expect(body.totals.cacheWriteTokens).toBe(35);
    expect(body.totals.totalTokens).toBe(555);
    expect(body.totals.requestCount).toBe(2);
    expect(body.totals.cacheHitRate).toBeCloseTo((70 / 405) * 100, 5);
    expect(body.totals.cost.amount).toBeCloseTo(0.52205, 5);
    expect(body.totals.cost.status).toBe("mixed");
    expect(body.totals.cost.currency).toBe("USD");

    // Trend: epoch-aligned 30s buckets over the 3-minute window (7 buckets).
    expect(body.trend.length).toBe(7);
    expect(body.trend[0]!.startMs).toBe(T0 - 60_000);
    for (const point of body.trend) {
      expect(point.startMs % 30000).toBe(0);
    }
    expect(body.trend[2]!.totalTokens).toBe(180);
    expect(body.trend[3]!.totalTokens).toBe(0); // summary excluded from this bucket
    expect(body.trend[4]!.totalTokens).toBe(375);

    // Dimensions derive from the filtered set.
    expect(body.dimensions.providers).toEqual(["anthropic", "openai"]);
    expect(body.dimensions.models).toEqual(["claude-sonnet-4-5", "gpt-4o"]);
    expect(typeof body.refreshedAtMs).toBe("number");
  });

  it("WC4: provider/model filters recompute totals from the same records", async () => {
    const { url } = await startServer(await makeStore(FIXTURE));

    const anthropic = (await get(`${url}/api/usage?providers=anthropic&fromMs=0&toMs=${T0 + 120_000}`)).text;
    const anthropicBody = JSON.parse(anthropic) as { totals: { inputTokens: number; requestCount: number } };
    expect(anthropicBody.totals.inputTokens).toBe(100);
    expect(anthropicBody.totals.requestCount).toBe(1);

    const both = (await get(`${url}/api/usage?providers=anthropic,openai&fromMs=0&toMs=${T0 + 120_000}`)).text;
    const bothBody = JSON.parse(both) as { totals: { inputTokens: number } };
    expect(bothBody.totals.inputTokens).toBe(300);

    const gpt = (await get(`${url}/api/usage?models=gpt-4o&fromMs=0&toMs=${T0 + 120_000}`)).text;
    const gptBody = JSON.parse(gpt) as { totals: { inputTokens: number; cost: { amount: number | null; status: string } } };
    expect(gptBody.totals.inputTokens).toBe(200);
    expect(gptBody.totals.cost.status).toBe("estimated");
  });

  it("includeSummary=true includes summary usage without adding requests", async () => {
    const { url } = await startServer(await makeStore(FIXTURE));
    const res = await get(`${url}/api/usage?fromMs=0&toMs=${T0 + 120_000}&includeSummary=true`);
    const body = JSON.parse(res.text) as { totals: { inputTokens: number; requestCount: number; totalTokens: number } };
    expect(body.totals.inputTokens).toBe(310);
    expect(body.totals.totalTokens).toBe(570);
    expect(body.totals.requestCount).toBe(2);
  });

  it("WC2: invalid query parameters return bounded 400 JSON", async () => {
    const { url } = await startServer(await makeStore(FIXTURE));
    const cases = [
      "bucketMs=abc",
      "bucketMs=0",
      "bucketMs=-5",
      "bucketMs=1.5",
      "bucketMs=1e3",
      "fromMs=-1",
      "fromMs=1.5",
      "toMs=x",
      "includeSummary=yes",
      "includeSummary=1",
    ];
    for (const query of cases) {
      const res = await get(`${url}/api/usage?${query}`);
      expect(res.status).toBe(400);
      const body = JSON.parse(res.text) as { error: string };
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
      // Bounded payload: exactly one field.
      expect(Object.keys(body)).toEqual(["error"]);
      expect(res.text.length).toBeLessThan(300);
    }
  });

  it("WC2: /api/usage without toMs echoes a JSON-safe finite toMs", async () => {
    const { url } = await startServer(await makeStore(FIXTURE));
    const res = await get(`${url}/api/usage?fromMs=0`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as { filters: { toMs: unknown } };
    // Regression: JSON.stringify(+Infinity) is null, which would violate the
    // documented `filters.toMs: number` shape. The boundary decoder must
    // substitute the domain's effective finite upper bound.
    expect(typeof body.filters.toMs).toBe("number");
    expect(Number.isFinite(body.filters.toMs as number)).toBe(true);
  });

  it("rejects oversized dimension lists and unknown API paths", async () => {
    const { url } = await startServer(await makeStore(FIXTURE));
    const many = Array.from({ length: 201 }, (_, i) => `p${i}`).join(",");
    const res = await get(`${url}/api/usage?providers=${many}`);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text) as { error: string }).toEqual({ error: expect.stringContaining("too many values") });

    const missing = await get(`${url}/api/nope`);
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.text) as { error: string }).toEqual({ error: "not found" });
  });

  it("rejects non-GET methods on API and static routes", async () => {
    const { url } = await startServer(await makeStore(FIXTURE));
    const post = await fetch(`${url}/api/usage`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(JSON.parse(await post.text()) as { error: string }).toEqual({ error: "method not allowed" });

    const put = await fetch(`${url}/app.js`, { method: "PUT" });
    expect(put.status).toBe(405);
  });

  it("parseUsageQuery unit: defaults, lists, and boolean mapping", () => {
    const defaults = parseUsageQuery(new URLSearchParams());
    expect(defaults.ok).toBe(true);
    if (defaults.ok) {
      expect(defaults.filters.fromMs).toBe(0);
      // JSON-safe default: MAX_SAFE_INTEGER, not +Infinity (stringify would
      // turn +Infinity into null and break the echoed filters.toMs: number).
      expect(defaults.filters.toMs).toBe(Number.MAX_SAFE_INTEGER);
      expect(defaults.filters.bucketMs).toBe(DEFAULT_BUCKET_MS);
      expect(defaults.filters.includeSummaryUsage).toBe(false);
      expect(defaults.filters.providers).toEqual([]);
    }

    const explicit = parseUsageQuery(
      new URLSearchParams("providers= a ,b &models=x&fromMs=10&toMs=20&bucketMs=30000&includeSummary=true"),
    );
    expect(explicit.ok).toBe(true);
    if (explicit.ok) {
      expect(explicit.filters.providers).toEqual(["a", "b"]);
      expect(explicit.filters.models).toEqual(["x"]);
      expect(explicit.filters.fromMs).toBe(10);
      expect(explicit.filters.toMs).toBe(20);
      expect(explicit.filters.includeSummaryUsage).toBe(true);
    }

    const bad = parseUsageQuery(new URLSearchParams("bucketMs=1.5"));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("bucketMs");
  });
});

// --- WC3/WC5: static dashboard + states --------------------------------------

describe("static dashboard", () => {
  it("WC3: serves index.html with the reference hierarchy", async () => {
    const { url } = await startServer(await makeStore(FIXTURE));
    const res = await get(`${url}/`);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    for (const needle of [
      "使用统计",
      "实际消耗 Token",
      "请求数",
      "总成本",
      "输入",
      "输出",
      "Cache 创建",
      "Cache 命中",
      "缓存命中率",
      "今天",
      "30s",
      "app.js",
      "styles.css",
    ]) {
      expect(res.text).toContain(needle);
    }
  });

  it("serves app.js and styles.css with correct content types; HEAD has no body", async () => {
    const { url } = await startServer(await makeStore(FIXTURE));
    const js = await get(`${url}/app.js`);
    expect(js.status).toBe(200);
    expect(js.contentType).toContain("text/javascript");
    expect(js.text).toContain("/api/usage");
    expect(js.text).toContain("setInterval");

    const css = await get(`${url}/styles.css`);
    expect(css.status).toBe(200);
    expect(css.contentType).toContain("text/css");

    const head = await fetch(`${url}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
  });

  it("WC3: never serves files outside the public whitelist (traversal)", async () => {
    const { url, port } = await startServer(await makeStore(FIXTURE));
    const packageJson = await (await fetch(`${url}/app.js`)).text(); // control works
    expect(packageJson).toContain("loadData");

    const attempts = [
      "/../package.json",
      "/%2e%2e/package.json",
      "/app.js/../styles.css",
      "/%2e%2e/%2e%2e/package.json",
      "/app.js\\..\\package.json",
      "/..%2f..%2fpackage.json",
      "/%5c..%5cpackage.json",
      "/sub/app.js",
      "/favicon.ico",
    ];
    for (const attempt of attempts) {
      const res = await rawGet(port, attempt);
      expect(res.status).toBe(404);
      expect(res.body).not.toContain('"name": "pi-token-usage-statistics"');
      expect(res.body.length).toBeLessThan(300);
    }
  });

  it("WC5: empty dataset serves the dashboard without errors", async () => {
    const { url } = await startServer(await makeStore([]));
    const res = await get(`${url}/api/usage?fromMs=0&toMs=${Date.now()}&bucketMs=30000`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as { totals: { totalTokens: number; requestCount: number; cost: { amount: number | null; status: string } } };
    expect(body.totals.totalTokens).toBe(0);
    expect(body.totals.requestCount).toBe(0);
    expect(body.totals.cost.amount).toBe(0);
    expect(body.totals.cost.status).toBe("recorded");

    const html = await get(`${url}/`);
    expect(html.status).toBe(200);
  });
});

// --- WC6: fixture-dataset browser smoke (HTTP level) -------------------------

describe("fixture smoke", () => {
  it("WC6: a fixture dataset serves the dashboard and exact expected values", async () => {
    const { url } = await startServer(await makeStore(FIXTURE));
    try {
      // The values the dashboard renders from this fixture.
      const usageRes = await fetch(`${url}/api/usage?fromMs=${T0 - 60_000}&toMs=${T0 + 120_000}&bucketMs=30000`);
      expect(usageRes.status).toBe(200);
      const usage = (await usageRes.json()) as {
        totals: {
          totalTokens: number;
          requestCount: number;
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
          cacheHitRate: number | null;
          cost: { amount: number | null; status: string };
        };
      };
      expect(usage.totals.totalTokens).toBe(555);
      expect(usage.totals.requestCount).toBe(2);
      expect(usage.totals.inputTokens).toBe(300);
      expect(usage.totals.outputTokens).toBe(150);
      expect(usage.totals.cacheReadTokens).toBe(70);
      expect(usage.totals.cacheWriteTokens).toBe(35);
      expect(usage.totals.cacheHitRate).toBeCloseTo(17.28395, 3);
      expect(usage.totals.cost.amount).toBeCloseTo(0.52205, 4);
      expect(usage.totals.cost.status).toBe("mixed");

      // The page references every element the smoke check cares about.
      const html = await (await fetch(`${url}/`)).text();
      for (const needle of ["使用统计", "实际消耗 Token", "请求数", "总成本", "输入", "输出", "Cache 创建", "Cache 命中", "缓存命中率"]) {
        expect(html).toContain(needle);
      }
      // The client renders the exact values (stringly asserted against the
      // formatting rules shared with the TUI surface).
      const js = await (await fetch(`${url}/app.js`)).text();
      expect(js).toContain("toFixed(4)");
      expect(js).toContain("--");
    } finally {
      await servers[0]!.stop();
    }
  });
});
