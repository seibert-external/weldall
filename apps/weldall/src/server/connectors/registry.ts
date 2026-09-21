import { AdminDomainError } from "../admin/service";
import { googleConnector } from "./google";
import type { ConnectorImplementation, GoogleConnectorConfig } from "./types";

export const GOOGLE_API_DEFINITIONS = {
  gmail: {
    name: "Gmail",
    allowedTargetPrefixes: ["https://gmail.googleapis.com/gmail/v1/"],
    scopes: [
      "https://www.googleapis.com/auth/gmail.metadata",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
      "https://mail.google.com/",
    ],
  },
  calendar: {
    name: "Google Calendar",
    allowedTargetPrefixes: ["https://www.googleapis.com/calendar/v3/"],
    scopes: [
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar",
    ],
  },
} as const;

export const CONNECTOR_REGISTRY = { google: googleConnector } as const satisfies Record<
  string,
  ConnectorImplementation<GoogleConnectorConfig>
>;

export function connectorImplementation(type: string) {
  const implementation = CONNECTOR_REGISTRY[type as keyof typeof CONNECTOR_REGISTRY];
  if (!implementation) throw new AdminDomainError("INVALID_PROVIDER", "Unknown connector type.");
  return implementation;
}

export function enabledApisForScopes(
  enabledApis: readonly string[],
  grantedScopes?: readonly string[],
): Array<keyof typeof GOOGLE_API_DEFINITIONS> {
  return enabledApis.filter(
    (api): api is keyof typeof GOOGLE_API_DEFINITIONS =>
      (api === "gmail" || api === "calendar") &&
      (grantedScopes === undefined ||
        GOOGLE_API_DEFINITIONS[api].scopes.some((scope) => grantedScopes.includes(scope))),
  );
}

export function allowedTargetPrefixes(
  enabledApis: readonly string[],
  grantedScopes?: readonly string[],
): string[] {
  return enabledApisForScopes(enabledApis, grantedScopes).flatMap((api) => [
    ...GOOGLE_API_DEFINITIONS[api].allowedTargetPrefixes,
  ]);
}

export function targetAllowed(
  rawTarget: string,
  enabledApis: readonly string[],
  grantedScopes?: readonly string[],
): URL | null {
  let target: URL;
  try {
    target = new URL(rawTarget);
  } catch {
    return null;
  }
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.hash ||
    (target.port && target.port !== "443")
  ) {
    return null;
  }
  const matches = allowedTargetPrefixes(enabledApis, grantedScopes).some((rawPrefix) => {
    const prefix = new URL(rawPrefix);
    const basePath = prefix.pathname.endsWith("/") ? prefix.pathname.slice(0, -1) : prefix.pathname;
    return (
      target.origin === prefix.origin &&
      (target.pathname === basePath || target.pathname.startsWith(`${basePath}/`))
    );
  });
  return matches ? target : null;
}
