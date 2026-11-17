import { z } from "zod";
import { ATLASSIAN_MCP, canonicalScopes } from "./config";
import type { ConnectorProvider, ProviderGrant } from "../../provider";

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
const createInputSchema = serviceSelectionSchema.extend({ apiKey: apiKeySchema.optional() });
export const staticConnection: NonNullable<ConnectorProvider["staticConnection"]> = {
  kind: "service-account-api-key",
  parseCreateInput(value) {
    const { apiKey, ...selection } = createInputSchema.parse(value);
    return { selection, credentials: apiKey ? { kind: selection.kind, apiKey } : null };
  },
  buildGrant({ selection }) {
    const grant = serviceGrantSchema.parse({
      ...serviceSelectionSchema.parse(selection),
      resource: ATLASSIAN_MCP.resource,
    });
    return grant as ProviderGrant<typeof grant>;
  },
  parseRotateInput(value) {
    const { apiKey } = z.strictObject({ apiKey: apiKeySchema }).parse(value);
    return { kind: "service-account-api-key", apiKey };
  },
};
