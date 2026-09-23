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
const capabilities = (scopes: readonly string[]) =>
  new Set(scopes.flatMap((s) => implications[s] ?? []));
export function normalizeGrants(scopes: string[]): string[] {
  return [...new Set(scopes.map((s) => (s === `${google}userinfo.email` ? "email" : s)))].sort();
}
/** Intersect capabilities, not strings: broader grants never expand the user's selected boundary. */
export function effectiveCapabilities(
  config: { enabledApis: string[]; allowedScopes: string[] },
  selected: string[],
  granted: string[],
): Capability[] {
  const allowed = capabilities(config.allowedScopes),
    consent = capabilities(selected),
    actual = capabilities(granted);
  return [...consent]
    .filter(
      (c) =>
        allowed.has(c) &&
        actual.has(c) &&
        config.enabledApis.includes(c.split(".")[0] as "gmail" | "calendar"),
    )
    .sort();
}
/** A refresh may reduce grants, but a capability increase needs a new interactive authorization. */
export function refreshNeedsReconnect(
  config: { enabledApis: string[]; allowedScopes: string[] },
  selected: string[],
  previous: string[],
  next: string[],
): boolean {
  const before = new Set(effectiveCapabilities(config, selected, previous));
  const after = effectiveCapabilities(config, selected, next);
  return (
    requiredScopes.some((s) => !next.includes(s)) ||
    !after.length ||
    after.some((c) => !before.has(c))
  );
}

export function availableScopes(config: Pick<ConnectorConfig, "allowedScopes">) {
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
export function validateSelection(
  config: { enabledApis: string[]; allowedScopes: string[] },
  selected: string[],
): string[] {
  const ids = new Set(availableScopes(config).map((s) => s.id));
  if (
    new Set(selected).size !== selected.length ||
    selected.some((s) => !ids.has(s)) ||
    requiredScopes.some((s) => !selected.includes(s))
  )
    throw new ConnectorError(
      "invalid_scopes",
      "Select the required identity permissions and only administrator-allowed permissions.",
    );
  if (!effectiveCapabilities(config, selected, selected).length)
    throw new ConnectorError("invalid_scopes", "Select at least one Gmail or Calendar permission.");
  return [...selected].sort();
}
export function validateScopeConfig(config: ConnectorConfig) {
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
