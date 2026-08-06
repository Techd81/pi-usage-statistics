/**
 * Loopback-only dashboard server (design §5.1).
 *
 * Responsibilities:
 * - bind to 127.0.0.1 only, never to all interfaces;
 * - free-port selection via `listen(0)` with an optional configured port and
 *   a safe fallback to a free port when the preferred one is taken;
 * - three bounded JSON endpoints (`/api/health`, `/api/filters`,
 *   `/api/usage`) plus a hardcoded static-asset whitelist from
 *   `src/web/public` — no arbitrary path serving, no proxying;
 * - graceful stop: closes all connections and releases the port; stop is
 *   idempotent and safe to call while a start is still in flight;
 * - server failures never propagate fatally: listen errors on the preferred
 *   port fall back, and request errors are answered with bounded 400/404
 *   JSON instead of crashing the process.
 *
 * The module registers its factory through `registerWebServerFactory` at load
 * time (idempotent). The package manifest additionally lists
 * `src/web/register.ts` so Pi loads this module alongside the extension and
 * the `/usage-stats web` command can construct the server.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { UsageStore } from "../storage";
import { registerWebServerFactory, type WebServerHandle, type WebServerOptions } from "../runtime/web-server";
import { parseUsageQuery, queryGlobalDimensions } from "./http-api";

/** Absolute path of the bundled static assets directory. */
const PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));

/** Hardcoded static-asset whitelist: the only paths served from disk. */
const STATIC_FILES = new Map<string, { file: string; type: string }>([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

/** Dashboard server options: runtime port options plus an optional setup hook. */
export type DashboardServerOptions = WebServerOptions & {
  /**
   * Async setup run once before the server binds (e.g. store init + scan for
   * factory-created stores). Failures abort the start non-fatally.
   */
  onStart?: () => Promise<void>;
};

const sendBytes = (
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  method: string,
): void => {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(method === "HEAD" ? undefined : body);
};

const sendJson = (res: ServerResponse, status: number, body: unknown, method = "GET"): void => {
  sendBytes(res, status, Buffer.from(JSON.stringify(body), "utf8"), "application/json; charset=utf-8", method);
};

const sendJsonError = (res: ServerResponse, status: number, message: string, method = "GET"): void => {
  sendJson(res, status, { error: message }, method);
};

/**
 * Create a dashboard server over a shared UsageStore. The store is queried
 * synchronously per request (same query path as the TUI), so web and TUI
 * metrics can never diverge (spec web-and-tui.md).
 */
export function createUsageDashboardServer(store: UsageStore, options: DashboardServerOptions = {}): WebServerHandle {
  let httpServer: Server | null = null;
  let url: string | undefined;
  let starting: Promise<string> | null = null;

  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    try {
      const method = req.method ?? "GET";
      const rawUrl = req.url ?? "/";
      const rawPath = rawUrl.split("?")[0] ?? "/";
      // Reject traversal before any URL normalization: literal dot segments,
      // backslashes, NUL bytes, and percent-encoded dots/separators never
      // reach the route table (no arbitrary path serving, design §5.1).
      if (
        rawPath.includes("..") ||
        rawPath.includes("\\") ||
        rawPath.includes("\0") ||
        /%2e|%2E|%5c|%5C/.test(rawPath)
      ) {
        sendJsonError(res, 404, "not found", method);
        return;
      }
      const target = new URL(rawUrl, "http://127.0.0.1");
      const path = target.pathname;

      if (path.startsWith("/api/")) {
        if (method !== "GET" && method !== "HEAD") {
          sendJsonError(res, 405, "method not allowed", method);
          return;
        }
        if (path === "/api/health") {
          sendJson(res, 200, { status: "ok", refreshedAtMs: Date.now() }, method);
          return;
        }
        if (path === "/api/filters") {
          sendJson(res, 200, queryGlobalDimensions(store), method);
          return;
        }
        if (path === "/api/usage") {
          const parsed = parseUsageQuery(target.searchParams);
          if (!parsed.ok) {
            sendJsonError(res, 400, parsed.error, method);
            return;
          }
          sendJson(res, 200, store.query(parsed.filters, Date.now()), method);
          return;
        }
        sendJsonError(res, 404, "not found", method);
        return;
      }

      void serveStatic(path, method, res).catch(() => {
        // The response is either already answered or the connection closed;
        // never let an async static-serve failure escape into an unhandled
        // rejection (server failures are non-fatal by contract).
      });
    } catch {
      sendJsonError(res, 400, "bad request");
    }
  };

  const serveStatic = async (path: string, method: string, res: ServerResponse): Promise<void> => {
    if (method !== "GET" && method !== "HEAD") {
      sendJsonError(res, 405, "method not allowed", method);
      return;
    }
    if (path.includes("..") || path.includes("\\") || path.includes("\0")) {
      sendJsonError(res, 404, "not found", method);
      return;
    }
    const entry = STATIC_FILES.get(path);
    if (!entry) {
      sendJsonError(res, 404, "not found", method);
      return;
    }
    // Defense in depth: the whitelist is fixed, but still verify the resolved
    // file stays inside the public directory.
    const fullPath = resolve(PUBLIC_DIR, entry.file);
    if (!fullPath.startsWith(PUBLIC_DIR + sep)) {
      sendJsonError(res, 404, "not found", method);
      return;
    }
    try {
      const body = await readFile(fullPath);
      sendBytes(res, 200, body, entry.type, method);
    } catch {
      sendJsonError(res, 404, "not found", method);
    }
  };

  const doStart = async (): Promise<string> => {
    if (httpServer !== null && httpServer.listening) return url!;
    if (options.onStart) await options.onStart();

    const server = createHttpServer(handleRequest);
    // Server-level errors are non-fatal by contract (design §5.1): a broken
    // request or client abort must never take Pi down.
    server.on("error", () => {});
    httpServer = server;

    const listen = (port: number): Promise<void> =>
      new Promise((resolveListen, rejectListen) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          rejectListen(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolveListen();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });

    const preferred = options.port;
    try {
      if (preferred !== undefined) {
        try {
          await listen(preferred);
        } catch {
          // Safe fallback: preferred port is taken (or unusable) -> free port.
          await listen(0);
        }
      } else {
        await listen(0);
      }
    } catch (error) {
      httpServer = null;
      throw error;
    }

    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    url = base;
    return base;
  };

  return {
    async start(): Promise<string> {
      if (url !== undefined) return url;
      if (starting !== null) return starting;
      starting = doStart().finally(() => {
        starting = null;
      });
      return starting;
    },

    async stop(): Promise<void> {
      if (starting !== null) {
        try {
          await starting;
        } catch {
          // The start failed; there is nothing to close.
        }
      }
      const server = httpServer;
      httpServer = null;
      url = undefined;
      if (server === null) return;
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },

    isRunning(): boolean {
      return httpServer !== null && httpServer.listening;
    },

    getUrl(): string | undefined {
      return url;
    },
  };
}

// --- Factory registration ----------------------------------------------------

let factoryRegistered = false;
let defaultStore: UsageStore | undefined;

/**
 * Lazily created store for factory-constructed servers. Uses the default
 * store directory (the same one the extension's primary store uses), so the
 * dashboard serves the persisted history. `start()` initializes it and runs
 * one session scan so history is populated even on a fresh process.
 */
const getDefaultStore = (): UsageStore => {
  defaultStore ??= new UsageStore();
  return defaultStore;
};

/** Register the dashboard factory once; safe to call repeatedly. */
export function registerDashboardFactory(): void {
  if (factoryRegistered) return;
  registerWebServerFactory((options) =>
    createUsageDashboardServer(getDefaultStore(), {
      ...options,
      onStart: async () => {
        const store = getDefaultStore();
        await store.init();
        try {
          await store.refresh();
        } catch {
          // A scan failure must not prevent the dashboard from starting; the
          // durable index may already hold history (design §5.1 non-fatal).
        }
      },
    }),
  );
  factoryRegistered = true;
}

registerDashboardFactory();
