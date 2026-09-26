import { ConnectorError } from "../../errors";
import { parseCanonicalHttps } from "../../core/transport";
import type { ProviderUpstreamUrl } from "../../provider";

const allowedOrigins = new Set([
  "https://gmail.googleapis.com",
  "https://www.googleapis.com",
  "https://calendar.googleapis.com",
]);
/**
 * Authorizes only reviewed Google origins, without interpreting API paths or query parameters.
 * Planned ConnectorPolicy primitives will couple endpoint/method combinations to required Weldall
 * scopes. That operation-level policy is deferred; Google scopes currently bound upstream access.
 */
export function resolveGoogleUpstreamUrl({
  requestedUrl,
}: {
  requestedUrl: URL;
}): ProviderUpstreamUrl {
  const url = parseCanonicalHttps(requestedUrl.href);
  if (!allowedOrigins.has(url.origin))
    throw new ConnectorError("invalid_target", "Provider origin is not supported.");
  return url as ProviderUpstreamUrl;
}
