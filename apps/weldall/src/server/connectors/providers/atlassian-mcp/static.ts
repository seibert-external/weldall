import { z } from "zod";
import { ATLASSIAN_MCP, canonicalScopes } from "./config";
import type { ProviderGrant, ConnectorProvider } from "../../provider";

export const apiKeySchema = z
  .string()
  .min(1)
  .max(32768)
  .regex(/^[\x21-\x7e]+$/);
export const serviceCredentialsSchema = z.strictObject({
  kind: z.literal("service-account-api-key"),
  apiKey: apiKeySchema,
});
export const serviceSelectionSchema = z.strictObject({
  kind: z.literal("service-account-api-key"),
  cloudIds: z.array(z.uuid()).max(100).transform(canonicalScopes),
});
export const serviceGrantSchema = serviceSelectionSchema.extend({
  resource: z.literal(ATLASSIAN_MCP.resource),
});
const createSchema = z.strictObject({
  ...serviceSelectionSchema.shape,
  apiKey: apiKeySchema,
});
export const staticConnection: NonNullable<ConnectorProvider["staticConnection"]> = {
  parseCreateInput(value) {
    const { apiKey, ...selection } = createSchema.parse(value);
    return {
      selection,
      credentials: { kind: selection.kind, apiKey },
      grant: serviceGrantSchema.parse({
        ...selection,
        resource: ATLASSIAN_MCP.resource,
      }) as ProviderGrant<z.output<typeof serviceGrantSchema>>,
    };
  },
  parseRotateInput(value) {
    const { apiKey } = z.strictObject({ apiKey: apiKeySchema }).parse(value);
    return { kind: "service-account-api-key", apiKey };
  },
};
