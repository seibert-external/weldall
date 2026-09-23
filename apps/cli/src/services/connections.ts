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
  capabilities: string[];
}

export interface ConnectorSummary {
  key: string;
  name: string;
  type: string;
  scopes: ConnectorScopeSummary[];
  defaultScopes: string[];
  requestPrefix: string;
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
  capabilities: string[];
  connectorKey: string;
  connectorEnabled: boolean;
}

export interface ConnectionAttempt {
  id: string;
  status: string;
  connector: { key: string; name: string; version: number };
  scopes: string[];
  selectedScopes: string[];
  capabilities: string[];
  expiresAt: string;
  connection: ConnectionSummary | null;
}

export interface DisconnectResult {
  status: string;
  revocationConfirmed?: boolean;
  message?: string;
}

const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

export const isConnectionSummary = (value: unknown): value is ConnectionSummary =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.ownerId === "string" &&
  typeof value.connectorId === "string" &&
  typeof value.name === "string" &&
  typeof value.accountId === "string" &&
  typeof value.accountName === "string" &&
  stringArray(value.selectedScopes) &&
  stringArray(value.grantedScopes) &&
  typeof value.status === "string" &&
  typeof value.version === "number" &&
  isNullableString(value.lastUsedAt) &&
  typeof value.requestCount === "number" &&
  isNullableString(value.revocationError) &&
  typeof value.createdAt === "string" &&
  typeof value.updatedAt === "string" &&
  stringArray(value.capabilities) &&
  typeof value.connectorKey === "string" &&
  typeof value.connectorEnabled === "boolean";

const isConnectorScopeSummary = (value: unknown): value is ConnectorScopeSummary =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.label === "string" &&
  typeof value.description === "string" &&
  typeof value.group === "string" &&
  typeof value.required === "boolean" &&
  stringArray(value.capabilities);

const isConnectorSummary = (value: unknown): value is ConnectorSummary =>
  isRecord(value) &&
  typeof value.key === "string" &&
  typeof value.name === "string" &&
  typeof value.type === "string" &&
  Array.isArray(value.scopes) &&
  value.scopes.every(isConnectorScopeSummary) &&
  stringArray(value.defaultScopes) &&
  typeof value.requestPrefix === "string";

const isConnectionAttempt = (value: unknown): value is ConnectionAttempt =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.status === "string" &&
  isRecord(value.connector) &&
  typeof value.connector.key === "string" &&
  typeof value.connector.name === "string" &&
  typeof value.connector.version === "number" &&
  stringArray(value.scopes) &&
  stringArray(value.selectedScopes) &&
  stringArray(value.capabilities) &&
  typeof value.expiresAt === "string" &&
  (value.connection === null || isConnectionSummary(value.connection));

/** Only Weldall credentials are used here. Provider tokens never leave the server. */
export async function connectionApi(
  config: WeldallConfig,
  path: string,
  method = "GET",
  body?: unknown,
) {
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

export async function listConnections(config: WeldallConfig): Promise<ConnectionSummary[]> {
  const value = await connectionApi(config, "connections");
  if (!Array.isArray(value) || value.some((connection) => !isConnectionSummary(connection)))
    throw new CliError("Weldall returned an invalid connection list");
  return value;
}

export async function listConnectors(config: WeldallConfig): Promise<ConnectorSummary[]> {
  const value = await connectionApi(config, "connectors");
  if (!Array.isArray(value) || value.some((connector) => !isConnectorSummary(connector)))
    throw new CliError("Weldall returned an invalid connector list");
  return value;
}

export async function showConnection(
  config: WeldallConfig,
  selector: string,
): Promise<ConnectionSummary> {
  const value = await connectionApi(config, `connections/${encodeURIComponent(selector)}`);
  if (!isConnectionSummary(value)) throw new CliError("Weldall returned an invalid connection");
  return value;
}

export async function showConnectionAttempt(
  config: WeldallConfig,
  id: string,
): Promise<ConnectionAttempt> {
  const value = await connectionApi(config, `connection-authorizations/${encodeURIComponent(id)}`);
  if (!isConnectionAttempt(value))
    throw new CliError("Weldall returned an invalid connection setup status");
  return value;
}

export async function disconnectConnection(
  config: WeldallConfig,
  selector: string,
): Promise<DisconnectResult> {
  const value = await connectionApi(config, `connections/${encodeURIComponent(selector)}`, "POST");
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    (value.revocationConfirmed !== undefined && typeof value.revocationConfirmed !== "boolean") ||
    (value.message !== undefined && typeof value.message !== "string")
  )
    throw new CliError("Weldall returned an invalid disconnect result");
  return value as unknown as DisconnectResult;
}

export async function connectAccount(
  config: WeldallConfig,
  connector: string,
  name: string,
  reconnect?: string,
): Promise<ConnectionSummary> {
  const attempt = await connectionApi(config, "connections", "POST", {
    connector,
    name,
    ...(reconnect ? { reconnect } : {}),
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
    const status = await connectionApi(
      config,
      `connection-authorizations/${encodeURIComponent(attempt.id)}`,
    );
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
            ? `Run weldall connections cancel ${attempt.id} to revoke the unused grant. Google revocation may affect other authorizations for this account/client.`
            : "Start a new connection attempt.",
      });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new CliError("Connection setup timed out", {
    hint: `Check weldall connections status ${attempt.id}. Completed connections remain available even if the CLI was interrupted.`,
  });
}
export function validateConnectionTarget(config: WeldallConfig, raw: string): URL {
  const url = new URL(raw);
  if (
    url.origin !== config.issuer ||
    !/^\/connectors\/[a-z0-9][a-z0-9._-]{0,119}\//.test(url.pathname) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new CliError(
      "Connection requests must use this Weldall installation's /connectors/<key>/ URL",
    );
  return url;
}
export async function connectionRequest(
  config: WeldallConfig,
  selector: string,
  input: PreparedRequest,
) {
  const url = validateConnectionTarget(config, input.url);
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
    headers.set("x-weldall-connection", selector);
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
