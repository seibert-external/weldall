import { z } from "zod";
import { scopeSetSchema, validateConnectorScopeConfig } from "./setup";

export const googleConfigSchema = z
  .object({
    clientId: z.string().trim().min(1).max(500),
    allowedScopes: scopeSetSchema,
    defaultScopes: scopeSetSchema,
  })
  .strict();
export type GoogleConfig = z.infer<typeof googleConfigSchema>;
export const googleSecretsSchema = z
  .object({ clientSecret: z.string().trim().min(1).max(10_000) })
  .strict();

/** Parses stored or administrator-supplied Google policy before any provider use. */
export function parseGoogleConfiguration(value: unknown): GoogleConfig {
  const config = googleConfigSchema.parse(value);
  validateConnectorScopeConfig(config);
  return config;
}
