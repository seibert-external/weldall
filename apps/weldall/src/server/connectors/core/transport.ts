import { ConnectorError } from "../errors";
import type { ProviderUpstreamUrl } from "../provider";

export const TRANSFER_LIMIT = 10 * 1024 * 1024;
export const URL_LIMIT = 8192;
export const HEADER_LIMIT = 32 * 1024;

/** Rejects parsing ambiguities before URL normalization can erase them. This does not authorize an origin. */
export function parseCanonicalHttps(raw: string): URL {
  const invalid = () => new ConnectorError("invalid_target", "Invalid provider URL.");
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

/** Bounds both retained and discarded headers, including attacker-supplied proxy metadata. */
export function assertHeaderSize(headers: Headers) {
  let size = 0;
  for (const [name, value] of headers)
    size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
  if (size > HEADER_LIMIT)
    throw new ConnectorError("too_large", "Connector header size limit exceeded.", 413);
}
const hopByHop = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
/** Preserves unknown end-to-end headers while removing transport, identity, and internal metadata. */
export function filterProxyHeaders({
  input,
  response = false,
}: {
  input: Headers;
  response?: boolean;
}) {
  assertHeaderSize(input);
  const nominated = new Set(
    (input.get("connection") ?? "")
      .toLowerCase()
      .split(",")
      .map((v) => v.trim()),
  );
  const denied = new Set([
    ...hopByHop,
    "content-length",
    ...(response
      ? ["set-cookie", "content-encoding", "authorization", "proxy-authenticate"]
      : ["authorization", "host", "cookie", "forwarded", "via", "dpop"]),
  ]);
  const headers = new Headers();
  for (const [name, value] of input) {
    if (
      denied.has(name) ||
      nominated.has(name) ||
      name.startsWith("proxy-") ||
      name.startsWith("x-forwarded-") ||
      name.startsWith("x-weldall-")
    )
      continue;
    headers.set(name, value);
  }
  return headers;
}
/** Buffers within a hard bound and cancels the reader on caller cancellation or timeout. */
export async function readBoundedBody({
  response,
  maximum,
  signal = AbortSignal.timeout(30_000),
}: {
  response: Response | Request;
  maximum: number;
  signal?: AbortSignal;
}): Promise<Uint8Array> {
  signal.throwIfAborted();
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximum) {
    await response.body?.cancel();
    throw new ConnectorError("too_large", "Connector transfer size limit exceeded.", 413);
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
        throw new ConnectorError("too_large", "Connector transfer size limit exceeded.", 413);
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
  }
}
/** Fetch accepts only provider-resolved targets; redirects and retries are never permitted. */
export async function dispatchUpstream({
  upstreamUrl,
  init,
  signal,
}: {
  upstreamUrl: ProviderUpstreamUrl;
  init: RequestInit;
  signal: AbortSignal;
}) {
  signal.throwIfAborted();
  const response = await fetch(upstreamUrl, { ...init, redirect: "error", signal });
  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    await response.body?.cancel();
    throw new ConnectorError("redirect_denied", "Provider redirects are not permitted.", 502);
  }
  return response;
}
