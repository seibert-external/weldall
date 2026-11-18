import type { ProviderUpstreamUrl } from "../../provider";
import { ConnectorError } from "../../errors";
import { dispatchUpstream, parseCanonicalHttps, readBoundedBody } from "../../core/transport";

const RESPONSE_LIMIT = 256 * 1024;
/** For list responses (pull requests, reviews, statuses, teams). */
export const LIST_RESPONSE_LIMIT = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
/** Forgejo caps every list at `MAX_RESPONSE_ITEMS`, 50 by default; larger limits are cut silently. */
export const FORGEJO_PAGE_SIZE = 50;

export interface ForgejoApiResponse {
  status: number;
  headers: Headers;
  /** Parsed body, or null when it is empty or not JSON. Never surfaced to callers of Weldall. */
  json: unknown;
}

/**
 * One bounded Forgejo REST call (`<baseUrl>/api/v1<path>`) with the bot user's access token.
 * Redirects are refused, so the token only ever reaches the configured origin. Responses are read
 * up to a fixed size; callers map statuses to fixed messages and never forward Forgejo's body
 * (its error texts may echo parts of a token).
 */
export async function forgejoApi({
  baseUrl,
  path,
  method,
  token,
  body,
  responseLimit = RESPONSE_LIMIT,
  signal,
}: {
  baseUrl: string;
  /** Already percent-encoded path below `/api/v1`. */
  path: string;
  method: "GET" | "POST" | "PUT";
  token: string;
  body?: object;
  responseLimit?: number;
  signal: AbortSignal;
}): Promise<ForgejoApiResponse> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const response = await dispatchUpstream({
    upstreamUrl: parseCanonicalHttps(`${baseUrl}/api/v1${path}`) as ProviderUpstreamUrl,
    signal: bounded,
    init: {
      method,
      headers: {
        accept: "application/json",
        authorization: `token ${token}`,
        "user-agent": "Weldall",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  });
  const bytes = await readBoundedBody({ response, maximum: responseLimit, signal: bounded });
  let json: unknown = null;
  try {
    json = bytes.byteLength ? JSON.parse(Buffer.from(bytes).toString("utf8")) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json };
}

/** Path segment encoding for owner, repository, team and user names. */
export const segment = encodeURIComponent;
/** Branch names may contain `/`; Forgejo routes them as several path segments. */
export const branchPath = (branch: string) => branch.split("/").map(segment).join("/");

export const protocolError = () =>
  new ConnectorError("upstream_protocol_error", "Forgejo sent an invalid response.", 502);

/** Status-only mapping for statuses an operation does not handle itself. */
export function unexpected(response: ForgejoApiResponse): ConnectorError {
  if (response.status === 401)
    return new ConnectorError(
      "credential_rejected",
      "Forgejo rejected the bot user's access token (it was revoked, or the user was disabled).",
      502,
    );
  if (response.status === 429)
    return new ConnectorError("upstream_rate_limited", "Forgejo is rate limiting Weldall.", 503);
  return new ConnectorError("upstream_unavailable", "Forgejo is unavailable.", 503);
}

/** Total item count Forgejo reports for a list, or null. */
export function totalCount(response: ForgejoApiResponse): number | null {
  const value = Number(response.headers.get("x-total-count"));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
