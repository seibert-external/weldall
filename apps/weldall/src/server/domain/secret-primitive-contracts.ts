import { z } from "zod";
import { mcpConnectorKeySchema } from "@weldall/sdk/mcp";
import { providerConfigSchema } from "../auth/oidc-config";
import { scopeKeySchema } from "../policy/scope-key";

export const SECRET_PRIMITIVES_FEATURE = "iac-ui-secrets-v1";
export const secretSections = ["sharedConnections", "groupProviders", "loginProviders"] as const;
export const publicLoginConfigSchema = providerConfigSchema.omit({ clientSecret: true });
export const loginProviderConfigSchema = publicLoginConfigSchema.extend({
  id: z.uuid(),
  enabled: z.boolean(),
});
export const groupProviderConfigSchema = z.strictObject({
  key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/),
  name: z.string().trim().min(1).max(200),
  adapterType: z.literal("management-api-v1"),
  baseUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && value === url.origin;
  }, "Use a canonical HTTPS origin"),
  enabled: z.boolean(),
});
export const sharedSelectionSchema = z.strictObject({
  kind: z.literal("service-account-api-key"),
  cloudIds: z
    .array(z.uuid())
    .max(100)
    .transform((ids) => [...new Set(ids)].sort()),
});
export const sharedConnectionConfigSchema = z.strictObject({
  key: mcpConnectorKeySchema,
  connectorKey: mcpConnectorKeySchema,
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
  useScopes: z
    .array(scopeKeySchema)
    .min(1)
    .max(100)
    .transform((keys) => [...new Set(keys)].sort()),
  credentialManagerEmail: z.string().trim().toLowerCase().email().max(320),
  serviceAccountLabel: z.string().trim().min(1).max(200),
  provider: sharedSelectionSchema,
});

export function publicGroupProvider(row: {
  key: string;
  name: string;
  adapterType: string;
  baseUrl: string;
  enabled: boolean;
}) {
  const { key, name, adapterType, baseUrl, enabled } = row;
  return groupProviderConfigSchema.parse({ key, name, adapterType, baseUrl, enabled });
}
export function publicLoginProvider(row: {
  id: string;
  name: string;
  buttonLabel: string;
  buttonColor: string;
  sortOrder: number;
  issuer: string;
  discoveryUrl: string | null;
  clientId: string;
  tokenEndpointAuthMethod: string;
  scopes: string[];
  allowedEmailDomains: string[];
  enabled: boolean;
}) {
  const {
    id,
    name,
    buttonLabel,
    buttonColor,
    sortOrder,
    issuer,
    discoveryUrl,
    clientId,
    tokenEndpointAuthMethod,
    scopes,
    allowedEmailDomains,
    enabled,
  } = row;
  return loginProviderConfigSchema.parse({
    id,
    name,
    buttonLabel,
    buttonColor,
    sortOrder,
    issuer,
    ...(discoveryUrl ? { discoveryUrl } : {}),
    clientId,
    tokenEndpointAuthMethod,
    scopes,
    allowedEmailDomains,
    enabled,
  });
}
export function publicSharedConnection(row: {
  key: string | null;
  name: string;
  enabled: boolean;
  accountName: string;
  providerSelection: unknown;
  connector: { key: string };
  owner: { email: string };
  useScopes: { scope: { key: string } }[];
}) {
  return sharedConnectionConfigSchema.parse({
    key: row.key,
    name: row.name,
    enabled: row.enabled,
    connectorKey: row.connector.key,
    credentialManagerEmail: row.owner.email,
    serviceAccountLabel: row.accountName,
    provider: row.providerSelection,
    useScopes: row.useScopes.map(({ scope }) => scope.key),
  });
}

export function sameLoginAuthority(
  a: z.output<typeof publicLoginConfigSchema>,
  b: z.output<typeof publicLoginConfigSchema>,
) {
  return (
    a.issuer === b.issuer &&
    a.discoveryUrl === b.discoveryUrl &&
    a.clientId === b.clientId &&
    a.tokenEndpointAuthMethod === b.tokenEndpointAuthMethod &&
    JSON.stringify(a.scopes) === JSON.stringify(b.scopes) &&
    JSON.stringify(a.allowedEmailDomains) === JSON.stringify(b.allowedEmailDomains)
  );
}
