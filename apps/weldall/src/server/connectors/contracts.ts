import { z } from "zod";

const identity = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/);
const strings = z
  .array(z.string().min(1).max(160))
  .max(20)
  .transform((v) => [...new Set(v)].sort());
export const keySource = z
  .object({
    type: z.literal("local-env"),
    variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,199}$/),
  })
  .strict();
export const encryptionKeyConfig = z
  .object({
    key: identity,
    name: z.string().trim().min(1).max(200),
    activeVersion: identity,
    versions: z.record(
      identity,
      z
        .object({
          source: keySource,
        })
        .strict(),
    ),
  })
  .strict()
  .refine((v) => Object.hasOwn(v.versions, v.activeVersion), "Active version must be registered");
export const connectorConfig = z
  .object({
    key: identity,
    name: z.string().trim().min(1).max(200),
    type: z.literal("google"),
    enabled: z.boolean(),
    encryptionKey: identity,
    clientId: z.string().trim().min(1).max(500),
    enabledApis: z
      .array(z.enum(["gmail", "calendar"]))
      .min(1)
      .max(2)
      .transform((v) => [...new Set(v)].sort()),
    allowedScopes: strings,
    defaultScopes: strings,
  })
  .strict();
export type KeySource = z.infer<typeof keySource>;
export type KeyConfig = z.infer<typeof encryptionKeyConfig>;
export type ConnectorConfig = z.infer<typeof connectorConfig>;
export const connectionName = identity;
export class ConnectorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export interface ConnectorActor {
  id: string;
  email?: string | null;
  requestId: string;
  type?: "user" | "machine";
}
