import type { ProviderUpstreamUrl } from "../../provider";
import { dispatchUpstream, parseCanonicalHttps, readBoundedBody } from "../../core/transport";

const RESPONSE_LIMIT = 64 * 1024;
/** For list responses (pull requests, commits, reviews, checks); GitHub's objects are large. */
export const LIST_RESPONSE_LIMIT = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export interface GitHubApiResponse {
  status: number;
  headers: Headers;
  /** Parsed body, or null when it is empty or not JSON. Never surfaced to callers of Weldall. */
  json: unknown;
}

/**
 * One bounded GitHub REST call with an App JWT or an installation token. Responses are read up to
 * a fixed size; callers map statuses to fixed messages and never forward GitHub's body.
 */
export async function githubApi({
  apiBaseUrl,
  path,
  method,
  token,
  accept = "application/vnd.github+json",
  body,
  responseLimit = RESPONSE_LIMIT,
  signal,
}: {
  apiBaseUrl: string;
  /** Already percent-encoded path below the API base. */
  path: string;
  method: "GET" | "POST";
  /** App JWT or installation token; sent as a Bearer token. */
  token: string;
  accept?: string;
  body?: object;
  /** Bytes read at most; a larger response fails with `too_large`. */
  responseLimit?: number;
  signal: AbortSignal;
}): Promise<GitHubApiResponse> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const response = await dispatchUpstream({
    upstreamUrl: parseCanonicalHttps(`${apiBaseUrl}${path}`) as ProviderUpstreamUrl,
    signal: bounded,
    init: {
      method,
      headers: {
        accept,
        authorization: `Bearer ${token}`,
        "user-agent": "Weldall",
        "x-github-api-version": "2022-11-28",
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

/** Path segment encoding for owner, repository, branch and team names. */
export const segment = encodeURIComponent;
