import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
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
const BLOCKED_AVATAR_IPV4_ADDRESSES = new BlockList();
const BLOCKED_AVATAR_IPV6_ADDRESSES = new BlockList();

for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_AVATAR_IPV4_ADDRESSES.addSubnet(address, prefix, "ipv4");
}

for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED_AVATAR_IPV6_ADDRESSES.addSubnet(address, prefix, "ipv6");
}

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
  if (!url) return;
  try {
    // Guarded so an unchanged avatar costs a statement but no write. `image` is nullable, so an
    // absent avatar needs its own branch: SQL `<>` never matches NULL.
    await db.user.updateMany({
      where: {
        email: email.trim().toLowerCase(),
        OR: [{ image: null }, { image: { not: url } }],
      },
      data: { image: url },
    });
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
  return parseAvatarUrl(user?.image);
}

/**
 * Fetches avatar bytes for a cached URL. The request carries no provider credentials, does not
 * follow redirects, and accepts only bounded raster images. Returns null instead of throwing.
 */
export async function fetchAvatarImage(
  url: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const target = parseAvatarUrl(url);
  if (!target) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AVATAR_REQUEST_TIMEOUT_MS);
  try {
    const parsedTarget = new URL(target);
    const signal = controller.signal;
    const resolved = await withAbort(resolvePublicAvatarAddress(parsedTarget), signal);
    if (!resolved) return null;
    const response = await requestAvatar(parsedTarget, resolved, signal);
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
      return closeRejectedResponse(response);
    }
    const contentType = headerValue(response.headers["content-type"]).split(";")[0]!.trim();
    if (!ALLOWED_AVATAR_TYPES.has(contentType.toLowerCase())) {
      return closeRejectedResponse(response);
    }
    const contentLength = Number(headerValue(response.headers["content-length"]) || "0");
    if (contentLength > MAX_AVATAR_BYTES) {
      return closeRejectedResponse(response);
    }
    const body = await readBoundedBody(response, MAX_AVATAR_BYTES, signal);
    return body ? { body, contentType } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function resolvePublicAvatarAddress(
  url: URL,
): Promise<{ address: string; family: 4 | 6 } | null> {
  const hostname = hostnameForAddressChecks(url);
  const literalFamily = isIP(hostname);
  const addresses =
    literalFamily === 4 || literalFamily === 6
      ? [{ address: hostname, family: literalFamily }]
      : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) return null;
  if (addresses.some((address) => isBlockedAvatarAddress(address.address, address.family))) {
    return null;
  }
  const selected = addresses[0]!;
  return { address: selected.address, family: selected.family as 4 | 6 };
}

function hostnameForAddressChecks(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}

function isBlockedAvatarAddress(address: string, family: number): boolean {
  if (family !== 4 && family !== 6) return true;
  return family === 4
    ? BLOCKED_AVATAR_IPV4_ADDRESSES.check(address, "ipv4")
    : BLOCKED_AVATAR_IPV6_ADDRESSES.check(address, "ipv6");
}

function requestAvatar(
  url: URL,
  resolved: { address: string; family: 4 | 6 },
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const hostname = hostnameForAddressChecks(url);
  return new Promise((resolve, reject) => {
    const clientRequest = request(
      url,
      {
        method: "GET",
        headers: { Accept: "image/*", Host: url.host },
        lookup: (_hostname, _options, callback) =>
          callback(null, resolved.address, resolved.family),
        servername: isIP(hostname) ? undefined : hostname,
        signal,
        timeout: AVATAR_REQUEST_TIMEOUT_MS,
      },
      resolve,
    );
    clientRequest.once("error", reject);
    clientRequest.once("timeout", () => {
      clientRequest.destroy();
      reject(new Error("avatar request timed out"));
    });
    clientRequest.end();
  });
}

function headerValue(value: IncomingHttpHeaders[string]): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function closeRejectedResponse(response: IncomingMessage): null {
  response.destroy();
  return null;
}

async function readBoundedBody(
  response: IncomingMessage,
  limit: number,
  signal: AbortSignal,
): Promise<ArrayBuffer | null> {
  signal.throwIfAborted();
  const abort = () => response.destroy(new Error("avatar request aborted"));
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const value of response) {
      const chunk = value instanceof Uint8Array ? value : Buffer.from(value);
      size += chunk.byteLength;
      if (size > limit) {
        response.destroy();
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener("abort", abort);
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
