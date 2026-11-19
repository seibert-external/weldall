import { GitAppError } from "../errors.js";

/**
 * Bounded HTTP for Git host REST calls, carried over from the server's connector transport
 * (`connectors/core/transport.ts`): canonical https targets only, no redirects, bounded bodies.
 */

export const URL_LIMIT = 8192;

/** Path segment encoding for owner, repository, branch, team and user names in REST paths. */
export const segment = encodeURIComponent;

/** Rejects parsing ambiguities before URL normalization can erase them. This does not authorize an origin. */
export function parseCanonicalHttps(raw: string): URL {
  const invalid = () => new GitAppError("invalid_target", "Invalid Git host URL.");
  if (
    !raw ||
    Buffer.byteLength(raw) > URL_LIMIT ||
    !raw.startsWith("https://") ||
    /[\s\\\x00-\x1f\x7f]/.test(raw) ||
    raw.includes("#") ||
    /%(?![a-f\d]{2})/i.test(raw)
  )
    throw invalid();
  let url: URL;
  try {
    url = new URL(raw);
    decodeURIComponent(raw);
  } catch {
    throw invalid();
  }
  const authority = raw.slice(8).split(/[/?]/, 1)[0]!;
  const rawPath = raw.slice(8 + authority.length).split("?", 1)[0]!;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    authority.includes("@") ||
    authority.includes("%") ||
    url.port ||
    (authority.includes(":") && !authority.endsWith(":443")) ||
    url.hash ||
    rawPath.startsWith("//") ||
    /%(?:2f|5c|25|00|0a|0d)/i.test(rawPath) ||
    rawPath.split("/").some((part) => [".", ".."].includes(decodeURIComponent(part)))
  )
    throw invalid();
  return url;
}

/** Buffers within a hard bound and cancels the reader on caller cancellation or timeout. */
export async function readBoundedBody({
  response,
  maximum,
  signal = AbortSignal.timeout(30_000),
}: {
  response: Response;
  maximum: number;
  signal?: AbortSignal;
}): Promise<Uint8Array> {
  signal.throwIfAborted();
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximum) {
    await response.body?.cancel();
    throw new GitAppError("too_large", "The Git host's answer is too large.", 502);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > maximum)
        throw new GitAppError("too_large", "The Git host's answer is too large.", 502);
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
}

/** Fetch to a host-resolved target; redirects and retries are never permitted. */
export async function dispatchUpstream({
  upstreamUrl,
  init,
  signal,
}: {
  upstreamUrl: URL;
  init: RequestInit;
  signal: AbortSignal;
}) {
  signal.throwIfAborted();
  const response = await fetch(upstreamUrl, { ...init, redirect: "error", signal });
  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    await response.body?.cancel();
    throw new GitAppError("redirect_denied", "Git host redirects are not permitted.", 502);
  }
  return response;
}
