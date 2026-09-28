import { z } from "zod";
import { googleConfigSchema } from "./providers/google/config";
import { atlassianConfigSchema } from "./providers/atlassian/config";
import { scopeKeySchema, type ScopeKey } from "../policy/scope-key";
export { ConnectorError } from "./errors";

const identity = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/);
const requiredScopeKeys = z
  .array(scopeKeySchema)
  .max(100)
  .transform((values) => [...new Set(values)].sort());
const connectorBase = z
  .object({
    key: identity,
    name: z.string().trim().min(1).max(200),
    enabled: z.boolean(),
    envelopeProvider: z.enum(["LOCAL_ENV", "OPENBAO"]),
    requiredScopes: requiredScopeKeys,
  })
  .strict();
export const connectorConfig = z.discriminatedUnion("type", [
  connectorBase.extend({ type: z.literal("google"), provider: googleConfigSchema }),
  connectorBase.extend({ type: z.literal("atlassian"), provider: atlassianConfigSchema }),
]);
export type ConnectorConfig = z.infer<typeof connectorConfig>;
export type ConnectorConfigInput = z.input<typeof connectorConfig>;
export const connectionName = identity;
export interface ConnectorActor {
  id: string;
  email?: string | null;
  requestId: string;
  type?: "user" | "machine";
}
export interface AuthorizedConnectorActor extends ConnectorActor {
  scopeKeys: readonly ScopeKey[];
}
