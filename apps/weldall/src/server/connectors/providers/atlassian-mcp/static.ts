import { z } from "zod";
import { ATLASSIAN_MCP, canonicalScopes } from "./config";
import type { ConnectorProvider } from "../../provider";

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
export const staticConnection: NonNullable<ConnectorProvider["staticConnection"]> = {
  parseRotateInput(value) {
    const { apiKey } = z.strictObject({ apiKey: apiKeySchema }).parse(value);
    return { kind: "service-account-api-key", apiKey };
  },
};
