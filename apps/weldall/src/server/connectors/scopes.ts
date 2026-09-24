import { ConnectorError, type ConnectorConfig } from "./contracts";

/** Provider scope metadata drives the shared UI. Protocol requirements are never optional. */
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
    id: "email",
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
      "Includes reading AND sending mail, even when those narrower boxes are unticked. Does not allow permanent deletion.",
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
      "Includes viewing calendars and editing events even when narrower boxes are unticked. Weldall only exposes the operations documented for this connector.",
    group: "Calendar",
    required: false,
  },
];
export const requiredScopes = scopeCatalog.filter((s) => s.required).map((s) => s.id);
export type Capability =
  | "gmail.read"
  | "gmail.send"
  | "gmail.modify"
  | "calendar.read"
  | "calendar.events.read"
  | "calendar.events.write";
const implications: Record<string, Capability[]> = {
  [`${google}gmail.readonly`]: ["gmail.read"],
  [`${google}gmail.send`]: ["gmail.send"],
  [`${google}gmail.modify`]: ["gmail.read", "gmail.send", "gmail.modify"],
  [`${google}calendar.readonly`]: ["calendar.read", "calendar.events.read"],
  [`${google}calendar.events`]: ["calendar.events.read", "calendar.events.write"],
  [`${google}calendar`]: ["calendar.read", "calendar.events.read", "calendar.events.write"],
};
const collectCapabilities = (scopes: readonly string[]) =>
  new Set(scopes.flatMap((scope) => implications[scope] ?? []));

/** Normalizes Google's granted scope aliases before policy evaluation and persistence. */
export function normalizeGrants(scopes: string[]): string[] {
  return [...new Set(scopes.map((s) => (s === `${google}userinfo.email` ? "email" : s)))].sort();
}
/**
 * Computes the executable connector capabilities shared by setup, refresh, and proxy authorization;
 * broader provider grants never expand the user's selected boundary.
 */
export function calculateEffectiveCapabilities({
  config,
  selected,
  granted,
}: {
  config: { enabledApis: string[]; allowedScopes: string[] };
  selected: string[];
  granted: string[];
}): Capability[] {
  const allowed = collectCapabilities(config.allowedScopes),
    consent = collectCapabilities(selected),
    actual = collectCapabilities(granted);
  return [...consent]
    .filter(
      (c) =>
        allowed.has(c) &&
        actual.has(c) &&
        config.enabledApis.includes(c.split(".")[0] as "gmail" | "calendar"),
    )
    .sort();
}
/**
 * Decides whether refreshed Google grants must stop the connection until a new interactive consent;
 * reduced grants are allowed, while new capabilities are not accepted silently.
 */
export function shouldReconnectAfterRefresh({
  config,
  selected,
  previous,
  next,
}: {
  config: { enabledApis: string[]; allowedScopes: string[] };
  selected: string[];
  previous: string[];
  next: string[];
}): boolean {
  const before = new Set(calculateEffectiveCapabilities({ config, selected, granted: previous }));
  const after = calculateEffectiveCapabilities({ config, selected, granted: next });
  return (
    requiredScopes.some((s) => !next.includes(s)) ||
    !after.length ||
    after.some((c) => !before.has(c))
  );
}

/** Lists the administrator-allowed scope choices rendered by CLI and browser setup flows. */
export function listAvailableScopes(config: Pick<ConnectorConfig, "allowedScopes">) {
  const labels: Record<Capability, string> = {
    "gmail.read": "Read mail",
    "gmail.send": "Send mail",
    "gmail.modify": "Modify mail",
    "calendar.read": "Read calendars",
    "calendar.events.read": "Read calendar events",
    "calendar.events.write": "Create, update and delete calendar events",
  };
  return scopeCatalog
    .filter((s) => s.required || config.allowedScopes.includes(s.id))
    .map((s) => ({
      ...s,
      capabilities: (implications[s.id] ?? []).map((c) => labels[c]),
    }));
}
/** Validates and canonicalizes an owner's selected scopes against connector policy. */
export function validateSelectedScopes({
  config,
  selected,
}: {
  config: { enabledApis: string[]; allowedScopes: string[] };
  selected: string[];
}): string[] {
  const ids = new Set(listAvailableScopes(config).map((scope) => scope.id));
  if (
    new Set(selected).size !== selected.length ||
    selected.some((s) => !ids.has(s)) ||
    requiredScopes.some((s) => !selected.includes(s))
  )
    throw new ConnectorError(
      "invalid_scopes",
      "Select the required identity permissions and only administrator-allowed permissions.",
    );
  if (!calculateEffectiveCapabilities({ config, selected, granted: selected }).length)
    throw new ConnectorError("invalid_scopes", "Select at least one Gmail or Calendar permission.");
  return [...selected].sort();
}
/** Validates administrator scope policy before a connector configuration reaches PostgreSQL. */
export function validateConnectorScopeConfig(config: ConnectorConfig) {
  if (
    config.allowedScopes.some(
      (id) =>
        !scopeCatalog.some(
          (s) =>
            !s.required &&
            s.id === id &&
            config.enabledApis.includes(s.group.toLowerCase() as "gmail" | "calendar"),
        ),
    ) ||
    config.defaultScopes.some((s) => !config.allowedScopes.includes(s))
  )
    throw new ConnectorError(
      "invalid_scopes",
      "Allowed and default scopes must belong to enabled APIs.",
    );
  if (!config.allowedScopes.length)
    throw new ConnectorError("invalid_scopes", "Allow at least one API permission.");
}
