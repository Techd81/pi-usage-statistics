/**
 * Web-server ownership glue (child web-dashboard task fills in the HTTP
 * server). The extension runtime only owns lifecycle: create, start once on
 * explicit invocation, stop on shutdown (design §5.1, §7).
 *
 * The concrete server registers itself through `registerWebServerFactory`;
 * until then `createWebServer` returns null and the `web` command degrades to
 * a non-fatal notice. A failed/broken server never terminates Pi.
 */

export type WebServerOptions = {
  /** Preferred loopback port; implementations may fall back to a free port. */
  port?: number;
};

/** Lifecycle contract every dashboard server must satisfy. */
export interface WebServerHandle {
  /** Start the loopback server; resolves to the base URL (http://127.0.0.1:PORT). */
  start(): Promise<string>;
  /** Stop the server and release its resources. Idempotent. */
  stop(): Promise<void>;
  isRunning(): boolean;
  /** The base URL once started; undefined before start. */
  getUrl(): string | undefined;
}

export type WebServerFactory = (options?: WebServerOptions) => WebServerHandle;

let registeredFactory: WebServerFactory | undefined;

/** Called once by the web-dashboard module to make its server constructible. */
export function registerWebServerFactory(factory: WebServerFactory): void {
  registeredFactory = factory;
}

export function hasWebServerFactory(): boolean {
  return registeredFactory !== undefined;
}

/**
 * Create a server handle through the registered factory. Returns null when no
 * factory is registered or the factory itself throws — callers must degrade
 * non-fatally (design §5.1).
 */
export function createWebServer(options?: WebServerOptions): WebServerHandle | null {
  if (!registeredFactory) return null;
  try {
    return registeredFactory(options);
  } catch (error) {
    console.error(`[usage-stats] web server factory failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
