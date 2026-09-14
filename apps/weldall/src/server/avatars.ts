import { db } from "@weldall/db";
import { parseAvatarUrl } from "./group-providers/avatar-url";
import { errorForLog, logger } from "./observability/logger";

/**
 * Same-origin prefix the browser uses for avatars. The provider URL itself never reaches the
 * client: it is fetched server-side, so a provider origin does not need CORS or a public host.
 */
const AVATAR_ROUTE_PREFIX = "/api/avatars";

const MAX_AVATAR_BYTES = 512 * 1_024;
const AVATAR_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Raster formats only. Avatars are served from the Weldall origin, where an SVG could execute
 * script in the session of every viewer; the group provider contract does not need vector images.
 */
const ALLOWED_AVATAR_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

/** The browser-facing path for a user's avatar. */
export function avatarRoutePath(userId: string): string {
  return `${AVATAR_ROUTE_PREFIX}/${encodeURIComponent(userId)}`;
}

/**
 * Caches the avatar a group provider reported for a user. Membership resolution is the only place
 * that sees the provider's user record, so it hands the URL over here. This is a best-effort cache
 * write: it never throws, because a failed avatar must not fail an authorization decision.
 */
export async function cacheProviderAvatar(email: string, avatarUrl: unknown): Promise<void> {
  const url = parseAvatarUrl(avatarUrl);
  if (!url) {
    logger.debug(
      { event: "user_avatar.cache.skipped", reason: "invalid_url" },
      "Skipped group provider avatar cache",
    );
    return;
  }
  try {
    // Guarded so an unchanged avatar costs a statement but no write. `image` is nullable, so an
    // absent avatar needs its own branch: SQL `<>` never matches NULL.
    const result = await db.user.updateMany({
      where: {
        email: email.trim().toLowerCase(),
        OR: [{ image: null }, { image: { not: url } }],
      },
      data: { image: url },
    });
    logger.debug(
      {
        event: result.count ? "user_avatar.cache.updated" : "user_avatar.cache.skipped",
        ...(result.count ? {} : { reason: "unchanged_or_user_not_found" }),
      },
      result.count ? "Cached group provider avatar" : "Skipped group provider avatar cache",
    );
  } catch (error) {
    logger.warn(
      { event: "user_avatar.cache.failed", error: errorForLog(error) },
      "Failed to cache the group provider avatar",
    );
  }
}

/** Returns the cached avatar URL for a user, or null when no usable URL is stored. */
export async function loadAvatarUrl(userId: string): Promise<string | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { image: true } });
  const url = parseAvatarUrl(user?.image);
  if (!url) {
    logger.debug(
      {
        event: "user_avatar.load.missing",
        reason: user ? "invalid_or_missing_url" : "user_not_found",
        userId,
      },
      "No cached avatar available",
    );
  }
  return url;
}

/**
 * Fetches avatar bytes for a cached URL. The request carries no provider credentials, does not
 * follow redirects, and accepts only bounded raster images. Returns null instead of throwing.
 */
export async function fetchAvatarImage(
  url: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const target = parseAvatarUrl(url);
  if (!target) {
    logAvatarFetchFailure("invalid_url");
    return null;
  }
  const hostname = new URL(target).hostname;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AVATAR_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      method: "GET",
      headers: { Accept: "image/*" },
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      logAvatarFetchFailure("http_status", hostname, { status: response.status });
      return null;
    }
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!ALLOWED_AVATAR_TYPES.has(contentType.toLowerCase())) {
      logAvatarFetchFailure("content_type", hostname, { contentType });
      return null;
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MAX_AVATAR_BYTES) {
      logAvatarFetchFailure("content_length", hostname, { contentLength });
      return null;
    }
    const body = await readBoundedBody(response, MAX_AVATAR_BYTES);
    if (!body) {
      logAvatarFetchFailure("body_limit", hostname);
      return null;
    }
    return { body, contentType };
  } catch (error) {
    logAvatarFetchFailure(controller.signal.aborted ? "timeout" : "request_failed", hostname, {
      error: errorForLog(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function logAvatarFetchFailure(
  reason: string,
  hostname?: string,
  fields: Record<string, unknown> = {},
): void {
  logger.debug(
    { event: "user_avatar.fetch.failed", reason, ...(hostname ? { hostname } : {}), ...fields },
    "Failed to fetch provider avatar",
  );
}

async function readBoundedBody(response: Response, limit: number): Promise<ArrayBuffer | null> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new ArrayBuffer(size);
  const body = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}
