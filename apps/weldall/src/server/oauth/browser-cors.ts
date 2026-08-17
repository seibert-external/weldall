import { isCurrentEnabledBrowserOrigin } from "./browser-resources";

const ALLOWED_REQUEST_HEADERS = new Set([
  "authorization",
  "content-type",
  "dpop",
  "x-correlation-id",
  "x-request-id",
]);
const VARY = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";

function parseExactOrigin(value: string | null): string | null {
  if (!value || value === "null") return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== value ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

function appendVary(headers: Headers): void {
  const current = headers.get("vary");
  const values = new Set(
    `${current ?? ""},${VARY}`
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  headers.set("vary", [...values].join(", "));
}

function corsHeaders(origin: string, methods: readonly string[]): Headers {
  const headers = new Headers({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": methods.join(", "),
    "access-control-allow-headers": [...ALLOWED_REQUEST_HEADERS]
      .map((header) =>
        header === "dpop"
          ? "DPoP"
          : header
              .split("-")
              .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
              .join("-"),
      )
      .join(", "),
    "access-control-expose-headers": "WWW-Authenticate, DPoP-Nonce, X-Request-Id",
    "cache-control": "no-store",
  });
  appendVary(headers);
  return headers;
}

function rejectedOrigin(): Response {
  // Permit only an opaque no-cors reachability signal. The response body stays
  // unreadable and Access-Control-Allow-Origin remains absent.
  const headers = new Headers({
    "cache-control": "no-store",
    "cross-origin-resource-policy": "cross-origin",
  });
  appendVary(headers);
  return Response.json(
    { error: "invalid_request", error_description: "browser origin is not allowed" },
    { status: 403, headers },
  );
}

export type BrowserCorsHandler<Args extends unknown[]> = (
  request: Request,
  ...args: Args
) => Response | Promise<Response>;

/**
 * Exact dynamic CORS for resource SPAs. OPTIONS is fully resolved before the
 * wrapped auth/DPoP/replay/quota handler is invoked. Requests without Origin
 * remain untouched for CLI, machine and server callers.
 */
export function withBrowserCors<Args extends unknown[]>(
  methods: readonly string[],
  handler: BrowserCorsHandler<Args>,
  options: {
    beforeActual?: (request: Request) => void | Response | Promise<void | Response>;
    onRejectedActualOrigin?: (request: Request) => void | Promise<void>;
  } = {},
): BrowserCorsHandler<Args> {
  const normalizedMethods = methods.map((method) => method.toUpperCase());
  return async (request, ...args) => {
    if (request.method === "OPTIONS") {
      const suppliedOrigin = request.headers.get("origin");
      const origin = parseExactOrigin(suppliedOrigin);
      if (!origin || !(await isCurrentEnabledBrowserOrigin(origin))) return rejectedOrigin();
      const requestedMethod = request.headers.get("access-control-request-method")?.toUpperCase();
      if (!requestedMethod || !normalizedMethods.includes(requestedMethod)) return rejectedOrigin();
      const requestedHeaders =
        request.headers
          .get("access-control-request-headers")
          ?.split(",")
          .map((header) => header.trim().toLowerCase())
          .filter(Boolean) ?? [];
      if (requestedHeaders.some((header) => !ALLOWED_REQUEST_HEADERS.has(header)))
        return rejectedOrigin();
      return new Response(null, { status: 204, headers: corsHeaders(origin, normalizedMethods) });
    }

    const earlyResponse = await options.beforeActual?.(request);
    const suppliedOrigin = request.headers.get("origin");
    const origin = parseExactOrigin(suppliedOrigin);
    if (earlyResponse) {
      if (!origin || !(await isCurrentEnabledBrowserOrigin(origin))) {
        await options.onRejectedActualOrigin?.(request);
        return rejectedOrigin();
      }
      const headers = new Headers(earlyResponse.headers);
      for (const [name, value] of corsHeaders(origin, normalizedMethods)) headers.set(name, value);
      return new Response(earlyResponse.body, {
        status: earlyResponse.status,
        statusText: earlyResponse.statusText,
        headers,
      });
    }

    if (suppliedOrigin !== null) {
      if (!origin || !(await isCurrentEnabledBrowserOrigin(origin))) {
        await options.onRejectedActualOrigin?.(request);
        return rejectedOrigin();
      }
      const response = await handler(request, ...args);
      const headers = new Headers(response.headers);
      for (const [name, value] of corsHeaders(origin, normalizedMethods)) headers.set(name, value);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    return handler(request, ...args);
  };
}

export function browserPreflight(methods: readonly string[]) {
  return withBrowserCors(methods, () => new Response(null, { status: 204 }));
}
