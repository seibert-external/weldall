import { createDpopProof } from "@weldall/sdk";
import type { WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { successfulResponse, successfulResponseStream, isRecord } from "../http.js";
import { withAccess } from "./auth.js";
import { browserOpener } from "./browser.js";
import type { PreparedRequest } from "./resources.js";

export interface ConnectorScopeSummary {
  id: string;
  label: string;
  description: string;
  group: string;
  required: boolean;
}

export interface ConnectorSummary {
  key: string;
  name: string;
  type: string;
  requiredScopes: string[];
  scopes: ConnectorScopeSummary[];
  defaultScopes: string[];
}

export interface ConnectionSummary {
  id: string;
  ownerId: string;
  connectorId: string;
  name: string;
  accountId: string;
  accountName: string;
  selectedScopes: string[];
  grantedScopes: string[];
  status: string;
  version: number;
  lastUsedAt: string | null;
  requestCount: number;
  revocationError: string | null;
  createdAt: string;
  updatedAt: string;
  connectorKey: string;
  connectorEnabled: boolean;
}

export interface ConnectionAttempt {
  id: string;
  status: string;
  connector: { key: string; name: string; version: number };
  scopes: ConnectorScopeSummary[];
  selection: { scopes: string[] };
  expiresAt: string;
  connection: ConnectionSummary | null;
}

export interface DisconnectResult {
  status: string;
  revocationConfirmed?: boolean;
  message?: string;
}

/** Validates string arrays received from the managed-connection API boundary. */
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Validates nullable metadata strings received from Weldall. */
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/** Validates the credential-free connection contract before CLI rendering or persistence. */
export const isConnectionSummary = (value: unknown): value is ConnectionSummary =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.ownerId === "string" &&
  typeof value.connectorId === "string" &&
  typeof value.name === "string" &&
  typeof value.accountId === "string" &&
  typeof value.accountName === "string" &&
  isStringArray(value.selectedScopes) &&
  isStringArray(value.grantedScopes) &&
  typeof value.status === "string" &&
  typeof value.version === "number" &&
  isNullableString(value.lastUsedAt) &&
  typeof value.requestCount === "number" &&
  isNullableString(value.revocationError) &&
  typeof value.createdAt === "string" &&
  typeof value.updatedAt === "string" &&
  typeof value.connectorKey === "string" &&
  typeof value.connectorEnabled === "boolean";

/** Validates one administrator-approved scope descriptor before CLI rendering. */
const isConnectorScopeSummary = (value: unknown): value is ConnectorScopeSummary =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.label === "string" &&
  typeof value.description === "string" &&
  typeof value.group === "string" &&
  typeof value.required === "boolean";

/** Validates connector discovery metadata before CLI rendering. */
const isConnectorSummary = (value: unknown): value is ConnectorSummary =>
  isRecord(value) &&
  typeof value.key === "string" &&
  typeof value.name === "string" &&
  typeof value.type === "string" &&
  isStringArray(value.requiredScopes) &&
  Array.isArray(value.scopes) &&
  value.scopes.every(isConnectorScopeSummary) &&
  isStringArray(value.defaultScopes);

/** Validates authorization-attempt state before CLI recovery output. */
const isConnectionAttempt = (value: unknown): value is ConnectionAttempt =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.status === "string" &&
  isRecord(value.connector) &&
  typeof value.connector.key === "string" &&
  typeof value.connector.name === "string" &&
  typeof value.connector.version === "number" &&
  Array.isArray(value.scopes) &&
  value.scopes.every(isConnectorScopeSummary) &&
  isRecord(value.selection) &&
  isStringArray(value.selection.scopes) &&
  typeof value.expiresAt === "string" &&
  (value.connection === null || isConnectionSummary(value.connection));

/**
 * Calls Weldall's private managed-connection API with DPoP-bound Weldall credentials. Provider
 * tokens remain on the server and never cross into the CLI process.
 */
export async function requestConnectionApi({
  config,
  path,
  method = "GET",
  body,
}: {
  config: WeldallConfig;
  path: string;
  method?: string;
  body?: unknown;
}) {
  const url = `${config.issuer}/api/me/${path}`;
  return withAccess(config, async (session) =>
    successfulResponse(
      await fetch(url, {
        method,
        headers: {
          authorization: `DPoP ${session.accessToken}`,
          dpop: await createDpopProof({
            ...session.credentials,
            method,
            url,
            accessToken: session.accessToken,
          }),
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }),
      "Weldall connection request",
    ),
  );
}

/** Lists credential-free managed connections for CLI table, JSON, and agentic output. */
export async function listConnections(config: WeldallConfig): Promise<ConnectionSummary[]> {
  const value = await requestConnectionApi({ config, path: "connections" });
  if (!Array.isArray(value) || value.some((connection) => !isConnectionSummary(connection)))
    throw new CliError("Weldall returned an invalid connection list");
  return value;
}

/** Lists enabled connector catalogs and scope descriptions for CLI discovery. */
export async function listConnectors(config: WeldallConfig): Promise<ConnectorSummary[]> {
  const value = await requestConnectionApi({ config, path: "connectors" });
  if (!Array.isArray(value) || value.some((connector) => !isConnectorSummary(connector)))
    throw new CliError("Weldall returned an invalid connector list");
  return value;
}

/** Loads one managed connection selected by ID or owner-unique name for CLI output. */
export async function showConnection({
  config,
  selector,
}: {
  config: WeldallConfig;
  selector: string;
}): Promise<ConnectionSummary> {
  const value = await requestConnectionApi({
    config,
    path: `connections/${encodeURIComponent(selector)}`,
  });
  if (!isConnectionSummary(value)) throw new CliError("Weldall returned an invalid connection");
  return value;
}

/** Loads one interrupted authorization attempt so the CLI can report recovery state. */
export async function showConnectionAttempt({
  config,
  id,
}: {
  config: WeldallConfig;
  id: string;
}): Promise<ConnectionAttempt> {
  const value = await requestConnectionApi({
    config,
    path: `connection-authorizations/${encodeURIComponent(id)}`,
  });
  if (!isConnectionAttempt(value))
    throw new CliError("Weldall returned an invalid connection setup status");
  return value;
}

/** Requests explicit provider revocation and local disconnection for one CLI-selected connection. */
export async function disconnectConnection({
  config,
  selector,
}: {
  config: WeldallConfig;
  selector: string;
}): Promise<DisconnectResult> {
  const value = await requestConnectionApi({
    config,
    path: `connections/${encodeURIComponent(selector)}`,
    method: "POST",
  });
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    (value.revocationConfirmed !== undefined && typeof value.revocationConfirmed !== "boolean") ||
    (value.message !== undefined && typeof value.message !== "string")
  )
    throw new CliError("Weldall returned an invalid disconnect result");
  return value as unknown as DisconnectResult;
}

/** Runs the CLI side of browser-mediated connection setup and polls Weldall until completion. */
export async function connectAccount({
  config,
  connector,
  name,
  reconnect,
}: {
  config: WeldallConfig;
  connector: string;
  name: string;
  reconnect?: string;
}): Promise<ConnectionSummary> {
  const attempt = await requestConnectionApi({
    config,
    path: "connections",
    method: "POST",
    body: { connector, name, ...(reconnect ? { reconnect } : {}) },
  });
  if (!isRecord(attempt) || typeof attempt.id !== "string" || typeof attempt.setupUrl !== "string")
    throw new CliError("Invalid connection setup response");
  const url = new URL(attempt.setupUrl);
  if (
    url.origin !== config.issuer ||
    url.pathname !== `/connections/setup/${attempt.id}` ||
    url.search ||
    url.hash
  )
    throw new CliError("Unsafe setup URL");
  console.error(
    `Open ${url.toString()}\nAttempt: ${attempt.id}. You can interrupt and check it with 'weldall connections status ${attempt.id}'.`,
  );
  await browserOpener(url.toString()).catch(() =>
    console.error("Open the setup URL manually in your browser."),
  );
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const status = await requestConnectionApi({
      config,
      path: `connection-authorizations/${encodeURIComponent(attempt.id)}`,
    });
    if (!isRecord(status) || typeof status.status !== "string")
      throw new CliError("Invalid authorization status");
    if (status.status === "COMPLETED") {
      if (!isConnectionSummary(status.connection))
        throw new CliError("Invalid completed connection response");
      return status.connection;
    }
    if (!["SETUP", "AUTHORIZING", "PROCESSING"].includes(status.status))
      throw new CliError(`Authorization status: ${status.status}`, {
        hint:
          status.status === "NEEDS_REVOCATION"
            ? `Run weldall connections cancel ${attempt.id} to revoke the unused grant. Depending on the provider, revocation may affect other connections for the same account and application.`
            : "Start a new connection attempt.",
      });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new CliError("Connection setup timed out", {
    hint: `Check weldall connections status ${attempt.id}. Completed connections remain available even if the CLI was interrupted.`,
  });
}
/** Checks basic metadata syntax, not provider authorization; only the server may trust the target. */
export function validateConnectionTarget(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError("A full HTTPS provider URL is required");
  }
  if (
    !raw.startsWith("https://") ||
    /[\s\\\x00-\x1f\x7f]/.test(raw) ||
    Buffer.byteLength(raw) > 8192 ||
    url.username ||
    url.password ||
    raw.includes("#") ||
    url.port
  )
    throw new CliError("A full HTTPS provider URL without credentials or fragments is required");
}
/** Streams one authenticated CLI request through Weldall's owner-selected connector proxy. */
export async function requestConnection({
  config,
  selector,
  input,
}: {
  config: WeldallConfig;
  selector: string;
  input: PreparedRequest;
}) {
  validateConnectionTarget(input.url);
  const connection = await showConnection({ config, selector });
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(connection.connectorKey))
    throw new CliError("Invalid connector key");
  const url = new URL(`/connectors/${connection.connectorKey}`, config.issuer);
  return withAccess(config, async (session) => {
    const headers = new Headers(input.headers);
    headers.set("authorization", `DPoP ${session.accessToken}`);
    headers.set(
      "dpop",
      await createDpopProof({
        ...session.credentials,
        method: input.method,
        url: url.toString(),
        accessToken: session.accessToken,
      }),
    );
    headers.set("x-weldall-connection", connection.id);
    headers.set("x-weldall-upstream-url", input.url);
    if (input.json !== undefined) headers.set("content-type", "application/json");
    return successfulResponseStream(
      await fetch(url, {
        method: input.method,
        headers,
        ...(input.json !== undefined
          ? { body: JSON.stringify(input.json) }
          : input.body !== undefined
            ? { body: input.body }
            : {}),
        redirect: "error",
        signal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      }),
      "Weldall connector request",
    );
  });
}
