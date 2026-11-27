import { createDpopProof } from "@weldall/sdk";
import { CONFIG_REFRESH_HINT, type WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { boundedJsonResponse, isRecord } from "../http.js";
import type { AccessSession } from "./session-manager.js";
import { authenticatedGet } from "./skills.js";

/**
 * Apps the signed-in person may see: their own, and those shared with a permission they hold.
 * Served by `GET /api/me/apps`; a server that predates app discovery answers 404.
 */
export interface AppSummary {
  id: string;
  sourceId: string;
  name: string;
  description: string;
  own: boolean;
  /** False when the registry reports no owner for the app. */
  hasOwner: boolean;
  ownerName: string | null;
  scopes: string[];
  /** Null for an app without a Git repository. */
  repository: { name: string; url: string } | null;
  /** Where the app runs; null when it has no link. */
  url: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  expired: boolean;
  source: { type: string; key: string; name: string };
}
export interface AppWarning {
  source: string;
  code: string;
  /** With `apps_api_refused`: why Weldall refused the resource's apps API (an administrator note). */
  refusal?: string;
}
export interface AppList {
  items: AppSummary[];
  warnings: AppWarning[];
}

const isRepository = (value: unknown) =>
  value === null ||
  (isRecord(value) && typeof value.name === "string" && typeof value.url === "string");

const isAppSummary = (value: unknown): value is AppSummary =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.sourceId === "string" &&
  typeof value.name === "string" &&
  typeof value.description === "string" &&
  typeof value.own === "boolean" &&
  typeof value.hasOwner === "boolean" &&
  (value.ownerName === null || typeof value.ownerName === "string") &&
  Array.isArray(value.scopes) &&
  value.scopes.every((scope) => typeof scope === "string") &&
  isRepository(value.repository) &&
  (value.url === null || typeof value.url === "string") &&
  typeof value.revision === "number" &&
  typeof value.createdAt === "string" &&
  typeof value.updatedAt === "string" &&
  typeof value.expiresAt === "string" &&
  typeof value.expired === "boolean" &&
  isRecord(value.source) &&
  typeof value.source.type === "string" &&
  typeof value.source.key === "string" &&
  typeof value.source.name === "string";

export function parseAppList(value: unknown): AppList {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !value.items.every(isAppSummary) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every(
      (warning) =>
        isRecord(warning) && typeof warning.source === "string" && typeof warning.code === "string",
    )
  )
    throw new CliError("Weldall returned an invalid app list");
  return value as unknown as AppList;
}

/**
 * One registry as Weldall lists it in `registries` of `GET /api/me/apps`: a resource an
 * administrator switched app discovery on for, which Weldall checked against the resource's
 * registration. `allowed` and `adminAllowed` say whether the person holds `scope` and `adminScope`.
 * The CLI finds registries only here (`git/registries.ts`), never in a resource's own metadata.
 */
export interface AppRegistryListing {
  key: string;
  name: string;
  /** The resource identifier a token is requested for. */
  resource: string;
  /** `https://<registry>/…/apps`. */
  endpoint: string;
  scope: string;
  allowed: boolean;
  adminScope: string | null;
  adminAllowed: boolean;
  /** `https://<registry>/git/`, or null when the registry does not publish changes. */
  git: string | null;
  gitCredentials: string | null;
}

const MAX_REGISTRIES = 100;
const boundedText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;
const nullableText = (value: unknown, maximum: number) =>
  value === null || boundedText(value, maximum);

const isRegistryListing = (value: unknown): value is AppRegistryListing =>
  isRecord(value) &&
  boundedText(value.key, 200) &&
  boundedText(value.name, 200) &&
  boundedText(value.resource, 2_000) &&
  boundedText(value.endpoint, 2_000) &&
  boundedText(value.scope, 200) &&
  typeof value.allowed === "boolean" &&
  nullableText(value.adminScope, 200) &&
  typeof value.adminAllowed === "boolean" &&
  nullableText(value.git, 2_000) &&
  nullableText(value.gitCredentials, 2_000);

/**
 * The registries of a `GET /api/me/apps` answer; null when the answer has no `registries` key (a
 * server from before publishing apps). Throws when the key is there but malformed.
 */
export function parseAppRegistries(value: unknown): AppRegistryListing[] | null {
  if (!isRecord(value)) throw new CliError("Weldall returned an invalid app list");
  if (value.registries === undefined) return null;
  const { registries } = value;
  if (
    !Array.isArray(registries) ||
    registries.length > MAX_REGISTRIES ||
    !registries.every(isRegistryListing)
  )
    throw new CliError("Weldall returned an invalid list of registries for apps");
  return registries.map((entry) => ({
    key: entry.key,
    name: entry.name,
    resource: entry.resource,
    endpoint: entry.endpoint,
    scope: entry.scope,
    allowed: entry.allowed,
    adminScope: entry.adminScope,
    adminAllowed: entry.adminAllowed,
    git: entry.git,
    gitCredentials: entry.gitCredentials,
  }));
}

/** `GET /api/me/apps` holds every app the person may see; this bounds the read. */
const APP_LIST_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Reads the registries Weldall lists for this session (`GET <issuer>/api/me/apps`, DPoP with the
 * session's access token, no redirects, bounded). Null when the server lacks the route (404) or
 * its answer has no `registries`: publishing apps is not set up there.
 */
export async function fetchAppRegistries(
  config: WeldallConfig,
  session: AccessSession,
  signal: AbortSignal,
): Promise<AppRegistryListing[] | null> {
  const url = `${config.issuer}/api/me/apps`;
  const proof = await createDpopProof({
    ...session.credentials,
    method: "GET",
    url,
    accessToken: session.accessToken,
  });
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `DPoP ${session.accessToken}`,
      dpop: proof,
    },
    redirect: "error",
    signal,
  });
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new CliError(`${APP_LIST_LABEL} failed with HTTP ${response.status}`, {
      hint: CONFIG_REFRESH_HINT,
    });
  }
  return parseAppRegistries(await boundedJsonResponse(response, signal, APP_LIST_MAX_BYTES));
}

const APP_LIST_LABEL = "Weldall app list request";

export async function listApps(config: WeldallConfig): Promise<AppList> {
  try {
    const { value } = await authenticatedGet(
      config,
      `${config.issuer}/api/me/apps`,
      undefined,
      APP_LIST_LABEL,
    );
    return parseAppList(value);
  } catch (error) {
    // The transfer layer carries the status only in the message, so match its exact prefix rather
    // than any "HTTP 404" that a server's error detail might contain.
    const notFound = `${APP_LIST_LABEL} failed with HTTP 404`;
    if (
      error instanceof CliError &&
      (error.message === notFound || error.message.startsWith(`${notFound}:`))
    )
      throw new CliError("This Weldall server does not offer apps.", {
        cause: error,
        hint: "App discovery needs a newer Weldall server.",
      });
    throw error;
  }
}
