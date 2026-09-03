import type { APIRoute } from "astro";
import { getRuntime } from "../runtime.js";

export const prerender = false;

/** JSON response helper with a default 200 status. */
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * The Weldall-SDK-authenticated full-text search endpoint.
 *
 * Verifies the request via `verifyNoThrow` (DPoP + access token) against the
 * required search scope, then runs the query over the build-time Orama index.
 * Unauthenticated requests get the SDK's standard OAuth error response.
 *
 * @returns `{ query, results, subject }` on success, otherwise a 400/401/403/500
 *   JSON error.
 */
export const GET: APIRoute = async (context) => {
  let runtime;
  try {
    runtime = await getRuntime();
  } catch (error) {
    return json({ error: "service_unconfigured", detail: String(error) }, 500);
  }

  const result = await runtime.weldall.verifyNoThrow(context.request, {
    scopes: runtime.config.requiredScopes,
  });
  if (!result.ok) return result.response;

  const url = new URL(context.request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return json({ error: "missing_query" }, 400);

  const requested = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(requested) && requested >= 1 && requested <= 50
      ? Math.floor(requested)
      : runtime.config.defaultLimit;

  const results = await runtime.search(q, limit);
  return json({ query: q, results, subject: result.auth.subject });
};
