import type { APIRoute } from "astro";
import { getRuntime } from "../runtime.js";

export const prerender = false;

/** JSON response helper with a default 200 status. */
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * Normalizes a requested page path to the stored route convention
 * (`/team/overview` and `team/overview` both map to `/team/overview/`; an
 * empty value maps to `/`).
 *
 * @param value - Raw path from the query string.
 * @returns The normalized route.
 */
export function normalizePagePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "/";
  let path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (path.length > 1 && !path.endsWith("/")) path = `${path}/`;
  return path;
}

/**
 * The Weldall-SDK-authenticated full-page read endpoint.
 *
 * Verifies the request via `verifyNoThrow` (DPoP + access token) against the
 * required search scope, then returns the full body of the page identified by
 * the `path` query parameter. This backs the "read a full page" step of the
 * auto-discovered `search` skill: agents request pages by path instead of
 * fetching site HTML.
 *
 * @returns `{ path, title, description, content, subject }` on success, a
 *   404 when the path is unknown, otherwise a 400/401/403/500 JSON error.
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
  const rawPath = (url.searchParams.get("path") ?? "").trim();
  if (!rawPath) return json({ error: "missing_path" }, 400);

  const page = runtime.content(normalizePagePath(rawPath));
  if (!page) return json({ error: "not_found" }, 404);

  return json({ ...page, subject: result.auth.subject });
};
