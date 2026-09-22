import { calculateJwkThumbprint } from "jose";
import { createDpopProof } from "@weldall/sdk";
import type { WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { isRecord, responseValue, successfulResponseStream } from "../http.js";
import { validateConnectionLease } from "../oauth/session.js";
import { withCredentialLock } from "../storage/lock.js";
import {
  personalConnectionKeychain,
  type StoredPersonalConnectionCredentials,
  type StoredPersonalConnectionCredentialsInput,
} from "../storage/keychain.js";
import { browserOpener, type BrowserOpener } from "./browser.js";
import { withAccess } from "./auth.js";
import type { PreparedRequest } from "./resources.js";

const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const API_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

export interface ConnectorSummary {
  id: string;
  key: string;
  name: string;
  type: "google";
  enabledApis: string[];
  oauthScopes: string[];
  allowedTargetPrefixes: string[];
}

/** The /api/me/connections contract is personal-only, never a shared credential transport. */
export interface PersonalConnectionSummary {
  id: string;
  name: string;
  connectorId: string;
  connectorKey: string;
  connectorName: string;
  account: { id: string; displayName: string };
  deviceId: string;
  status: "ready" | "reconnect_required";
  enabledApis: string[];
  grantedScopes: string[];
  allowedTargetPrefixes: string[];
  connectedAt: string;
  lastUsedAt: string | null;
  version: number;
}

interface AuthorizationStart {
  authorizationId: string;
  connectionId: string;
  connectionName: string;
  mode: "connect" | "reconnect";
  authorizationUrl: string;
}

export interface DisconnectResult {
  id: string;
  name: string;
  providerRevocation: "confirmed" | "failed" | "not_requested";
}

const endpoint = (config: WeldallConfig, path: string) => `${config.issuer}${path}`;
const selectorPath = (selector: string) => encodeURIComponent(selector);

async function authenticatedResponse(
  config: WeldallConfig,
  url: string,
  init: { method?: string; json?: unknown } = {},
): Promise<Response> {
  return withAccess(config, async (session) => {
    const method = init.method ?? "GET";
    const proof = await createDpopProof({
      ...session.credentials,
      method,
      url,
      accessToken: session.accessToken,
    });
    return fetch(url, {
      method,
      headers: {
        accept: "application/json",
        authorization: `DPoP ${session.accessToken}`,
        dpop: proof,
        ...(init.json === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      redirect: "error",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  });
}

async function authenticatedJson(
  config: WeldallConfig,
  url: string,
  init: { method?: string; json?: unknown } = {},
): Promise<unknown> {
  const response = await authenticatedResponse(config, url, init);
  const value = await responseValue(response);
  if (!response.ok) throw apiError(response.status, value);
  return value;
}

class ConnectorApiError extends CliError {
  constructor(
    message: string,
    readonly code: string | undefined,
    hint?: string,
  ) {
    super(message, { ...(hint ? { hint } : {}) });
    this.name = "ConnectorApiError";
  }
}

function apiError(status: number, value: unknown): CliError {
  const record = isRecord(value) ? value : undefined;
  const description =
    typeof record?.error_description === "string"
      ? record.error_description
      : typeof record?.error === "string"
        ? record.error
        : `HTTP ${status}`;
  const code = typeof record?.error === "string" ? record.error : undefined;
  return new ConnectorApiError(
    description,
    code,
    code === "not_found"
      ? "Run `weldall connections list`."
      : code === "authorization_required"
        ? "Run `weldall connections reconnect <connection>`."
        : undefined,
  );
}

export async function listConnectors(config: WeldallConfig): Promise<ConnectorSummary[]> {
  const value = await authenticatedJson(config, endpoint(config, "/api/me/connectors"));
  if (!isRecord(value) || !Array.isArray(value.connectors)) {
    throw new CliError("Weldall returned an invalid connector list");
  }
  return value.connectors.map(parseConnector);
}

export async function showConnector(
  config: WeldallConfig,
  selector: string,
): Promise<ConnectorSummary> {
  return parseConnector(
    await authenticatedJson(
      config,
      endpoint(config, `/api/me/connectors/${selectorPath(selector)}`),
    ),
  );
}

export async function listConnections(config: WeldallConfig): Promise<PersonalConnectionSummary[]> {
  const value = await authenticatedJson(config, endpoint(config, "/api/me/connections"));
  if (!isRecord(value) || !Array.isArray(value.connections)) {
    throw new CliError("Weldall returned an invalid connection list");
  }
  return value.connections.map(parseConnection);
}

export async function showConnection(
  config: WeldallConfig,
  selector: string,
): Promise<PersonalConnectionSummary> {
  return parseConnection(
    await authenticatedJson(
      config,
      endpoint(config, `/api/me/connections/${selectorPath(selector)}`),
    ),
  );
}

async function currentDevice(config: WeldallConfig): Promise<string> {
  return withAccess(config, (session) =>
    calculateJwkThumbprint(session.credentials.publicJwk, "sha256"),
  );
}

export async function connectAccount(
  config: WeldallConfig,
  input: { connector: string; name: string },
  openBrowser: BrowserOpener = browserOpener,
): Promise<PersonalConnectionSummary> {
  const started = parseAuthorizationStart(
    await authenticatedJson(config, endpoint(config, "/api/me/connections"), {
      method: "POST",
      json: { ...input, deviceId: await currentDevice(config) },
    }),
  );
  return completeInBrowser(config, started, openBrowser);
}

export async function reconnectAccount(
  config: WeldallConfig,
  selector: string,
  openBrowser: BrowserOpener = browserOpener,
): Promise<PersonalConnectionSummary> {
  const connection = await showConnection(config, selector);
  const started = parseAuthorizationStart(
    await authenticatedJson(
      config,
      endpoint(config, `/api/me/connections/${selectorPath(connection.id)}/authorization`),
      { method: "POST", json: { deviceId: await currentDevice(config) } },
    ),
  );
  return completeInBrowser(config, started, openBrowser);
}

async function completeInBrowser(
  config: WeldallConfig,
  started: AuthorizationStart,
  openBrowser: BrowserOpener,
): Promise<PersonalConnectionSummary> {
  try {
    await openBrowser(started.authorizationUrl);
  } catch (error) {
    throw new CliError("Unable to open Google authorization in your browser", { cause: error });
  }
  const deadline = Date.now() + AUTHORIZATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = endpoint(
      config,
      `/api/me/connection-authorizations/${selectorPath(started.authorizationId)}/credentials`,
    );
    const response = await authenticatedResponse(config, url, {
      method: "POST",
      json: { deviceId: await currentDevice(config) },
    });
    const value = await responseValue(response);
    if (response.status === 202) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    if (!response.ok) throw apiError(response.status, value);
    if (!isRecord(value)) throw new CliError("Weldall returned invalid connection credentials");
    const connection = parseConnection(value.connection);
    const credentials = parseOAuthCredentials(value.credentials);
    await personalConnectionKeychain.set(config.issuer, connection.id, credentials);
    return connection;
  }
  throw new CliError("Google authorization timed out", {
    hint:
      started.mode === "reconnect"
        ? `Run \`weldall connections reconnect ${started.connectionName}\` to try again.`
        : "Run the `weldall connections connect` command again.",
  });
}

export async function renameConnection(
  config: WeldallConfig,
  selector: string,
  name: string,
): Promise<PersonalConnectionSummary> {
  const connection = await showConnection(config, selector);
  return parseConnection(
    await authenticatedJson(
      config,
      endpoint(config, `/api/me/connections/${selectorPath(connection.id)}`),
      {
        method: "PATCH",
        json: { name, expectedVersion: connection.version },
      },
    ),
  );
}

export async function disconnectConnection(
  config: WeldallConfig,
  connection: PersonalConnectionSummary,
): Promise<DisconnectResult> {
  const credentials = await personalConnectionKeychain.get(config.issuer, connection.id);
  let value: unknown;
  try {
    value = await authenticatedJson(
      config,
      endpoint(config, `/api/me/connections/${selectorPath(connection.id)}/disconnect`),
      {
        method: "POST",
        json: credentials ? { token: credentials.refreshToken } : {},
      },
    );
  } catch (error) {
    if (error instanceof ConnectorApiError && error.code === "not_found") {
      await personalConnectionKeychain.clear(config.issuer, connection.id);
      return {
        id: connection.id,
        name: connection.name,
        providerRevocation: "not_requested",
      };
    }
    throw error;
  }
  const result = parseDisconnectResult(value);
  if (result.id !== connection.id) {
    throw new CliError("Weldall returned an invalid disconnect result");
  }
  await personalConnectionKeychain.clear(config.issuer, connection.id);
  return result;
}

export interface PreparedConnectionClient {
  connection: PersonalConnectionSummary;
  request(input: PreparedRequest): Promise<Response>;
}

export async function prepareConnectionClient(
  config: WeldallConfig,
  selector: string,
  initialTarget: string,
): Promise<PreparedConnectionClient> {
  const connection = await showConnection(config, selector);
  assertConnectionReady(connection);
  assertAllowedTarget(initialTarget, connection.allowedTargetPrefixes, connection.name);
  return {
    connection,
    request: (input) => connectionRequest(config, connection, input),
  };
}

async function connectionRequest(
  config: WeldallConfig,
  connection: PersonalConnectionSummary,
  input: PreparedRequest,
): Promise<Response> {
  const target = assertAllowedTarget(input.url, connection.allowedTargetPrefixes, connection.name);
  const method = input.method.toUpperCase();
  const deviceId = await currentDevice(config);
  let leaseValue: unknown;
  try {
    leaseValue = await authenticatedJson(
      config,
      endpoint(config, `/api/me/connections/${selectorPath(connection.id)}/lease`),
      { method: "POST", json: { url: target.toString(), method } },
    );
  } catch (error) {
    if (error instanceof ConnectorApiError && error.code === "not_found") {
      await personalConnectionKeychain.clear(config.issuer, connection.id);
      throw new CliError(`Connection ${JSON.stringify(connection.name)} was removed`);
    }
    throw error;
  }
  if (
    !isRecord(leaseValue) ||
    typeof leaseValue.lease !== "string" ||
    leaseValue.connectionId !== connection.id ||
    !Array.isArray(leaseValue.allowedTargetPrefixes) ||
    leaseValue.allowedTargetPrefixes.some((prefix) => typeof prefix !== "string")
  ) {
    throw new CliError("Weldall returned an invalid connection lease");
  }
  assertAllowedTarget(
    target.toString(),
    leaseValue.allowedTargetPrefixes as string[],
    connection.name,
  );
  await withAccess(config, (session) =>
    validateConnectionLease(config, leaseValue.lease as string, {
      subject: session.subject,
      connectionId: connection.id,
      deviceId,
      method,
      target,
    }),
  );
  const credentials = await currentConnectionCredentials(config, connection);
  const headers = new Headers(input.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${credentials.accessToken}`);
  if (input.json !== undefined) headers.set("content-type", "application/json");
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const response = await fetch(target, {
    method,
    headers,
    ...(input.json !== undefined
      ? { body: JSON.stringify(input.json) }
      : input.body !== undefined
        ? { body: input.body }
        : {}),
    signal,
    redirect: "error",
  });
  return successfulResponseStream(
    boundedProviderResponse(response),
    `${method} ${target.toString()}`,
  );
}

function boundedProviderResponse(response: Response): Response {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new CliError("Provider response exceeds the 100 MiB limit");
  }
  if (!response.body) return response;
  let received = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > MAX_RESPONSE_BYTES) {
          controller.error(new CliError("Provider response exceeds the 100 MiB limit"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function currentConnectionCredentials(
  config: WeldallConfig,
  connection: PersonalConnectionSummary,
): Promise<StoredPersonalConnectionCredentials> {
  return withCredentialLock(`${config.issuer}\0connection:${connection.id}`, async () => {
    const credentials = await personalConnectionKeychain.get(config.issuer, connection.id);
    if (!credentials) {
      throw new CliError(
        `Connection ${JSON.stringify(connection.name)} has no credentials on this device`,
        { hint: `Run \`weldall connections reconnect ${connection.name}\`.` },
      );
    }
    if (credentials.expiresAt > Math.floor(Date.now() / 1_000) + 60) return credentials;
    return refreshConnectionCredentials(config, connection, credentials);
  });
}

async function refreshConnectionCredentials(
  config: WeldallConfig,
  connection: PersonalConnectionSummary,
  credentials: StoredPersonalConnectionCredentials,
): Promise<StoredPersonalConnectionCredentials> {
  const value = parseOAuthCredentials(
    await authenticatedJson(
      config,
      endpoint(config, `/api/me/connections/${selectorPath(connection.id)}/refresh`),
      { method: "POST", json: { refreshToken: credentials.refreshToken } },
    ),
  );
  await personalConnectionKeychain.set(config.issuer, connection.id, value);
  return { version: 1, issuer: config.issuer, connectionId: connection.id, ...value };
}

function assertConnectionReady(connection: PersonalConnectionSummary): void {
  if (connection.status !== "ready") {
    throw new CliError(`Connection ${JSON.stringify(connection.name)} requires authorization`, {
      hint: `Run \`weldall connections reconnect ${connection.name}\`.`,
    });
  }
}

export function assertAllowedTarget(
  rawTarget: string,
  prefixes: readonly string[],
  connectionName: string,
): URL {
  let target: URL;
  try {
    target = new URL(rawTarget);
  } catch (error) {
    throw new CliError("Request URL must be an absolute HTTPS URL", { cause: error });
  }
  const allowed =
    target.protocol === "https:" &&
    !target.username &&
    !target.password &&
    !target.hash &&
    (!target.port || target.port === "443") &&
    prefixes.some((value) => {
      const prefix = new URL(value);
      const path = prefix.pathname.endsWith("/") ? prefix.pathname.slice(0, -1) : prefix.pathname;
      return (
        target.origin === prefix.origin &&
        (target.pathname === path || target.pathname.startsWith(`${path}/`))
      );
    });
  if (!allowed) {
    throw new CliError(
      `Connection ${JSON.stringify(connectionName)} cannot access ${target.toString()}`,
      { hint: `Allowed targets: ${prefixes.join(", ")}` },
    );
  }
  return target;
}

function parseAuthorizationStart(value: unknown): AuthorizationStart {
  if (
    !isRecord(value) ||
    typeof value.authorizationId !== "string" ||
    typeof value.connectionId !== "string" ||
    typeof value.connectionName !== "string" ||
    (value.mode !== "connect" && value.mode !== "reconnect") ||
    typeof value.authorizationUrl !== "string"
  ) {
    throw new CliError("Weldall returned an invalid authorization start");
  }
  const url = new URL(value.authorizationUrl);
  if (url.protocol !== "https:" || url.hostname !== "accounts.google.com") {
    throw new CliError("Weldall returned an unsafe authorization URL");
  }
  return {
    authorizationId: value.authorizationId,
    connectionId: value.connectionId,
    connectionName: value.connectionName,
    mode: value.mode,
    authorizationUrl: url.toString(),
  };
}

function parseConnector(value: unknown): ConnectorSummary {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.key !== "string" ||
    typeof value.name !== "string" ||
    value.type !== "google" ||
    !stringArray(value.enabledApis) ||
    !stringArray(value.oauthScopes) ||
    !stringArray(value.allowedTargetPrefixes)
  ) {
    throw new CliError("Weldall returned an invalid connector");
  }
  return value as unknown as ConnectorSummary;
}

function parseConnection(value: unknown): PersonalConnectionSummary {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.connectorId !== "string" ||
    typeof value.connectorKey !== "string" ||
    typeof value.connectorName !== "string" ||
    typeof value.deviceId !== "string" ||
    !["ready", "reconnect_required"].includes(String(value.status)) ||
    !stringArray(value.enabledApis) ||
    !stringArray(value.grantedScopes) ||
    !stringArray(value.allowedTargetPrefixes) ||
    typeof value.version !== "number" ||
    !isRecord(value.account) ||
    typeof value.account.id !== "string" ||
    typeof value.account.displayName !== "string" ||
    typeof value.connectedAt !== "string"
  ) {
    throw new CliError("Weldall returned an invalid connection");
  }
  return value as unknown as PersonalConnectionSummary;
}

function parseDisconnectResult(value: unknown): DisconnectResult {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !["confirmed", "failed", "not_requested"].includes(String(value.providerRevocation))
  ) {
    throw new CliError("Weldall returned an invalid disconnect result");
  }
  return value as unknown as DisconnectResult;
}

function parseOAuthCredentials(value: unknown): StoredPersonalConnectionCredentialsInput {
  if (
    !isRecord(value) ||
    typeof value.accessToken !== "string" ||
    !value.accessToken ||
    typeof value.refreshToken !== "string" ||
    !value.refreshToken ||
    !Number.isInteger(value.expiresAt) ||
    value.tokenType !== "Bearer" ||
    !stringArray(value.grantedScopes)
  ) {
    throw new CliError("Weldall returned invalid connection credentials");
  }
  return value as unknown as StoredPersonalConnectionCredentialsInput;
}

const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
