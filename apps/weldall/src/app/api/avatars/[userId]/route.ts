import { fetchAvatarImage, loadAvatarUrl } from "@/server/avatars";
import { auth } from "@/server/auth/auth";
import { withRequestLogging } from "@/server/observability/http";

export const dynamic = "force-dynamic";

/**
 * Serves a user's group provider avatar from the Weldall origin, so the browser never talks to the
 * provider directly. Every signed-in user may read avatars; no additional scope is required.
 */
async function get(request: Request, context: { params: Promise<{ userId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return new Response(null, { status: 401, headers: { "cache-control": "no-store" } });
  }

  const { userId } = await context.params;
  const avatarUrl = await loadAvatarUrl(userId);
  if (!avatarUrl) return missingAvatar();

  const image = await fetchAvatarImage(avatarUrl);
  if (!image) return missingAvatar();

  return new Response(image.body, {
    headers: {
      "content-type": image.contentType,
      // Session-gated, so the browser may cache it but shared caches must not.
      "cache-control": "private, max-age=600, stale-while-revalidate=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

function missingAvatar(): Response {
  return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
}

export const GET = withRequestLogging("/api/avatars/[userId]", get, { successLevel: "debug" });
