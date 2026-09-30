import { CliError } from "../errors.js";
import { isRecord } from "../http.js";
import {
  CONFLUENCE_GRANULAR_SCOPE_IDS,
  JIRA_GRANULAR_SCOPE_IDS,
} from "./atlassian-granular-scopes.js";

const JIRA_CLASSIC_SCOPE_IDS = [
  "read:jira-user",
  "read:jira-work",
  "write:jira-work",
  "manage:jira-project",
  "manage:jira-configuration",
  "manage:jira-webhook",
] as const;
const CONFLUENCE_CLASSIC_SCOPE_IDS = [
  "read:confluence-content.all",
  "search:confluence",
  "read:confluence-space.summary",
  "read:confluence-user",
  "write:confluence-content",
] as const;
const scopeCatalog = [
  ...JIRA_CLASSIC_SCOPE_IDS.map((id) => ({ product: "jira" as const, id })),
  ...JIRA_GRANULAR_SCOPE_IDS.map((id) => ({ product: "jira" as const, id })),
  ...CONFLUENCE_CLASSIC_SCOPE_IDS.map((id) => ({ product: "confluence" as const, id })),
  ...CONFLUENCE_GRANULAR_SCOPE_IDS.map((id) => ({ product: "confluence" as const, id })),
] as const;

/** Public policy only: never accept OAuth client secrets in a manifest. */
export function validateAtlassianConfiguration(value: unknown) {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "clientId",
          "grantType",
          "products",
          "allowedCloudIds",
          "allowedScopes",
          "defaultScopes",
        ].includes(key),
    ) ||
    typeof value.clientId !== "string" ||
    !value.clientId.trim() ||
    value.clientId.length > 500 ||
    value.grantType !== "resource"
  )
    throw new CliError("Invalid Atlassian provider configuration (resource-level grants required)");
  const products = value.products;
  const sites = value.allowedCloudIds;
  const allowed = value.allowedScopes;
  const defaults = value.defaultScopes;
  const supportsScope = (product: "jira" | "confluence", scope: unknown) =>
    typeof scope === "string" &&
    scopeCatalog.some((entry) => entry.product === product && entry.id === scope);
  if (
    !Array.isArray(products) ||
    !products.length ||
    products.length > 2 ||
    products.some((product) => product !== "jira" && product !== "confluence") ||
    !Array.isArray(sites) ||
    !sites.length ||
    sites.length > 100 ||
    sites.some(
      (id) =>
        typeof id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id),
    ) ||
    !Array.isArray(allowed) ||
    !allowed.length ||
    allowed.length > 50 ||
    allowed.some(
      (scope) => !products.some((product: "jira" | "confluence") => supportsScope(product, scope)),
    ) ||
    !Array.isArray(defaults) ||
    defaults.length > 50 ||
    defaults.some((scope) => !allowed.includes(scope))
  )
    throw new CliError("Invalid Atlassian products, site allowlist, or scopes");
}
export function canonicalAtlassianConfiguration(value: Record<string, unknown>) {
  const sorted = (items: unknown) => [...new Set(items as string[])].sort();
  return {
    ...value,
    products: sorted(value.products),
    allowedCloudIds: sorted(value.allowedCloudIds),
  };
}
