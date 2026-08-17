import { decodeJwtPayload } from "./base64.js";
import {
  calculateJkt,
  createBrowserDpopProof,
  normalizeHtu,
  normalizeRequestTarget,
} from "./dpop.js";
import { WeldallBrowserError } from "./errors.js";
import { requireWeldallBrowserSupport } from "./support.js";
import {
  BrowserConnectionStore,
  STORAGE_SCHEMA_VERSION,
  type StoredBrowserConnection,
} from "./storage.js";
import type {
  WeldallBrowserClient,
  WeldallBrowserClientOptions,
  WeldallConnectionStatus,
  WeldallPendingConnection,
  WeldallRequestOptions,
} from "./types.js";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
const REFRESH_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:refresh_token";
const JWT_DPOP_GRANT = "urn:ietf:params:oauth:grant-type:jwt-dpop";

type Discovery = {
  issuer: string;
  token: string;
  deviceAuthorization: string;
  status: string;
  revoke: string;
  registry: string;
  resourceDiscovery: string;
};

type ResourceDescriptor = {
  key: string;
  name: string;
  resourceIdentifier: string;
  authorizationServer: string;
  downstreamClientId: string;
  requestPrefixes: string[];
  supportedScopes: string[];
  grantedScopes: string[];
  browserClientId: string;
};

type TokenSet = {
  accessToken: string;
  refreshToken: string;
  subject: string;
  connectionId: string;
};

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;

function exactOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password)
    throw new TypeError("Expected an exact HTTPS origin");
  return value;
}

function exactIssuer(value: string): string {
  return exactOrigin(value.trim().replace(/\/$/u, ""));
}

function exactResource(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new TypeError("Resource must be an absolute HTTPS URL without credentials or fragment");
  return url.toString().replace(/\/$/u, "");
}

function sameOriginEndpoint(value: unknown, issuer: string, path: string): string {
  if (typeof value !== "string") throw new TypeError("Discovery endpoint is missing");
  const url = new URL(value);
  if (
    url.origin !== issuer ||
    url.protocol !== "https:" ||
    url.pathname !== path ||
    url.search ||
    url.hash
  )
    throw new TypeError("Discovery endpoint is unsafe");
  return url.toString();
}

function browserOrigin(options: WeldallBrowserClientOptions): string {
  // The private override exists only for the controlled HTTP-localhost browser fixture.
  // It is intentionally absent from the public options type.
  const fixtureOrigin = (options as WeldallBrowserClientOptions & { origin?: string }).origin;
  if (fixtureOrigin) {
    if (!("location" in globalThis) || !["127.0.0.1", "localhost"].includes(location.hostname))
      throw new TypeError("Origin overrides are limited to the local browser fixture");
    return exactOrigin(fixtureOrigin);
  }
  if (!("location" in globalThis)) throw new TypeError("Browser location is unavailable");
  return exactOrigin(location.origin);
}

function mapNetworkError(error: unknown): WeldallBrowserError {
  const offline = "navigator" in globalThis && navigator.onLine === false;
  return new WeldallBrowserError(
    offline ? "network" : "cors",
    offline
      ? "The network is unavailable."
      : "The browser could not complete the cross-origin Weldall request.",
    offline
      ? "Reconnect to the network and retry."
      : "Verify the application origin is registered and inspect the browser CORS diagnostics.",
    { cause: error },
  );
}

async function parseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function oauthError(value: unknown): string | undefined {
  return isRecord(value) && typeof value.error === "string" ? value.error : undefined;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function safeFetch(
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(input, { ...init, credentials: "omit", redirect: "error" });
  } catch (error) {
    throw mapNetworkError(error);
  }
}

function parseStored(value: unknown): StoredBrowserConnection | null {
  if (value === undefined) return null;
  if (
    !isRecord(value) ||
    value.schemaVersion !== STORAGE_SCHEMA_VERSION ||
    typeof value.issuer !== "string" ||
    typeof value.resource !== "string" ||
    typeof value.origin !== "string" ||
    typeof value.browserClientId !== "string" ||
    !value.privateKey ||
    typeof value.privateKey !== "object" ||
    (value.privateKey as CryptoKey).type !== "private" ||
    (value.privateKey as CryptoKey).extractable ||
    (value.privateKey as CryptoKey).algorithm?.name !== "ECDSA" ||
    !(value.privateKey as CryptoKey).usages?.includes("sign") ||
    !isRecord(value.publicJwk) ||
    typeof value.jkt !== "string"
  )
    throw new TypeError("Stored Weldall connection is corrupt");

  const credentialFields = [
    value.refreshToken,
    value.connectionId,
    value.subject,
    value.refreshExpiresAt,
  ];
  const credentialsPresent = credentialFields.filter((field) => field !== undefined).length;
  const hasCompleteCredentials =
    credentialsPresent === credentialFields.length &&
    credentialFields.every((field) => typeof field === "string" && field.length > 0);
  const hasPending = value.pending !== undefined;
  if (hasPending) {
    if (
      credentialsPresent !== 0 ||
      !isRecord(value.pending) ||
      typeof value.pending.deviceCode !== "string" ||
      !value.pending.deviceCode ||
      typeof value.pending.userCode !== "string" ||
      !value.pending.userCode ||
      typeof value.pending.verificationUri !== "string" ||
      typeof value.pending.expiresAt !== "string" ||
      !Number.isFinite(new Date(value.pending.expiresAt).getTime()) ||
      typeof value.pending.intervalSeconds !== "number" ||
      !Number.isFinite(value.pending.intervalSeconds) ||
      value.pending.intervalSeconds < 1 ||
      (value.pending.nextPollAt !== undefined &&
        (typeof value.pending.nextPollAt !== "string" ||
          !Number.isFinite(new Date(value.pending.nextPollAt).getTime())))
    )
      throw new TypeError("Stored Weldall pending connection is corrupt");
  } else if (!hasCompleteCredentials) {
    throw new TypeError("Stored Weldall credentials are partial");
  }
  return value as StoredBrowserConnection;
}

export function browserConnectionNamespace(issuer: string, resource: string): string {
  return `weldall-browser:${issuer}:${resource}`;
}

async function verifyStoredKeyBinding(record: StoredBrowserConnection): Promise<void> {
  if ((await calculateJkt(record.publicJwk)) !== record.jkt)
    throw new TypeError("Stored Weldall public key thumbprint is inconsistent");
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    record.publicJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    record.privateKey,
    challenge,
  );
  if (
    !(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature,
      challenge,
    ))
  )
    throw new TypeError("Stored Weldall private key does not match its public key");
}

function accessTokenUsable(token: string | undefined): token is string {
  if (!token) return false;
  try {
    const payload = decodeJwtPayload(token);
    return typeof payload.exp === "number" && payload.exp > Math.floor(Date.now() / 1_000) + 5;
  } catch {
    return false;
  }
}

function targetMatchesPrefix(targetValue: string, prefixValue: string): boolean {
  const target = new URL(targetValue);
  const prefix = new URL(prefixValue);
  if (target.origin !== prefix.origin) return false;
  const path = prefix.pathname.endsWith("/") ? prefix.pathname : `${prefix.pathname}/`;
  return target.pathname === prefix.pathname || target.pathname.startsWith(path);
}

function connectionStatus(
  record: StoredBrowserConnection | null,
  issuer: string,
  resource: string,
  origin: string,
): WeldallConnectionStatus {
  if (!record) return { state: "disconnected", verified: "local" };
  if (record.issuer !== issuer || record.resource !== resource || record.origin !== origin)
    return { state: "invalid", verified: "local", reason: "origin-changed" };
  if (!record.privateKey) return { state: "invalid", verified: "local", reason: "missing-key" };
  if (record.refreshExpiresAt && new Date(record.refreshExpiresAt) <= new Date())
    return { state: "invalid", verified: "local", reason: "expired" };
  if (!record.refreshToken || !record.connectionId)
    return record.pending && new Date(record.pending.expiresAt) <= new Date()
      ? { state: "invalid", verified: "local", reason: "expired" }
      : { state: "disconnected", verified: "local" };
  return {
    state: "connected",
    verified: "local",
    connectionId: record.connectionId,
    origin: record.origin,
    resource: record.resource,
    ...(record.subject ? { subject: record.subject } : {}),
  };
}

function validateTokenSet(value: unknown, record: StoredBrowserConnection): TokenSet {
  if (
    !isRecord(value) ||
    typeof value.access_token !== "string" ||
    typeof value.refresh_token !== "string" ||
    value.token_type !== "DPoP"
  )
    throw new WeldallBrowserError(
      "invalid-response",
      "Weldall returned an invalid token set.",
      "Start a new browser connection.",
    );
  let payload: JsonRecord;
  try {
    payload = decodeJwtPayload(value.access_token);
  } catch (error) {
    throw new WeldallBrowserError(
      "invalid-response",
      "Weldall returned an invalid access token.",
      "Start a new browser connection.",
      { cause: error },
    );
  }
  const cnf = isRecord(payload.cnf) ? payload.cnf : null;
  const audiences =
    typeof payload.aud === "string"
      ? [payload.aud]
      : Array.isArray(payload.aud) && payload.aud.every((item) => typeof item === "string")
        ? payload.aud
        : [];
  if (
    payload.iss !== record.issuer ||
    !audiences.includes(`${record.issuer}/api`) ||
    new Set(audiences).size !== audiences.length ||
    payload.client_id !== record.browserClientId ||
    (audiences.length > 1
      ? payload.azp !== record.browserClientId
      : payload.azp !== undefined && payload.azp !== record.browserClientId) ||
    cnf?.jkt !== record.jkt ||
    typeof payload.exp !== "number" ||
    payload.exp <= Math.floor(Date.now() / 1_000) ||
    typeof payload.sub !== "string" ||
    (record.subject !== undefined && payload.sub !== record.subject) ||
    typeof payload.weldall_connection_id !== "string" ||
    (record.connectionId !== undefined && payload.weldall_connection_id !== record.connectionId) ||
    payload.weldall_connection_origin !== record.origin ||
    payload.weldall_connection_resource !== record.resource
  )
    throw new WeldallBrowserError(
      "invalid-response",
      "Weldall returned a token for another browser binding.",
      "Clear the local connection and start again.",
    );
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    subject: payload.sub,
    connectionId: payload.weldall_connection_id,
  };
}

export class WeldallBrowserClientImpl implements WeldallBrowserClient {
  private readonly issuer: string;
  private readonly resource: string;
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly store: BrowserConnectionStore;
  private readonly lockName: string;
  private discovery: Discovery | undefined;
  private accessToken: string | undefined;
  private descriptor: ResourceDescriptor | undefined;

  constructor(options: WeldallBrowserClientOptions) {
    this.issuer = exactIssuer(options.issuer);
    this.resource = exactResource(options.resource);
    this.origin = browserOrigin(options);
    this.fetcher = options.fetch ?? fetch;
    const namespace = browserConnectionNamespace(this.issuer, this.resource);
    this.lockName = namespace;
    const fixtureDatabaseName = (options as WeldallBrowserClientOptions & { databaseName?: string })
      .databaseName;
    this.store = new BrowserConnectionStore(fixtureDatabaseName ?? namespace);
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      void navigator.locks
        .request(this.lockName, { mode: "exclusive" }, async () => {
          try {
            resolve(await operation());
          } catch (error) {
            reject(error);
          }
        })
        .catch(reject);
    });
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const url = `${this.issuer}/.well-known/oauth-authorization-server`;
    const response = await safeFetch(this.fetcher, url, {
      headers: { accept: "application/json" },
    });
    const value = await parseJson(response);
    if (!response.ok || !isRecord(value) || value.issuer !== this.issuer)
      throw new WeldallBrowserError(
        "invalid-response",
        "Weldall discovery is invalid.",
        "Verify the configured issuer.",
      );
    const profile = isRecord(value.weldall_browser_connections)
      ? value.weldall_browser_connections
      : null;
    const grants = strings(value.grant_types_supported);
    if (!profile || !grants?.includes(DEVICE_GRANT))
      throw new WeldallBrowserError(
        "invalid-response",
        "Weldall does not advertise the browser connection profile.",
        "Ask the administrator to update Weldall.",
      );
    this.discovery = {
      issuer: this.issuer,
      token: sameOriginEndpoint(value.token_endpoint, this.issuer, "/api/auth/oauth2/token"),
      deviceAuthorization: sameOriginEndpoint(
        value.device_authorization_endpoint,
        this.issuer,
        "/api/auth/oauth2/device_authorization",
      ),
      status: sameOriginEndpoint(
        profile.current_status_endpoint,
        this.issuer,
        "/api/me/browser-connections/current",
      ),
      revoke: sameOriginEndpoint(
        profile.current_revoke_endpoint,
        this.issuer,
        "/api/me/browser-connections/current/revoke",
      ),
      registry: sameOriginEndpoint(
        profile.resource_registry_endpoint,
        this.issuer,
        "/api/me/scopes",
      ),
      resourceDiscovery: sameOriginEndpoint(
        profile.resource_discovery_endpoint,
        this.issuer,
        "/api/browser/resources/current",
      ),
    };
    return this.discovery;
  }

  private async discoverResource(discovery: Discovery): Promise<ResourceDescriptor> {
    if (this.descriptor) return this.descriptor;
    const url = new URL(discovery.resourceDiscovery);
    url.searchParams.set("resource", this.resource);
    const response = await safeFetch(this.fetcher, url.toString(), {
      headers: { accept: "application/json" },
    });
    const value = await parseJson(response);
    if (response.status === 403)
      throw new WeldallBrowserError(
        "origin-rejected",
        "This application origin is not registered for the resource.",
        "Open the application at its registered HTTPS origin.",
      );
    if (!response.ok || !isRecord(value))
      throw new WeldallBrowserError(
        "resource-disabled",
        "The Weldall resource is unavailable.",
        "Ask an administrator to enable the resource.",
      );
    this.descriptor = this.parseDescriptor(value);
    return this.descriptor;
  }

  private parseDescriptor(value: JsonRecord): ResourceDescriptor {
    const requestPrefixes = strings(value.requestPrefixes);
    const supportedScopes = strings(value.supportedScopes);
    const grantedScopes = strings(value.grantedScopes);
    if (
      typeof value.key !== "string" ||
      typeof value.name !== "string" ||
      value.resourceIdentifier !== this.resource ||
      typeof value.authorizationServer !== "string" ||
      typeof value.downstreamClientId !== "string" ||
      value.browserClientId !== `weldall-browser:${value.key}` ||
      !requestPrefixes ||
      !supportedScopes ||
      !grantedScopes
    )
      throw new WeldallBrowserError(
        "invalid-response",
        "Weldall returned an invalid resource description.",
        "Ask an administrator to repair the resource registration.",
      );
    exactOrigin(value.authorizationServer);
    for (const prefix of requestPrefixes) normalizeHtu(prefix);
    return {
      key: value.key,
      name: value.name,
      resourceIdentifier: value.resourceIdentifier,
      authorizationServer: value.authorizationServer,
      downstreamClientId: value.downstreamClientId,
      requestPrefixes,
      supportedScopes,
      grantedScopes,
      browserClientId: value.browserClientId,
    };
  }

  private async readValidated(): Promise<StoredBrowserConnection | null> {
    try {
      const record = parseStored(await this.store.read());
      if (record) await verifyStoredKeyBinding(record);
      return record;
    } catch (error) {
      if (error instanceof WeldallBrowserError) throw error;
      throw new WeldallBrowserError(
        "key-loss",
        "The stored browser connection or key is invalid.",
        "Call clearLocalConnection(), then start a new connection.",
        { cause: error },
      );
    }
  }

  async connect(
    options: { method?: "cli-code" | "browser-oauth" | "auto"; signal?: AbortSignal } = {},
  ): Promise<WeldallPendingConnection> {
    await requireWeldallBrowserSupport();
    const method = options.method ?? "auto";
    if (!["auto", "cli-code", "browser-oauth"].includes(method))
      throw new WeldallBrowserError(
        "unsupported-strategy",
        "The requested browser connection strategy is unknown.",
        "Use cli-code or auto.",
      );
    if (method === "browser-oauth")
      throw new WeldallBrowserError(
        "unsupported-strategy",
        "Browser OAuth is not enabled in this Weldall profile.",
        "Use the cli-code connection method.",
      );
    const initial = await this.withLock(async () => {
      const stored = await this.readValidated();
      if (stored?.pending && new Date(stored.pending.expiresAt) > new Date()) return stored;
      const existing = connectionStatus(stored, this.issuer, this.resource, this.origin);
      if (existing.state === "connected")
        throw new WeldallBrowserError(
          "connection-required",
          "This browser is already connected.",
          "Disconnect before creating a different connection.",
        );
      if (existing.state === "invalid")
        throw new WeldallBrowserError(
          "key-loss",
          "The local connection must be repaired before reconnecting.",
          "Call clearLocalConnection(), then reconnect.",
        );
      const discovery = await this.discover();
      const resource = await this.discoverResource(discovery);
      const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      if (pair.privateKey.extractable)
        throw new WeldallBrowserError(
          "key-loss",
          "The browser generated an exportable private key.",
          "Use a supported browser.",
        );
      const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const jkt = await calculateJkt(publicJwk);
      const proof = await createBrowserDpopProof({
        privateKey: pair.privateKey,
        publicJwk,
        method: "POST",
        url: discovery.deviceAuthorization,
      });
      const response = await safeFetch(this.fetcher, discovery.deviceAuthorization, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
        body: new URLSearchParams({ client_id: resource.browserClientId, resource: this.resource }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const value = await parseJson(response);
      if (
        response.status === 403 ||
        (response.status === 400 && oauthError(value) === "invalid_client")
      )
        throw new WeldallBrowserError(
          "origin-rejected",
          "Weldall rejected this browser origin.",
          "Open the registered resource application and retry.",
        );
      if (
        !response.ok ||
        !isRecord(value) ||
        typeof value.device_code !== "string" ||
        typeof value.user_code !== "string" ||
        typeof value.verification_uri !== "string" ||
        typeof value.expires_in !== "number" ||
        typeof value.interval !== "number"
      )
        throw new WeldallBrowserError(
          "invalid-response",
          "Weldall returned an invalid device authorization response.",
          "Retry the connection.",
        );
      const record: StoredBrowserConnection = {
        schemaVersion: 1,
        issuer: this.issuer,
        resource: this.resource,
        origin: this.origin,
        browserClientId: resource.browserClientId,
        privateKey: pair.privateKey,
        publicJwk,
        jkt,
        pending: {
          deviceCode: value.device_code,
          userCode: value.user_code,
          verificationUri: value.verification_uri,
          expiresAt: new Date(Date.now() + value.expires_in * 1_000).toISOString(),
          intervalSeconds: Math.max(1, value.interval),
          nextPollAt: new Date(Date.now() + Math.max(1, value.interval) * 1_000).toISOString(),
        },
      };
      await this.store.write(record);
      return record;
    });
    const pending = initial.pending!;
    return {
      userCode: pending.userCode,
      verificationUri: pending.verificationUri,
      expiresAt: pending.expiresAt,
      connected: this.poll(initial, options.signal),
    };
  }

  private async poll(
    initial: StoredBrowserConnection,
    signal?: AbortSignal,
  ): Promise<Extract<WeldallConnectionStatus, { state: "connected" }>> {
    const discovery = await this.discover();
    const deviceCode = initial.pending!.deviceCode;
    let delay = Math.max(
      0,
      new Date(initial.pending!.nextPollAt ?? Date.now()).getTime() - Date.now(),
    );
    for (;;) {
      // Recheck IndexedDB frequently enough that another tab can clear/cancel a
      // pending pairing without waiting for the RFC polling interval.
      if (delay > 0) await wait(Math.min(delay, 250), signal);
      const step = await this.withLock(async () => {
        const current = await this.readValidated();
        if (!current)
          throw new WeldallBrowserError(
            "connection-required",
            "The pending browser connection was cleared.",
            "Start a new connection if one is still needed.",
          );
        if (!current.pending) {
          const status = connectionStatus(current, this.issuer, this.resource, this.origin);
          if (status.state === "connected")
            return {
              kind: "connected" as const,
              status: { ...status, verified: "remote" as const },
            };
          throw new WeldallBrowserError(
            "connection-required",
            "The pending browser connection is no longer available.",
            "Start a new connection.",
          );
        }
        if (current.pending.deviceCode !== deviceCode)
          throw new WeldallBrowserError(
            "connection-required",
            "A different browser connection replaced this pending request.",
            "Use the newest connection code.",
          );
        const expiresAt = new Date(current.pending.expiresAt).getTime();
        if (Date.now() >= expiresAt) {
          await this.store.clear();
          throw new WeldallBrowserError(
            "connection-expired",
            "The browser connection code expired.",
            "Start a new connection.",
          );
        }
        const nextPollAt = new Date(current.pending.nextPollAt ?? 0).getTime();
        if (nextPollAt > Date.now())
          return { kind: "wait" as const, milliseconds: nextPollAt - Date.now() };

        current.pending.nextPollAt = new Date(
          Date.now() + current.pending.intervalSeconds * 1_000,
        ).toISOString();
        await this.store.write(current);
        const proof = await createBrowserDpopProof({
          privateKey: current.privateKey,
          publicJwk: current.publicJwk,
          method: "POST",
          url: discovery.token,
        });
        const response = await safeFetch(this.fetcher, discovery.token, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
          body: new URLSearchParams({
            grant_type: DEVICE_GRANT,
            client_id: current.browserClientId,
            device_code: current.pending.deviceCode,
          }),
          ...(signal ? { signal } : {}),
        });
        const value = await parseJson(response);
        if (!response.ok) {
          const error = oauthError(value);
          if (error === "authorization_pending")
            return { kind: "wait" as const, milliseconds: current.pending.intervalSeconds * 1_000 };
          if (error === "slow_down") {
            current.pending.intervalSeconds = Math.min(300, current.pending.intervalSeconds + 5);
            current.pending.nextPollAt = new Date(
              Date.now() + current.pending.intervalSeconds * 1_000,
            ).toISOString();
            await this.store.write(current);
            return { kind: "wait" as const, milliseconds: current.pending.intervalSeconds * 1_000 };
          }
          if (error === "access_denied") {
            await this.store.clear();
            throw new WeldallBrowserError(
              "connection-denied",
              "The browser connection was denied.",
              "Start a new connection if this was unintended.",
            );
          }
          if (error === "expired_token") {
            await this.store.clear();
            throw new WeldallBrowserError(
              "connection-expired",
              "The browser connection code expired.",
              "Start a new connection.",
            );
          }
          throw new WeldallBrowserError(
            "invalid-response",
            "Weldall rejected browser credential issuance.",
            "Start a new connection.",
          );
        }
        const tokens = validateTokenSet(value, current);
        const saved: StoredBrowserConnection = {
          ...current,
          refreshToken: tokens.refreshToken,
          connectionId: tokens.connectionId,
          subject: tokens.subject,
          refreshExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        };
        delete saved.pending;
        await this.store.write(saved);
        this.accessToken = tokens.accessToken;
        return {
          kind: "connected" as const,
          status: {
            state: "connected" as const,
            verified: "remote" as const,
            connectionId: tokens.connectionId,
            origin: saved.origin,
            resource: saved.resource,
            subject: tokens.subject,
          },
        };
      });
      if (step.kind === "connected") return step.status;
      delay = Math.max(1, step.milliseconds);
    }
  }

  private async localStatus(): Promise<WeldallConnectionStatus> {
    try {
      const raw = await this.store.read();
      if (
        isRecord(raw) &&
        (!raw.privateKey ||
          typeof raw.privateKey !== "object" ||
          (raw.privateKey as CryptoKey).type !== "private")
      )
        return { state: "invalid", verified: "local", reason: "missing-key" };
      const record = parseStored(raw);
      if (record) await verifyStoredKeyBinding(record);
      return connectionStatus(record, this.issuer, this.resource, this.origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return {
        state: "invalid",
        verified: "local",
        reason: /private key|public key|thumbprint|CryptoKey/iu.test(message)
          ? "missing-key"
          : "corrupt-storage",
      };
    }
  }

  private async issuerIsReachableWithoutCors(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.fetcher(`${this.issuer}/.well-known/oauth-authorization-server`, {
        method: "GET",
        mode: "no-cors",
        credentials: "omit",
        redirect: "error",
        ...(signal ? { signal } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  private async isTerminalOriginCors(error: unknown, signal?: AbortSignal): Promise<boolean> {
    return (
      error instanceof WeldallBrowserError &&
      error.code === "cors" &&
      (await this.issuerIsReachableWithoutCors(signal))
    );
  }

  private async refresh(
    record: StoredBrowserConnection,
    signal?: AbortSignal,
  ): Promise<StoredBrowserConnection> {
    if (!record.refreshToken)
      throw new WeldallBrowserError(
        "connection-required",
        "No browser connection is available.",
        "Connect this browser first.",
      );
    const discovery = await this.discover();
    const proof = await createBrowserDpopProof({
      privateKey: record.privateKey,
      publicJwk: record.publicJwk,
      method: "POST",
      url: discovery.token,
    });
    const response = await safeFetch(this.fetcher, discovery.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: record.browserClientId,
        refresh_token: record.refreshToken,
      }),
      ...(signal ? { signal } : {}),
    });
    const value = await parseJson(response);
    if (!response.ok) {
      if (oauthError(value) === "invalid_grant") {
        await this.store.clear();
        this.accessToken = undefined;
        throw new WeldallBrowserError(
          "refresh-replay",
          "The browser refresh family is no longer valid.",
          "Start a new browser connection.",
        );
      }
      throw new WeldallBrowserError(
        "network",
        "Weldall could not refresh the browser connection.",
        "Retry while preserving local credentials.",
      );
    }
    const tokens = validateTokenSet(value, record);
    if (tokens.refreshToken === record.refreshToken) {
      await this.store.clear();
      this.accessToken = undefined;
      throw new WeldallBrowserError(
        "invalid-response",
        "Weldall did not rotate the browser refresh token.",
        "Start a new browser connection.",
      );
    }
    const updated: StoredBrowserConnection = {
      ...record,
      refreshToken: tokens.refreshToken,
      connectionId: tokens.connectionId,
      subject: tokens.subject,
      refreshExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    };
    await this.store.write(updated);
    this.accessToken = tokens.accessToken;
    return updated;
  }

  async getConnectionStatus(
    options: { verify?: "local" | "remote"; signal?: AbortSignal } = {},
  ): Promise<WeldallConnectionStatus> {
    await requireWeldallBrowserSupport();
    if ((options.verify ?? "local") === "local") return this.localStatus();
    return this.withLock(async () => {
      const local = await this.localStatus();
      // A local terminal state cannot honestly be labelled remotely verified;
      // no authenticated request can be made without complete local credentials.
      if (local.state !== "connected") return local;
      let record = (await this.readValidated())!;
      try {
        record = await this.refresh(record, options.signal);
      } catch (error) {
        if (error instanceof WeldallBrowserError && error.code === "refresh-replay")
          return { state: "invalid", verified: "remote", reason: "revoked" };
        if (await this.isTerminalOriginCors(error, options.signal))
          return { state: "invalid", verified: "remote", reason: "origin-changed" };
        throw error;
      }
      const discovery = await this.discover();
      const proof = await createBrowserDpopProof({
        privateKey: record.privateKey,
        publicJwk: record.publicJwk,
        method: "GET",
        url: discovery.status,
        accessToken: this.accessToken!,
      });
      let response: Response;
      try {
        response = await safeFetch(this.fetcher, discovery.status, {
          headers: { authorization: `DPoP ${this.accessToken}`, dpop: proof },
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (await this.isTerminalOriginCors(error, options.signal))
          return { state: "invalid", verified: "remote", reason: "origin-changed" };
        throw error;
      }
      const value = await parseJson(response);
      if (!response.ok) {
        const error = oauthError(value);
        if (error === "browser_connection_origin_changed" || error === "browser_origin_invalid")
          return { state: "invalid", verified: "remote", reason: "origin-changed" };
        if (error === "browser_connection_expired" || error === "invalid_token")
          return { state: "invalid", verified: "remote", reason: "expired" };
        if (
          error === "browser_connection_revoked" ||
          error === "browser_connection_invalid" ||
          response.status === 410
        )
          return { state: "invalid", verified: "remote", reason: "revoked" };
        throw new WeldallBrowserError(
          "network",
          "Weldall connection status is unavailable.",
          "Retry without clearing local credentials.",
        );
      }
      if (
        !isRecord(value) ||
        value.id !== record.connectionId ||
        value.origin !== record.origin ||
        value.resource !== record.resource
      )
        return { state: "invalid", verified: "remote", reason: "origin-changed" };
      return {
        state: "connected",
        verified: "remote",
        connectionId: record.connectionId!,
        origin: record.origin,
        resource: record.resource,
        ...(record.subject ? { subject: record.subject } : {}),
      };
    });
  }

  private async registry(
    record: StoredBrowserConnection,
    signal?: AbortSignal,
  ): Promise<ResourceDescriptor> {
    const discovery = await this.discover();
    if (!accessTokenUsable(this.accessToken)) record = await this.refresh(record, signal);
    const proof = await createBrowserDpopProof({
      privateKey: record.privateKey,
      publicJwk: record.publicJwk,
      method: "GET",
      url: discovery.registry,
      accessToken: this.accessToken!,
    });
    const response = await safeFetch(this.fetcher, discovery.registry, {
      headers: { authorization: `DPoP ${this.accessToken}`, dpop: proof },
      ...(signal ? { signal } : {}),
    });
    const value = await parseJson(response);
    if (!response.ok || !Array.isArray(value) || value.length !== 1 || !isRecord(value[0]))
      throw new WeldallBrowserError(
        "invalid-response",
        "Weldall returned an invalid connection resource registry.",
        "Verify the connection resource remains enabled.",
      );
    const descriptor = this.parseDescriptor({
      ...value[0],
      browserClientId: record.browserClientId,
    });
    this.descriptor = descriptor;
    return descriptor;
  }

  async request(input: string | URL, options: WeldallRequestOptions): Promise<Response> {
    await requireWeldallBrowserSupport();
    return this.withLock(async () => {
      let record = await this.readValidated();
      if (
        !record ||
        connectionStatus(record, this.issuer, this.resource, this.origin).state !== "connected"
      )
        throw new WeldallBrowserError(
          "connection-required",
          "This browser is not connected.",
          "Connect it before requesting a protected resource.",
        );
      record = await this.refresh(record, options.signal ?? undefined);
      const descriptor = await this.registry(record, options.signal ?? undefined);
      const target = normalizeRequestTarget(input);
      if (!descriptor.requestPrefixes.some((prefix) => targetMatchesPrefix(target, prefix)))
        throw new WeldallBrowserError(
          "permission-denied",
          "The request target is outside this connection resource.",
          "Use a URL registered for the connected resource.",
        );
      const scopes = [...new Set(options.scopes)].sort();
      if (
        !scopes.length ||
        scopes.some(
          (scope) =>
            !descriptor.supportedScopes.includes(scope) ||
            !descriptor.grantedScopes.includes(scope),
        )
      )
        throw new WeldallBrowserError(
          "permission-denied",
          "The requested permission is not currently granted.",
          "Ask an administrator to grant the required resource scope.",
        );
      const discovery = await this.discover();
      const exchangeProof = await createBrowserDpopProof({
        privateKey: record.privateKey,
        publicJwk: record.publicJwk,
        method: "POST",
        url: discovery.token,
      });
      const exchangeResponse = await safeFetch(this.fetcher, discovery.token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", dpop: exchangeProof },
        body: new URLSearchParams({
          grant_type: TOKEN_EXCHANGE_GRANT,
          requested_token_type: ID_JAG_TOKEN_TYPE,
          subject_token_type: REFRESH_TOKEN_TYPE,
          subject_token: record.refreshToken!,
          client_id: record.browserClientId,
          resource: record.resource,
          audience: descriptor.authorizationServer,
          scope: scopes.join(" "),
        }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const exchange = await parseJson(exchangeResponse);
      if (!exchangeResponse.ok)
        throw new WeldallBrowserError(
          "permission-denied",
          "Weldall denied the current permission request.",
          "Check current scopes and resource state.",
        );
      if (!isRecord(exchange) || typeof exchange.access_token !== "string")
        throw new WeldallBrowserError(
          "invalid-response",
          "Weldall returned an invalid identity assertion.",
          "Retry the request.",
        );
      const assertion = exchange.access_token;
      const assertionClaims = decodeJwtPayload(assertion);
      const assertionCnf = isRecord(assertionClaims.cnf) ? assertionClaims.cnf : null;
      const assertionScopes =
        typeof assertionClaims.scope === "string" ? assertionClaims.scope.split(" ").sort() : [];
      const assertionAudience =
        typeof assertionClaims.aud === "string" ? assertionClaims.aud : null;
      if (
        assertionClaims.iss !== this.issuer ||
        assertionClaims.sub !== record.subject ||
        assertionAudience !== descriptor.authorizationServer ||
        assertionClaims.client_id !== descriptor.downstreamClientId ||
        assertionClaims.resource !== record.resource ||
        assertionCnf?.jkt !== record.jkt ||
        typeof assertionClaims.exp !== "number" ||
        assertionClaims.exp <= Math.floor(Date.now() / 1_000) ||
        assertionScopes.join(" ") !== scopes.join(" ")
      )
        throw new WeldallBrowserError(
          "invalid-response",
          "Weldall returned an identity assertion with the wrong binding.",
          "Do not retry; start a new connection.",
        );
      const downstreamTokenEndpoint = `${descriptor.authorizationServer}/oauth/token`;
      const downstreamProof = await createBrowserDpopProof({
        privateKey: record.privateKey,
        publicJwk: record.publicJwk,
        method: "POST",
        url: downstreamTokenEndpoint,
      });
      const downstreamResponse = await safeFetch(this.fetcher, downstreamTokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", dpop: downstreamProof },
        body: new URLSearchParams({ grant_type: JWT_DPOP_GRANT, assertion }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const downstream = await parseJson(downstreamResponse);
      if (
        !downstreamResponse.ok ||
        !isRecord(downstream) ||
        typeof downstream.access_token !== "string" ||
        downstream.token_type !== "DPoP"
      )
        throw new WeldallBrowserError(
          "invalid-response",
          "The resource rejected the identity assertion.",
          "Retry after checking resource availability.",
        );
      const headers = new Headers(options.headers);
      if (headers.has("authorization") || headers.has("dpop") || headers.has("cookie"))
        throw new TypeError("Authorization, DPoP, and Cookie headers are managed by Weldall");
      const method = (options.method ?? "GET").toUpperCase();
      headers.set("authorization", `DPoP ${downstream.access_token}`);
      headers.set(
        "dpop",
        await createBrowserDpopProof({
          privateKey: record.privateKey,
          publicJwk: record.publicJwk,
          method,
          url: target,
          accessToken: downstream.access_token,
        }),
      );
      const { scopes: _scopes, signal: _signal, ...requestInit } = options;
      return safeFetch(this.fetcher, target, {
        ...requestInit,
        method,
        headers,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    });
  }

  async disconnect(options: { signal?: AbortSignal } = {}): Promise<void> {
    await requireWeldallBrowserSupport();
    return this.withLock(async () => {
      let record = await this.readValidated();
      if (!record) return;
      if (!record.refreshToken || !record.connectionId) {
        await this.store.clear();
        return;
      }
      if (!accessTokenUsable(this.accessToken)) {
        try {
          record = await this.refresh(record, options.signal);
        } catch (error) {
          if (error instanceof WeldallBrowserError && error.code === "refresh-replay") return;
          throw error;
        }
      }
      const discovery = await this.discover();
      const proof = await createBrowserDpopProof({
        privateKey: record.privateKey,
        publicJwk: record.publicJwk,
        method: "POST",
        url: discovery.revoke,
        accessToken: this.accessToken!,
      });
      const response = await safeFetch(this.fetcher, discovery.revoke, {
        method: "POST",
        headers: { authorization: `DPoP ${this.accessToken}`, dpop: proof },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok && ![401, 403, 404, 410].includes(response.status))
        throw new WeldallBrowserError(
          "network",
          "Weldall could not revoke the browser connection.",
          "Retry; local credentials were preserved.",
        );
      await this.store.clear();
      this.accessToken = undefined;
      this.descriptor = undefined;
    });
  }

  async clearLocalConnection(): Promise<void> {
    await requireWeldallBrowserSupport();
    await this.withLock(async () => {
      await this.store.clear();
      this.accessToken = undefined;
      this.descriptor = undefined;
    });
  }
}
