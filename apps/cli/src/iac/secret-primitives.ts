import { z } from "zod";
import { mcpConnectorKeySchema } from "@weldall/sdk/mcp";

export const SECRET_PRIMITIVES_FEATURE = "iac-ui-secrets-v1";
export const secretSections = ["sharedConnections", "groupProviders", "loginProviders"] as const;
const httpsUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  });
const name = z.string().trim().min(1).max(200);
const scope = z
  .string()
  .regex(/^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/)
  .max(160);
const set = <T extends z.ZodType<string>>(schema: T) =>
  z
    .array(schema)
    .max(100)
    .transform((values) => [...new Set(values)].sort());
export const secretPrimitiveSchemas = {
  sharedConnections: z.strictObject({
    key: mcpConnectorKeySchema,
    connectorKey: mcpConnectorKeySchema,
    name,
    enabled: z.boolean(),
    useScopes: set(scope).refine((keys) => keys.length > 0),
    credentialManagerEmail: z.string().trim().toLowerCase().email().max(320),
    serviceAccountLabel: name,
    provider: z.strictObject({
      kind: z.literal("service-account-api-key"),
      cloudIds: set(z.uuid()),
    }),
  }),
  groupProviders: z.strictObject({
    key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/),
    name,
    adapterType: z.literal("management-api-v1"),
    baseUrl: httpsUrl.refine((value) => new URL(value).origin === value),
    enabled: z.boolean(),
  }),
  loginProviders: z.strictObject({
    id: z.uuid(),
    name: z.string().trim().min(1).max(100),
    buttonLabel: z.string().trim().min(1).max(80),
    buttonColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    sortOrder: z.number().int().min(-10000).max(10000).default(0),
    issuer: httpsUrl.refine((value) => !new URL(value).search),
    discoveryUrl: httpsUrl.optional(),
    clientId: z.string().trim().min(1).max(512),
    tokenEndpointAuthMethod: z.enum(["client_secret_basic", "client_secret_post"]),
    scopes: z
      .array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/))
      .min(2)
      .max(20)
      .default(["openid", "profile", "email"])
      .refine(
        (scopes) =>
          scopes.includes("openid") &&
          scopes.includes("email") &&
          !scopes.includes("offline_access") &&
          new Set(scopes).size === scopes.length,
      ),
    allowedEmailDomains: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .max(253)
          .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
      )
      .max(100)
      .default([]),
    enabled: z.boolean(),
  }),
};
