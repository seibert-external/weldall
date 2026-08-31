import { WELDALL_ISSUER } from "../oauth/constants";

export function isTrustedBrowserRequest(request: Request): boolean {
  if (request.method === "GET") return true;

  const allowedOrigins = new Set([
    new URL(WELDALL_ISSUER).origin,
    ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:3000"]),
  ]);
  const origin = request.headers.get("origin");
  const contentType = request.headers.get("content-type") ?? "";
  const fetchSite = request.headers.get("sec-fetch-site");

  return Boolean(
    origin &&
    allowedOrigins.has(origin) &&
    request.headers.get("x-weldall-csrf") === "1" &&
    contentType.toLowerCase().startsWith("application/json") &&
    (!fetchSite || fetchSite === "same-origin"),
  );
}
