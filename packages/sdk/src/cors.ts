import type { BrowserCorsMethod } from "./types.js";

const REQUEST_HEADERS = [
  "Authorization",
  "DPoP",
  "Content-Type",
  "X-Request-Id",
  "X-Correlation-Id",
] as const;
const REQUEST_HEADER_SET = new Set(REQUEST_HEADERS.map((value) => value.toLowerCase()));
const EXPOSE_HEADERS = "WWW-Authenticate, DPoP-Nonce";
const VARY = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";

export type BrowserCors = {
  allowedOrigins: readonly string[];
  allowedMethods: readonly BrowserCorsMethod[];
  preflight(request: Request, methods?: readonly BrowserCorsMethod[]): Response | null;
  rejectActual(request: Request, methods?: readonly BrowserCorsMethod[]): Response | null;
  decorate(request: Request, response: Response, methods?: readonly BrowserCorsMethod[]): Response;
  handle(
    request: Request,
    methods: readonly BrowserCorsMethod[],
    operation: () => Response | Promise<Response>,
  ): Promise<Response>;
};

const vary = (headers: Headers) => {
  const values = new Set(
    `${headers.get("vary") ?? ""},${VARY}`
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  headers.set("vary", [...values].join(", "));
};

const exactOrigin = (value: string | null): string | null => {
  if (!value || value === "null") return null;
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password ? value : null;
  } catch {
    return null;
  }
};

export function createBrowserCors(input: {
  allowedOrigins: readonly string[];
  allowedMethods: readonly BrowserCorsMethod[];
}): BrowserCors {
  const origins = new Set(input.allowedOrigins);
  const allowedMethods = [...input.allowedMethods];
  const isAllowed = (request: Request) => {
    const origin = exactOrigin(request.headers.get("origin"));
    return origin && origins.has(origin) ? origin : null;
  };
  const rejection = () => {
    const headers = new Headers({ "cache-control": "no-store" });
    vary(headers);
    return Response.json(
      { error: "invalid_request", error_description: "browser origin is not allowed" },
      { status: 403, headers },
    );
  };
  const headersFor = (origin: string, methods: readonly BrowserCorsMethod[]) => {
    const headers = new Headers({
      "access-control-allow-origin": origin,
      "access-control-allow-methods": methods.join(", "),
      "access-control-allow-headers": REQUEST_HEADERS.join(", "),
      "access-control-expose-headers": EXPOSE_HEADERS,
      "cache-control": "no-store",
    });
    vary(headers);
    return headers;
  };
  const preflight: BrowserCors["preflight"] = (request, methods = allowedMethods) => {
    if (request.method !== "OPTIONS") return null;
    const hasCorsMetadata =
      request.headers.has("origin") || request.headers.has("access-control-request-method");
    if (!hasCorsMetadata) return null;
    const origin = isAllowed(request);
    if (!origin) return rejection();
    const requestedMethod = request.headers
      .get("access-control-request-method")
      ?.trim()
      .toUpperCase() as BrowserCorsMethod | undefined;
    if (!requestedMethod || !methods.includes(requestedMethod)) return rejection();
    const requestedHeaders =
      request.headers
        .get("access-control-request-headers")
        ?.split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean) ?? [];
    if (requestedHeaders.some((value) => !REQUEST_HEADER_SET.has(value))) return rejection();
    return new Response(null, { status: 204, headers: headersFor(origin, methods) });
  };
  const rejectActual: BrowserCors["rejectActual"] = (request, methods = allowedMethods) => {
    if (!request.headers.has("origin")) return null;
    return isAllowed(request) && methods.includes(request.method as BrowserCorsMethod)
      ? null
      : rejection();
  };
  const decorate: BrowserCors["decorate"] = (request, response, methods = allowedMethods) => {
    const origin = isAllowed(request);
    if (!origin) return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of headersFor(origin, methods)) headers.set(name, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  const handle: BrowserCors["handle"] = async (request, methods, operation) => {
    const preflightResponse = preflight(request, methods);
    if (preflightResponse) return preflightResponse;
    const rejected = rejectActual(request, methods);
    if (rejected) return rejected;
    return decorate(request, await operation(), methods);
  };
  return {
    allowedOrigins: [...origins],
    allowedMethods,
    preflight,
    rejectActual,
    decorate,
    handle,
  };
}
