import { z } from "zod";
import { ConnectorError } from "../../errors";
import { JIRA_CLASSIC_SCOPES } from "./jira-scopes";

// Cloud IDs are UUID-shaped opaque identifiers, not necessarily RFC4122 variant UUIDs.
export const cloudIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const requiredScopes = ["offline_access", "read:me"];
export const scopeCatalog = [
  ...JIRA_CLASSIC_SCOPES.map((scope) => ({ ...scope, product: "jira" as const })),
  { id: "read:confluence-content.all", label: "Read Confluence content", product: "confluence" },
  { id: "search:confluence", label: "Search Confluence", product: "confluence" },
  { id: "read:confluence-space.summary", label: "Read Confluence spaces", product: "confluence" },
  { id: "read:confluence-user", label: "Read Confluence users", product: "confluence" },
  { id: "write:confluence-content", label: "Write Confluence content", product: "confluence" },
] as const;
export const canonicalScopes = (values: string[]) => [...new Set(values)].sort();
const scopeSet = z.array(z.string().min(1).max(200)).max(50).transform(canonicalScopes);
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
    allowedScopes: scopeSet,
    defaultScopes: scopeSet,
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
export const selectionSchema = z.object({ scopes: scopeSet }).strict();
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
