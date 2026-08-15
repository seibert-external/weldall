import { CliError } from "./errors.js";

export const TEST_HTTP_BRIDGE_ENV = "WELDALL_E2E_HTTP_BRIDGE";
export const TEST_ORIGINAL_ORIGIN_HEADER = "x-weldall-test-original-origin";

export type TestHttpBridge = ReadonlyMap<string, string>;

const canonicalOrigin = (value: unknown, protocol: "https:" | "http:", label: string) => {
  if (typeof value !== "string") throw new CliError(`${label} must be a string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new CliError(`${label} must be an absolute URL`, { cause: error });
  }
  if (
    url.protocol !== protocol ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== value
  )
    throw new CliError(
      `${label} must be a canonical ${protocol === "https:" ? "HTTPS" : "HTTP"} origin`,
    );
  return url;
};

export function parseTestHttpBridge(
  raw: string | undefined,
  nodeEnv = process.env["NODE_ENV"],
): TestHttpBridge | null {
  if (raw === undefined) return null;
  if (nodeEnv !== "test")
    throw new CliError(`${TEST_HTTP_BRIDGE_ENV} is only allowed when NODE_ENV=test`);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CliError(`${TEST_HTTP_BRIDGE_ENV} must be valid JSON`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CliError(
      `${TEST_HTTP_BRIDGE_ENV} must be an object of source and destination origins`,
    );
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 10)
    throw new CliError(`${TEST_HTTP_BRIDGE_ENV} must contain between 1 and 10 origins`);
  const bridge = new Map<string, string>();
  for (const [sourceValue, destinationValue] of entries) {
    const source = canonicalOrigin(sourceValue, "https:", "Test bridge source");
    const destination = canonicalOrigin(destinationValue, "http:", "Test bridge destination");
    if (destination.hostname !== "127.0.0.1" || !destination.port || Number(destination.port) < 1)
      throw new CliError("Test bridge destinations must use an explicit port on 127.0.0.1");
    bridge.set(source.origin, destination.origin);
  }
  return bridge;
}

export function createTestHttpBridgeFetch(
  bridge: TestHttpBridge,
  nativeFetch: typeof fetch,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const sourceRequest = input instanceof Request ? input : undefined;
    const originalUrl = new URL(sourceRequest?.url ?? String(input));
    const destination = bridge.get(originalUrl.origin);
    if (!destination) return nativeFetch(input, init);

    const headers = new Headers(sourceRequest?.headers);
    new Headers(init?.headers).forEach((headerValue, name) => headers.set(name, headerValue));
    if (headers.has(TEST_ORIGINAL_ORIGIN_HEADER))
      throw new CliError(
        `${TEST_ORIGINAL_ORIGIN_HEADER} is reserved for the test transport bridge`,
      );
    headers.set(TEST_ORIGINAL_ORIGIN_HEADER, originalUrl.origin);
    const rewritten = new URL(`${originalUrl.pathname}${originalUrl.search}`, `${destination}/`);
    if (sourceRequest) {
      const request = new Request(rewritten, sourceRequest);
      return nativeFetch(request, { ...init, headers });
    }
    return nativeFetch(rewritten, { ...init, headers });
  }) as typeof fetch;
}

export function installTestHttpBridge(environment: NodeJS.ProcessEnv = process.env) {
  const bridge = parseTestHttpBridge(environment[TEST_HTTP_BRIDGE_ENV], environment["NODE_ENV"]);
  if (!bridge) return false;
  globalThis.fetch = createTestHttpBridgeFetch(bridge, globalThis.fetch);
  return true;
}
