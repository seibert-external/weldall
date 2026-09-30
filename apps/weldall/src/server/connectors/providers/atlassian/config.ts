import { z } from "zod";
import { ConnectorError } from "../../errors";
import { CONFLUENCE_GRANULAR_SCOPE_IDS } from "./granular-scopes";
import { JIRA_CLASSIC_SCOPES, JIRA_GRANULAR_SCOPES } from "./jira-scopes";

// Cloud IDs are UUID-shaped opaque identifiers, not necessarily RFC4122 variant UUIDs.
export const cloudIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const requiredScopes = ["offline_access", "read:me"];
const CONFLUENCE_CLASSIC_SCOPES = [
  { id: "read:confluence-content.all", label: "Read Confluence content" },
  { id: "search:confluence", label: "Search Confluence" },
  { id: "read:confluence-space.summary", label: "Read Confluence spaces" },
  { id: "read:confluence-user", label: "Read Confluence users" },
  { id: "write:confluence-content", label: "Write Confluence content" },
] as const;
export const scopeCatalog = [
  ...JIRA_CLASSIC_SCOPES.map((scope) => ({
    ...scope,
    product: "jira" as const,
    mode: "classic" as const,
  })),
  ...JIRA_GRANULAR_SCOPES.map((scope) => ({
    ...scope,
    product: "jira" as const,
    mode: "granular" as const,
  })),
  ...CONFLUENCE_CLASSIC_SCOPES.map((scope) => ({
    ...scope,
    description: "Classic Confluence OAuth permission.",
    product: "confluence" as const,
    mode: "classic" as const,
  })),
  ...CONFLUENCE_GRANULAR_SCOPE_IDS.map((id) => ({
    id,
    label: id,
    description: "Granular Confluence OAuth permission.",
    product: "confluence" as const,
    mode: "granular" as const,
  })),
];
export const canonicalScopes = (values: string[]) => [...new Set(values)].sort();
const scopeIdSchema = z.string().min(1).max(200);
const productScopeSet = z.array(scopeIdSchema).max(50).transform(canonicalScopes);
const selectionScopeSet = z
  .array(scopeIdSchema)
  .max(50 + requiredScopes.length)
  .transform(canonicalScopes);
export const atlassianConfigSchema = z
  .object({
    clientId: z.string().trim().min(1).max(500),
    grantType: z.literal("resource"),
    products: z
      .array(z.enum(["jira", "confluence"]))
      .min(1)
      .max(2)
      .transform((values) => [...new Set(values)].sort()),
    allowedCloudIds: z
      .array(cloudIdSchema)
      .min(1)
      .max(100)
      .transform((values) => [...new Set(values)].sort()),
    allowedScopes: productScopeSet,
    defaultScopes: productScopeSet,
  })
  .strict()
  .superRefine((config, ctx) => {
    const offered = scopeCatalog.filter((scope) => config.products.includes(scope.product));
    if (
      !config.allowedScopes.length ||
      config.allowedScopes.some((id) => !offered.some((scope) => scope.id === id))
    )
      ctx.addIssue({
        code: "custom",
        message: "Select supported scopes for the enabled products.",
        path: ["allowedScopes"],
      });
    if (config.defaultScopes.some((id) => !config.allowedScopes.includes(id)))
      ctx.addIssue({
        code: "custom",
        message: "Default scopes must be allowed.",
        path: ["defaultScopes"],
      });
  });
export type AtlassianConfig = z.infer<typeof atlassianConfigSchema>;
export const atlassianSecretsSchema = z
  .object({ clientSecret: z.string().trim().min(1).max(10_000) })
  .strict();
export const selectionSchema = z.object({ scopes: selectionScopeSet }).strict();
export function validateSelection(config: unknown, selection: unknown) {
  const policy = atlassianConfigSchema.parse(config);
  const selected = selectionSchema.parse(selection);
  if (
    requiredScopes.some((scope) => !selected.scopes.includes(scope)) ||
    selected.scopes.some(
      (scope) => !requiredScopes.includes(scope) && !policy.allowedScopes.includes(scope),
    ) ||
    !selected.scopes.some((scope) => policy.allowedScopes.includes(scope))
  )
    throw new ConnectorError(
      "selection_denied",
      "Choose at least one offered permission; required account permissions cannot be removed.",
      403,
    );
  return selected;
}
export const presets = {
  jira: ["read:jira-work", "read:jira-user"],
  confluence: ["read:confluence-content.all", "search:confluence", "read:confluence-space.summary"],
} satisfies Record<string, string[]>;
