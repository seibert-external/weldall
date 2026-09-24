import { z } from "zod";

const identity = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/);
const strings = z
  .array(z.string().min(1).max(160))
  .max(20)
  .transform((v) => [...new Set(v)].sort());
export const connectorConfig = z
  .object({
    key: identity,
    name: z.string().trim().min(1).max(200),
    type: z.literal("google"),
    enabled: z.boolean(),
    envelopeProvider: z.literal("LOCAL_ENV"),
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
