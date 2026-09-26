import { z } from "zod";
import { ConnectorError } from "../../errors";
import type { GoogleConfig } from "./config";

/** Provider scope descriptions are presentation data, never endpoint authorization rules. */
export interface ScopeDescriptor {
  id: string;
  label: string;
  description: string;
  group: string;
  required: boolean;
}
const google = "https://www.googleapis.com/auth/";
export const scopeCatalog: ScopeDescriptor[] = [
  {
    id: "openid",
    label: "Identify your Google account",
    description: "Required to verify the account and prevent account switching on reconnect.",
    group: "Identity",
    required: true,
  },
  {
    id: `${google}userinfo.email`,
    label: "View your email address",
    description: "Required to display the verified account associated with this connection.",
    group: "Identity",
    required: true,
  },
  {
    id: `${google}gmail.readonly`,
    label: "Read your mail",
    description: "Read messages, threads, labels and attachments.",
    group: "Gmail",
    required: false,
  },
  {
    id: `${google}gmail.send`,
    label: "Send mail",
    description: "Send mail as your Google account.",
    group: "Gmail",
    required: false,
  },
  {
    id: `${google}gmail.modify`,
    label: "Read and modify mail",
    description:
      "Allows all operations Google authorizes with this scope, including reading and sending mail.",
    group: "Gmail",
    required: false,
  },
  {
    id: `${google}calendar.readonly`,
    label: "View calendars",
    description: "Read calendars and their events.",
    group: "Calendar",
    required: false,
  },
  {
    id: `${google}calendar.events`,
    label: "Read and edit events",
    description: "Read, create, update and delete calendar events.",
    group: "Calendar",
    required: false,
  },
  {
    id: `${google}calendar`,
    label: "Manage calendars and events",
    description:
      "Allows all calendar operations Google authorizes, including operations covered by narrower permissions.",
    group: "Calendar",
    required: false,
  },
];
export const requiredScopes = scopeCatalog.filter((s) => s.required).map((s) => s.id);
/** Canonicalizes scope sets without aliases or inferred permissions. */
export const canonicalizeScopes = (scopes: readonly string[]) => [...new Set(scopes)].sort();
export const scopeSetSchema = z
  .array(z.string().min(1).max(160))
  .max(20)
  .transform(canonicalizeScopes);
export const selectionSchema = z.object({ scopes: scopeSetSchema }).strict();
export type GoogleSelection = z.infer<typeof selectionSchema>;

/** Lists offered scopes; groups are display labels only. */
export function listAvailableScopes(config: Pick<GoogleConfig, "allowedScopes">) {
  return scopeCatalog.filter((s) => s.required || config.allowedScopes.includes(s.id));
}
/** Validates owner consent against the current administrator policy. */
export function validateSelectedScopes({
  config,
  selected,
}: {
  config: Pick<GoogleConfig, "allowedScopes">;
  selected: string[];
}) {
  const ids = new Set(listAvailableScopes(config).map((scope) => scope.id));
  if (selected.some((s) => !ids.has(s)) || requiredScopes.some((s) => !selected.includes(s)))
    throw new ConnectorError(
      "invalid_scopes",
      "Select the required identity permissions and only administrator-allowed permissions.",
    );
  if (!selected.some((scope) => !requiredScopes.includes(scope)))
    throw new ConnectorError("invalid_scopes", "Select at least one API permission.");
  return canonicalizeScopes(selected);
}
/** Rejects unknown scopes and defaults outside the administrator's offered set. */
export function validateConnectorScopeConfig(config: GoogleConfig) {
  if (
    config.allowedScopes.some((id) => !scopeCatalog.some((s) => !s.required && s.id === id)) ||
    config.defaultScopes.some((s) => !config.allowedScopes.includes(s))
  )
    throw new ConnectorError(
      "invalid_scopes",
      "Unknown Google scope or default scope not allowed.",
    );
  if (!config.allowedScopes.length)
    throw new ConnectorError("invalid_scopes", "Allow at least one API permission.");
}
