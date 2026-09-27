import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@weldall/db";
import { googleProvider } from "../src/server/connectors/providers/google";
import { requiredScopes } from "../src/server/connectors/providers/google/setup";
import { seal } from "../src/server/auth/oidc-credentials";
import { encrypt } from "../src/server/connectors/encryption";
import { logger } from "../src/server/observability/logger";
import { writeConnectorAuditLog } from "../src/server/connectors/audit";
import { executeConnectionRequest } from "../src/server/connectors/core/execution";
import { RejectedProviderCredentials } from "../src/server/connectors/errors";
import {
  submitScopeSelection,
  completeConnection,
  accessCredentials,
  cancelAuthorizationAttempt,
  disconnectConnection,
} from "../src/server/connectors/core/connections";
import {
  saveConnectorConfiguration,
  listManagedConnectorConfiguration,
  deleteConnectorConfiguration,
} from "../src/server/connectors/configuration";

vi.mock("../src/server/policy/resources", () => ({
  effectiveScopesRequiringSystemScopeFor: vi.fn(async () => ["weldall:login"]),
}));
vi.mock("../src/server/connectors/audit", async (original) => ({
  ...(await original<typeof import("../src/server/connectors/audit")>()),
  writeConnectorAuditLog: vi.fn(async () => undefined),
}));

const actor = { id: "owner", email: "owner@example.com", requestId: "request", scopeKeys: [] };
const connectorId = randomUUID();
const scopes = [...requiredScopes, "https://www.googleapis.com/auth/gmail.readonly"].sort();
const selection = { scopes };
const credentials = {
  accessToken: "private-access",
  refreshToken: "private-refresh",
  expiresAt: Date.now() + 3_600_000,
  grantedScopes: scopes,
};
const grant = googleProvider.parseGrant(selection);
const config = {
  key: "google",
  name: "Google",
  type: "google",
  enabled: true,
  envelopeProvider: "OPENBAO",
  requiredScopes: [],
  provider: {
    clientId: "client",
    allowedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    defaultScopes: [],
  },
};
const state = "private-state";
// A bounded in-memory database double exercises the real lifecycle functions and real envelope code.
// Every remote call asserts that the serializable transaction callback is not active.
type Row = Record<string, any>;
let connector: Row;
let attempt: Row;
let connection: Row | null;
let envelopes: Map<string, Row>;
let inTransaction: boolean;
let outage: boolean;
let failWrap: number;
let wraps: number;
let race: (() => void) | undefined;
const fetcher = vi.fn<typeof fetch>();
const matches = (row: Row, where: Row) =>
  Object.entries(where).every(([key, value]) => {
    if (key === "ownerId_name") return matches(row, value);
    if (value && typeof value === "object" && "in" in value) return value.in.includes(row[key]);
    return row[key] === value;
  });
const update = (row: Row, data: Row) => {
  for (const [key, value] of Object.entries(data))
    row[key] =
      value && typeof value === "object" && "increment" in value
        ? row[key] + value.increment
        : value;
  return structuredClone(row);
};
const attemptRow = (include: Row = {}) =>
  structuredClone({
    ...attempt,
    ...(include.connector ? { connector } : {}),
    ...(include.owner ? { owner: { email: actor.email, emailVerified: true } } : {}),
  });
const connectionRow = () => (connection ? structuredClone({ ...connection, connector }) : null);

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("WELDALL_OPENBAO_HOST", "http://127.0.0.1:8200");
  vi.stubEnv("WELDALL_OPENBAO_TOKEN", "private-bao-token");
  vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 8).toString("base64"));
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.mocked(writeConnectorAuditLog).mockClear();
  connector = {
    id: connectorId,
    key: config.key,
    name: config.name,
    enabled: true,
    providerType: "google",
    providerConfig: config.provider,
    envelopeProvider: "OPENBAO",
    version: 1,
    requiredScopes: [],
    encryptedProviderSecrets: seal(
      "connector-provider-secrets",
      connectorId,
      JSON.stringify({ clientSecret: "private-client-secret" }),
    ),
  };
  attempt = {
    id: "attempt",
    ownerId: actor.id,
    connectorId,
    connectorVersion: 1,
    connectionId: null,
    connectionVersion: null,
    name: "mail",
    status: "SETUP",
    payloadId: null,
    stateHash: null,
    providerSelection: selection,
    expiresAt: new Date(Date.now() + 60_000),
  };
  connection = null;
  envelopes = new Map();
  inTransaction = false;
  outage = false;
  failWrap = 0;
  wraps = 0;
  race = undefined;
  const transit = new Map<string, { plaintext: string; associated_data: string }>();
  fetcher.mockReset().mockImplementation(async (url, init) => {
    expect(inTransaction, "Remote I/O must never run in a database transaction").toBe(false);
    if (String(url).startsWith("https://gmail.googleapis.com/"))
      return Response.json({ messages: [] });
    const body = JSON.parse(init!.body as string);
    if (outage) throw new Error("private-service-failure");
    if (String(url).includes("/encrypt/")) {
      wraps++;
      if (wraps === failWrap) return new Response("private-wrap-error", { status: 503 });
      const ciphertext = `vault:v1:${Buffer.alloc(60, wraps).toString("base64")}`;
      transit.set(ciphertext, body);
      race?.();
      race = undefined;
      return new Response(JSON.stringify({ data: { ciphertext } }));
    }
    const value = transit.get(body.ciphertext)!;
    expect(value.associated_data).toBe(body.associated_data);
    race?.();
    race = undefined;
    return new Response(JSON.stringify({ data: { plaintext: value.plaintext } }));
  });
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(db, "$transaction").mockImplementation((async (
    callback: (tx: typeof db) => Promise<unknown>,
  ) => {
    expect(inTransaction).toBe(false);
    const before = structuredClone({ connector, attempt, connection, envelopes });
    inTransaction = true;
    try {
      return await callback(db);
    } catch (error) {
      ({ connector, attempt, connection, envelopes } = before);
      throw error;
    } finally {
      inTransaction = false;
    }
  }) as never);
  vi.spyOn(db.connectionAuthorization, "findUnique").mockImplementation((async ({
    where,
    include,
  }: Row) => (matches(attempt, where) ? attemptRow(include) : null)) as never);
  vi.spyOn(db.connectionAuthorization, "findUniqueOrThrow").mockImplementation((async ({
    where,
    include,
  }: Row) => {
    expect(matches(attempt, where)).toBe(true);
    return attemptRow(include);
  }) as never);
  vi.spyOn(db.connectionAuthorization, "findMany").mockImplementation((async ({
    where,
    include,
  }: Row) => (matches(attempt, where) ? [attemptRow(include)] : [])) as never);
  vi.spyOn(db.connectionAuthorization, "update").mockImplementation((async ({
    where,
    data,
  }: Row) => {
    expect(matches(attempt, where)).toBe(true);
    return update(attempt, data);
  }) as never);
  vi.spyOn(db.connectionAuthorization, "updateMany").mockImplementation((async ({
    where,
    data,
  }: Row) => {
    const matched = matches(attempt, where);
    if (matched) update(attempt, data);
    return { count: Number(matched) };
  }) as never);
  vi.spyOn(db.connectionAuthorization, "deleteMany").mockResolvedValue({ count: 1 });
  vi.spyOn(db.connectionAuthorization, "count").mockResolvedValue(0);
  vi.spyOn(db.connection, "findFirst").mockImplementation((async ({ where }: Row) =>
    connection && matches(connection, where) ? connectionRow() : null) as never);
  vi.spyOn(db.connection, "findUnique").mockImplementation((async ({ where }: Row) =>
    connection && matches(connection, where) ? connectionRow() : null) as never);
  vi.spyOn(db.connection, "findUniqueOrThrow").mockImplementation((async ({ where }: Row) => {
    expect(connection && matches(connection, where)).toBeTruthy();
    return connectionRow();
  }) as never);
  vi.spyOn(db.connection, "create").mockImplementation((async ({ data }: Row) => {
    connection = {
      ...data,
      version: 1,
      status: "READY",
      credentialId: null,
      rateWindow: new Date(),
      rateCount: 0,
      requestCount: 0,
      lastUsedAt: null,
    };
    return structuredClone(connection);
  }) as never);
  vi.spyOn(db.connection, "update").mockImplementation((async ({ where, data }: Row) => {
    expect(connection && matches(connection, where)).toBeTruthy();
    return update(connection!, data);
  }) as never);
  vi.spyOn(db.connection, "updateMany").mockImplementation((async ({ where, data }: Row) => {
    const matched = connection && matches(connection, where);
    if (matched) update(connection!, data);
    return { count: Number(Boolean(matched)) };
  }) as never);
  vi.spyOn(db.connection, "findMany").mockResolvedValue([]);
  vi.spyOn(db.connection, "delete").mockImplementation((async () => {
    const old = connection;
    connection = null;
    return old;
  }) as never);
  vi.spyOn(db.connection, "deleteMany").mockResolvedValue({ count: 0 });
  vi.spyOn(db.encryptedValue, "create").mockImplementation((async ({ data }: Row) => {
    const row = { ...data, id: randomUUID() };
    envelopes.set(row.id, row);
    return structuredClone(row);
  }) as never);
  vi.spyOn(db.encryptedValue, "update").mockImplementation((async ({ where, data }: Row) => {
    const row = { ...data, id: where.id };
    envelopes.set(row.id, row);
    return structuredClone(row);
  }) as never);
  vi.spyOn(db.encryptedValue, "findFirstOrThrow").mockImplementation((async ({ where }: Row) => {
    expect(where.OR).toEqual([{ connection: { connectorId } }, { attempt: { connectorId } }]);
    expect(envelopes.has(where.id)).toBe(true);
    return structuredClone(envelopes.get(where.id));
  }) as never);
  vi.spyOn(db.encryptedValue, "delete").mockImplementation((async ({ where }: Row) => {
    const old = envelopes.get(where.id);
    envelopes.delete(where.id);
    return old;
  }) as never);
  vi.spyOn(db.encryptedValue, "deleteMany").mockImplementation((async ({ where }: Row) => {
    for (const id of where.id.in) envelopes.delete(id);
    return { count: where.id.in.length };
  }) as never);
  vi.spyOn(googleProvider, "beginAuthorization").mockResolvedValue({
    state,
    url: "https://accounts.google.com/consent",
    attempt: { nonce: "private-nonce", verifier: "private-verifier" },
  });
  vi.spyOn(googleProvider, "completeAuthorization").mockResolvedValue({
    accountId: "account",
    accountName: "account@example.com",
    credentials,
    grant,
  });
  vi.spyOn(googleProvider, "refreshCredentials").mockResolvedValue({
    credentials: { ...credentials, accessToken: "private-new-token" },
    grant,
  });
  vi.spyOn(googleProvider, "disconnectGrant").mockResolvedValue({ status: "revoked" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const setup = () => submitScopeSelection({ actor, id: attempt.id, selection });
const complete = () =>
  completeConnection({ browser: actor, state, code: "code", cancelled: false });
const execute = () =>
  executeConnectionRequest({
    actor,
    connectorKey: connector.key,
    request: new Request(`https://weldall.example.com/connectors/${connector.key}`, {
      headers: {
        "x-weldall-connection": connection!.id,
        "x-weldall-upstream-url": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      },
    }),
  });
async function ready(expired = false) {
  await setup();
  await complete();
  if (expired) {
    const envelope = await encrypt({
      provider: "OPENBAO",
      connectorId,
      context: `connection:${connection!.id}:credentials`,
      plaintext: JSON.stringify({ ...credentials, expiresAt: 0 }),
    });
    envelopes.set(connection!.credentialId, { ...envelope, id: connection!.credentialId });
  }
  fetcher.mockClear();
}

describe("OpenBao lifecycle transaction boundaries", () => {
  it("keeps failed setup retryable and persists only ciphertext after recovery", async () => {
    outage = true;
    await expect(setup()).rejects.toMatchObject({ status: 503 });
    expect(attempt.status).toBe("SETUP");
    expect(envelopes.size).toBe(0);
    expect(db.$transaction).not.toHaveBeenCalled();
    outage = false;
    await expect(setup()).resolves.toMatchObject({ url: "https://accounts.google.com/consent" });
    expect(attempt.status).toBe("AUTHORIZING");
    expect(attempt.stateHash).toBe(createHash("sha256").update(state).digest("hex"));
    expect(JSON.stringify([...envelopes.values()])).not.toContain("private-");
  });
  it.each(["version", "expiry", "owner", "status", "policy"])(
    "revalidates %s after preparing attempt ciphertext",
    async (change) => {
      race = () => {
        if (change === "version") connector.version++;
        if (change === "expiry") attempt.expiresAt = new Date(0);
        if (change === "owner") attempt.ownerId = "someone-else";
        if (change === "status") attempt.status = "CANCELLED";
        if (change === "policy") connector.requiredScopes = [{ scope: { key: "mail:read" } }];
      };
      await expect(setup()).rejects.toThrow();
      expect(envelopes.size).toBe(0);
    },
  );
  it("does not claim or exchange an OAuth code when unwrap is unavailable", async () => {
    await setup();
    outage = true;
    await expect(complete()).rejects.toMatchObject({ status: 503 });
    expect(attempt.status).toBe("AUTHORIZING");
    expect(googleProvider.completeAuthorization).not.toHaveBeenCalled();
    outage = false;
    await expect(complete()).resolves.toBe("success");
  });
  it.each(["expiry", "owner", "version", "status"])(
    "rechecks callback %s after unwrap before claiming state",
    async (change) => {
      await setup();
      race = () => {
        if (change === "expiry") attempt.expiresAt = new Date(0);
        if (change === "owner") attempt.ownerId = "someone-else";
        if (change === "version") connector.version++;
        if (change === "status") attempt.status = "CANCELLED";
      };
      await expect(complete()).rejects.toThrow();
      expect(googleProvider.completeAuthorization).not.toHaveBeenCalled();
      expect(connection).toBeNull();
    },
  );
  it.each(["retention", "final", "rejected", "revocation-failed"])(
    "revokes issued credentials on a post-OAuth %s wrapping failure",
    async (phase) => {
      await setup();
      failWrap = wraps + (phase === "final" ? 2 : 1);
      if (phase === "rejected")
        vi.mocked(googleProvider.completeAuthorization).mockRejectedValueOnce(
          new RejectedProviderCredentials({ reason: "identity_unverified", credentials }),
        );
      if (phase === "revocation-failed")
        vi.mocked(googleProvider.disconnectGrant).mockRejectedValueOnce(
          new Error("private-revocation-error"),
        );
      await expect(complete()).rejects.toMatchObject({ status: 503 });
      expect(googleProvider.disconnectGrant).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ credentials }),
      );
      expect(attempt.status).toBe("FAILED");
      expect(attempt.payloadId).toBeNull();
      expect(connection).toBeNull();
      expect(envelopes.size).toBe(0);
      const diagnostics = JSON.stringify({
        logs: vi.mocked(logger.error).mock.calls,
        audits: vi
          .mocked(writeConnectorAuditLog)
          .mock.calls.map(([input]) => ({ operation: input.operation, outcome: input.outcome })),
      });
      expect(diagnostics).not.toContain("private-");
    },
  );
  it.each(["unconfirmed", "throws"])(
    "preserves retained credentials after final wrapping failure when revocation %s",
    async (outcome) => {
      await setup();
      const payloadId = attempt.payloadId;
      failWrap = wraps + 2;
      if (outcome === "throws")
        vi.mocked(googleProvider.disconnectGrant).mockRejectedValueOnce(
          new Error("private-revocation-error"),
        );
      else
        vi.mocked(googleProvider.disconnectGrant).mockResolvedValueOnce({
          status: "unconfirmed",
          remediationUrl: "https://myaccount.google.com/permissions",
        });

      await expect(complete()).rejects.toMatchObject({ status: 503 });
      expect(attempt).toMatchObject({ status: "NEEDS_REVOCATION", payloadId, stateHash: null });
      expect(connection).toBeNull();
      expect(envelopes.size).toBe(1);
      expect(JSON.stringify([...envelopes.values()])).not.toContain("private-");
      expect(writeConnectorAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "authorization.revocation_unconfirmed",
          outcome: "failed",
        }),
      );

      await cancelAuthorizationAttempt({ actor, id: attempt.id });
      expect(googleProvider.disconnectGrant).toHaveBeenCalledTimes(2);
      expect(googleProvider.disconnectGrant).toHaveBeenLastCalledWith(
        expect.objectContaining({ credentials }),
      );
      expect(attempt.status).toBe("CANCELLED");
      expect(attempt.payloadId).toBeNull();
      expect(envelopes.size).toBe(0);
    },
  );
  it.each([false, true])(
    "rejects repeated over-quota requests before decrypting or refreshing (expired: %s)",
    async (expired) => {
      await ready(expired);
      connection!.rateCount = 60;
      const before = structuredClone(connection);
      for (let i = 0; i < 3; i++)
        await expect(execute()).rejects.toMatchObject({
          code: "rate_limit",
          status: 429,
          message: "Weldall connection request limit exceeded. Retry next minute.",
        });
      expect(fetcher).not.toHaveBeenCalled();
      expect(googleProvider.refreshCredentials).not.toHaveBeenCalled();
      expect(connection).toEqual(before);
    },
  );
  it("consumes quota even when OpenBao fails, without recording a dispatched request", async () => {
    await ready(true);
    connection!.rateCount = 59;
    outage = true;
    await expect(execute()).rejects.toMatchObject({ status: 503 });
    expect(connection).toMatchObject({ rateCount: 60, requestCount: 0, lastUsedAt: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    await expect(execute()).rejects.toMatchObject({ code: "rate_limit", status: 429 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(googleProvider.refreshCredentials).not.toHaveBeenCalled();
  });
  it("charges successful dispatches once and resets the quota after a minute", async () => {
    await ready();
    connection!.rateCount = 59;
    expect((await execute()).status).toBe(200);
    expect(connection).toMatchObject({ rateCount: 60, requestCount: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2); // unwrap and upstream dispatch
    fetcher.mockClear();
    await expect(execute()).rejects.toMatchObject({ code: "rate_limit", status: 429 });
    expect(fetcher).not.toHaveBeenCalled();

    connection!.rateWindow = new Date(Date.now() - 60_001);
    const expiredWindow = connection!.rateWindow;
    expect((await execute()).status).toBe(200);
    expect(connection).toMatchObject({ rateCount: 1, requestCount: 2 });
    expect(connection!.rateWindow.getTime()).toBeGreaterThan(expiredWindow.getTime());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("still rechecks policy before dispatch after reserving quota", async () => {
    await ready();
    vi.spyOn(googleProvider, "ensureGrantCurrent").mockImplementationOnce(async () => {
      connector.enabled = false;
      connector.version++;
      return grant;
    });
    await expect(execute()).rejects.toMatchObject({ code: "connection_denied", status: 403 });
    expect(connection).toMatchObject({ rateCount: 1, requestCount: 0, lastUsedAt: null });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("/v1/transit/decrypt/"),
      expect.anything(),
    );
  });
  it("finishes callback, execution reads, refresh and revocation with no Transit I/O in a transaction", async () => {
    await ready(true);
    await expect(accessCredentials({ actor, selector: connection!.id })).resolves.toMatchObject({
      credentials: { accessToken: "private-new-token" },
      row: { status: "READY" },
    });
    expect(fetcher).toHaveBeenCalledTimes(2); // one read, one pre-refresh wrap
    fetcher.mockClear();
    await accessCredentials({ actor, selector: connection!.id });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    await expect(disconnectConnection({ actor, selector: connection!.id })).resolves.toMatchObject({
      status: "DISCONNECTED",
      revocationConfirmed: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(connection).toBeNull();
  });
  it.each(["read", "refresh-wrap"])(
    "fails %s before claiming refresh, preserving retryability",
    async (phase) => {
      await ready(true);
      const before = structuredClone(connection);
      if (phase === "read") outage = true;
      else failWrap = wraps + 1;
      await expect(accessCredentials({ actor, selector: connection!.id })).rejects.toMatchObject({
        status: 503,
      });
      expect(connection).toEqual(before);
      expect(googleProvider.refreshCredentials).not.toHaveBeenCalled();
      outage = false;
      failWrap = 0;
      await expect(accessCredentials({ actor, selector: connection!.id })).resolves.toMatchObject({
        row: { status: "READY" },
      });
    },
  );
  it("discards decrypted execution credentials when ownership or policy changes during unwrap", async () => {
    await ready();
    race = () => {
      connector.version++;
      connector.enabled = false;
    };
    await expect(accessCredentials({ actor, selector: connection!.id })).rejects.toThrow();
    expect(googleProvider.refreshCredentials).not.toHaveBeenCalled();
  });
  it("does not start an unprepared refresh when the expiry threshold advances during revalidation", async () => {
    await ready();
    const needsRefresh = vi
      .spyOn(googleProvider, "needsRefresh")
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    await expect(accessCredentials({ actor, selector: connection!.id })).resolves.toMatchObject({
      refresh: false,
    });
    expect(needsRefresh).toHaveBeenCalledTimes(1);
    expect(googleProvider.refreshCredentials).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves LOCAL_ENV best-effort disconnect when the deployment key is lost", async () => {
    connector.envelopeProvider = "LOCAL_ENV";
    vi.stubEnv("WELDALL_CONNECTOR_KEK", Buffer.alloc(32, 1).toString("base64"));
    await ready();
    vi.stubEnv("WELDALL_CONNECTOR_KEK", undefined);
    await expect(disconnectConnection({ actor, selector: connection!.id })).resolves.toMatchObject({
      status: "DISCONNECTED",
      revocationConfirmed: false,
    });
    expect(connection).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not invalidate a credential read when only concurrent usage counters change", async () => {
    await ready();
    race = () => {
      connection!.requestCount = 10;
      connection!.lastUsedAt = new Date();
    };
    await expect(accessCredentials({ actor, selector: connection!.id })).resolves.toMatchObject({
      credentials,
    });
  });
  it("does not partially block or delete a connection when revocation unwrap fails", async () => {
    await ready();
    outage = true;
    const before = structuredClone(connection);
    await expect(disconnectConnection({ actor, selector: connection!.id })).rejects.toMatchObject({
      status: 503,
    });
    expect(connection).toEqual(before);
    expect(envelopes.size).toBe(1);
    expect(googleProvider.disconnectGrant).not.toHaveBeenCalled();
  });
  it("leaves retained callback credentials retryable when cancellation unwrap fails", async () => {
    await setup();
    vi.mocked(googleProvider.completeAuthorization).mockRejectedValueOnce(
      new RejectedProviderCredentials({ reason: "identity_unverified", credentials }),
    );
    await expect(complete()).resolves.toBe("failed");
    expect(attempt.status).toBe("NEEDS_REVOCATION");
    outage = true;
    await expect(cancelAuthorizationAttempt({ actor, id: attempt.id })).rejects.toMatchObject({
      status: 503,
    });
    expect(attempt.status).toBe("NEEDS_REVOCATION");
    outage = false;
    await cancelAuthorizationAttempt({ actor, id: attempt.id });
    expect(attempt.status).toBe("CANCELLED");
    expect(envelopes.size).toBe(0);
  });
});

describe("OpenBao configuration without deployment variables", () => {
  it("creates, enables, reads, updates and deletes definitions without OpenBao requests", async () => {
    vi.stubEnv("WELDALL_OPENBAO_HOST", undefined);
    vi.stubEnv("WELDALL_OPENBAO_TOKEN", undefined);
    vi.spyOn(db.connector, "create").mockImplementation((async ({ data }: Row) => {
      connector = { ...data, version: 1, requiredScopes: [] };
      return structuredClone(connector);
    }) as never);
    vi.spyOn(db.connector, "findUniqueOrThrow").mockImplementation((async () =>
      structuredClone(connector)) as never);
    vi.spyOn(db.connector, "findMany").mockImplementation((async () => [
      structuredClone(connector),
    ]) as never);
    vi.spyOn(db.connector, "update").mockImplementation((async ({ data }: Row) => {
      update(connector, data);
      connector.requiredScopes = [];
      return structuredClone(connector);
    }) as never);
    vi.spyOn(db.connector, "delete").mockResolvedValue(connector as never);
    await saveConnectorConfiguration({
      tx: db,
      value: { ...config, enabled: false },
      id: undefined,
      expectedVersion: null,
      actor,
      providerSecrets: { clientSecret: "private-client-secret" },
    });
    await saveConnectorConfiguration({
      tx: db,
      value: config,
      id: connector.id,
      expectedVersion: 1,
      actor,
    });
    const listed = await listManagedConnectorConfiguration();
    expect(listed.connectors[0]?.config.envelopeProvider).toBe("OPENBAO");
    await saveConnectorConfiguration({
      tx: db,
      value: { ...config, name: "Renamed" },
      id: connector.id,
      expectedVersion: 2,
      actor,
    });
    await deleteConnectorConfiguration({ tx: db, id: connector.id, version: 3, actor });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
