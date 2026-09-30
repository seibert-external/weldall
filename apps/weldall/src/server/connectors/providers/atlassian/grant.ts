import { z } from "zod";
import { logger } from "../../../observability/logger";
import { ConnectorError } from "../../errors";
import type { ProviderGrant, ProviderUpstreamUrl } from "../../provider";
import {
  atlassianConfigSchema,
  canonicalScopes,
  cloudIdSchema,
  requiredScopes,
  scopeCatalog,
  validateSelection,
} from "./config";
import { credentialsSchema, type Resource } from "./oauth";

const grantSchema = z
  .object({
    cloudId: cloudIdSchema,
    siteName: z.string().max(500),
    siteUrl: z.string().url(),
    scopes: z.array(z.string()),
    products: z
      .array(z.enum(["jira", "confluence"]))
      .min(1)
      .max(2),
  })
  .strict();
type Grant = z.infer<typeof grantSchema>;
export const parseGrant = (value: unknown) => grantSchema.parse(value) as ProviderGrant<Grant>;
const equalScopes = (a: string[], b: string[]) =>
  JSON.stringify(canonicalScopes(a)) === JSON.stringify(canonicalScopes(b));
export function validateResources({
  config,
  selection,
  credentials,
  resources,
  expectedCloudId,
}: {
  config: unknown;
  selection: unknown;
  credentials: unknown;
  resources: Resource[];
  expectedCloudId?: string;
}): ProviderGrant<Grant> {
  const policy = atlassianConfigSchema.parse(config);
  const selected = validateSelection(policy, selection);
  const cloudId = resources[0]?.id;
  const tokens = credentialsSchema.parse(credentials);
  // Resource-level mode is configured in Atlassian's console, not an authorize parameter.
  // Reject observable multi-site grants; a single-site account grant is not distinguishable here.
  if (
    !cloudId ||
    !policy.allowedCloudIds.includes(cloudId) ||
    resources.some((resource) => resource.id !== cloudId) ||
    (expectedCloudId !== undefined && cloudId !== expectedCloudId) ||
    !equalScopes(tokens.grantedScopes, selected.scopes)
  )
    throw new ConnectorError(
      "grant_mismatch",
      "Authorize one approved site with the requested permissions. An existing connection cannot switch sites during use.",
    );
  const productScopes = selected.scopes.filter((scope) => !requiredScopes.includes(scope));
  const resourceScopes = canonicalScopes(resources.flatMap((resource) => resource.scopes));
  const products = (["jira", "confluence"] as const).filter((product) => {
    const scopes = productScopes.filter((id) =>
      scopeCatalog.some((scope) => scope.id === id && scope.product === product),
    );
    return scopes.length > 0 && scopes.every((scope) => resourceScopes.includes(scope));
  });
  logger.debug(
    {
      event: "connector.atlassian.grant_scopes_observed",
      selectedScopes: selected.scopes,
      issuedScopes: tokens.grantedScopes,
      resourceScopes,
      resourceCount: resources.length,
      products,
    },
    "Observed Atlassian OAuth scopes during grant validation",
  );
  if (
    productScopes.some(
      (id) => !scopeCatalog.some((scope) => scope.id === id && products.includes(scope.product)),
    )
  )
    throw new ConnectorError(
      "grant_mismatch",
      "The selected site did not grant the requested product permissions.",
    );
  const site = resources[0]!;
  return parseGrant({
    cloudId,
    siteName: site.name,
    siteUrl: site.url,
    scopes: selected.scopes,
    products,
  });
}
export function resolveUpstream({
  config,
  selection,
  grant,
  requestedUrl,
}: {
  config: unknown;
  selection: unknown;
  grant: unknown;
  requestedUrl: URL;
}): ProviderUpstreamUrl {
  const policy = atlassianConfigSchema.parse(config);
  const selected = validateSelection(policy, selection);
  const approved = parseGrant(grant);
  const match = /^\/ex\/(jira|confluence)\/([^/]+)(\/.*)$/.exec(requestedUrl.pathname);
  if (
    requestedUrl.origin !== "https://api.atlassian.com" ||
    requestedUrl.username ||
    requestedUrl.password ||
    requestedUrl.hash ||
    !match ||
    match[2] !== approved.cloudId ||
    !policy.allowedCloudIds.includes(approved.cloudId) ||
    !equalScopes(approved.scopes, selected.scopes) ||
    !approved.products.includes(match[1] as "jira" | "confluence") ||
    !policy.products.includes(match[1] as "jira" | "confluence") ||
    // No encoded separators, traversal, or alternate gateway paths.
    /%|\\|\/\//.test(requestedUrl.pathname) ||
    !(
      match[1] === "jira"
        ? /^\/rest\/(api\/(2|3)|agile\/1\.0|servicedeskapi)\//
        : /^\/wiki\/(rest\/api|api\/v2)\//
    ).test(match[3]!)
  )
    throw new ConnectorError(
      "upstream_denied",
      "URL is outside this connection's approved site and products.",
      403,
    );
  return new URL(requestedUrl.toString()) as ProviderUpstreamUrl;
}
