import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, ensureSystemScopes, IAC_SCOPE_KEY } from "@weldall/db";
import { calculateJwkThumbprint } from "jose";
import { generateEs256KeyPair } from "@weldall/sdk";
import {
  applyIac,
  planIac,
  importIac,
  unmanageIac,
  moveIacState,
  getIacState,
} from "../src/server/iac/service";
import { digest } from "../src/server/iac/contracts";
import { executeConnectionRequest } from "../src/server/connectors/core/execution";
import {
  saveConnectorConfiguration,
  runConnectorTransaction as transaction,
  saveConnectorSecrets,
  readConnectorSecrets,
  listManagedConnectorConfiguration as listConfiguration,
} from "../src/server/connectors/configuration";
import { decrypt, saveSecret } from "../src/server/connectors/encryption";
import {
  accessCredentials,
  completeConnection,
  disconnectConnection,
  disconnectAndDeleteConnection,
  getAuthorizationAttempt,
  listConnections,
  listConnectors,
  getConnectionDetails,
  findOwnedConnection,
  startConnection,
  submitScopeSelection,
} from "../src/server/connectors/core/connections";
import {
  completeGoogleAuthorization as completeGoogle,
  refreshGoogleCredentials as refreshGoogle,
  revokeGoogleAuthorization as revokeGoogle,
} from "../src/server/connectors/providers/google/oauth";
import { googleProvider } from "../src/server/connectors/providers/google";
import { requiredScopes } from "../src/server/connectors/providers/google/setup";
import { createPostgresReplayStore } from "../src/server/oauth/replay";
import { parseDesiredState } from "../src/server/iac/contracts";
import { createPlan, loadPlanningState } from "../src/server/iac/planner";
import { scopeKeySchema } from "../src/server/policy/scope-key";
import { mutateScope } from "../src/server/domain/primitive-mutations";

vi.mock("../src/server/connectors/providers/google/oauth", async (original) => ({
  ...(await original<typeof import("../src/server/connectors/providers/google/oauth")>()),
  completeGoogleAuthorization: vi.fn(),
  refreshGoogleCredentials: vi.fn(),
  revokeGoogleAuthorization: vi.fn(),
}));
const target = "postgresql://postgres@localhost:5433/postgres";
// Use the operator-approved local database or CI's existing disposable test service; never reset either here.
const approvedTarget =
  process.env.POSTGRES_URL === target ||
  /^postgresql:\/\/postgres@localhost:5433\/weldall_connector_test_[a-f0-9]{32}$/.test(
    process.env.POSTGRES_URL ?? "",
  ) ||
  (process.env.CI === "true" &&
    process.env.POSTGRES_URL === "postgresql://postgres:postgres@localhost:5432/postgres");
const prefix = `managed-${randomUUID()}`;
const actor = { id: prefix, requestId: prefix, email: `${prefix}@example.com`, scopeKeys: [] };
const read = "https://www.googleapis.com/auth/gmail.readonly",
  calendar = "https://www.googleapis.com/auth/calendar.readonly";
const selected = [...requiredScopes, calendar];
const config = (key: string) => ({
  key,
  name: "Google",
  type: "google" as const,
  enabled: false,
  envelopeProvider: "LOCAL_ENV" as const,
  requiredScopes: [],
  provider: {
    clientId: "test.apps.googleusercontent.com",
    allowedScopes: [read, calendar].sort(),
    defaultScopes: [calendar],
  },
});
const credentials = () => ({
  accessToken: "never-public-access",
  refreshToken: "never-public-refresh",
  expiresAt: Date.now() + 3600000,
  grantedScopes: selected,
});
let n = 0;
/** Creates an enabled connector fixture through production mutation paths. */
async function fixture() {
  const key = `${prefix}-${++n}`;
  let connector = await transaction((tx) =>
    saveConnectorConfiguration({
      tx,
      value: config(key),
      id: undefined,
      expectedVersion: null,
      actor,
    }),
  );
  await saveConnectorSecrets({
    id: connector.id,
    secrets: { clientSecret: "never-public-client-secret" },
    expectedVersion: connector.version,
    actor,
  });
  connector = await transaction((tx) =>
    saveConnectorConfiguration({
      tx,
      value: { ...config(key), enabled: true },
      id: connector.id,
      expectedVersion: 2,
      actor,
    }),
  );
  return { key, connector };
}
/** Starts and advances one test authorization to the provider callback boundary. */
async function authorize({
  key,
  name,
  reconnect,
}: {
  key: string;
  name: string;
  reconnect?: string;
}) {
  const attempt = await startConnection({
    actor,
    input: {
      connector: key,
      name,
      ...(reconnect ? { reconnect } : {}),
    },
  });
  const { url } = await submitScopeSelection({
    actor,
    id: attempt.id,
    selection: { scopes: selected },
  });
  return { attempt, state: new URL(url).searchParams.get("state")! };
}
/** Creates a ready connection fixture with encrypted provider credentials. */
async function ready() {
  const f = await fixture();
  const { attempt, state } = await authorize({ key: f.key, name: f.key });
  vi.mocked(completeGoogle).mockResolvedValueOnce({
    accountId: "google-account",
    accountName: "google@example.com",
    credentials: credentials(),
  });
  expect(await completeConnection({ state, code: "code", cancelled: false })).toBe("success");
  const result = await getAuthorizationAttempt({ actor, id: attempt.id });
  return { ...f, id: result.connection!.id, attempt };
}

describe.skipIf(!approvedTarget)(
  "managed connections on explicitly selected disposable PostgreSQL",
  () => {
    beforeAll(async () => {
      if (!approvedTarget) throw new Error("Unsafe database target");
      vi.stubEnv("WELDALL_CONNECTOR_KEK", randomBytes(32).toString("base64"));
      vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
      await ensureSystemScopes(db, actor.id);
      const loginScope = await db.scope.findUniqueOrThrow({ where: { key: "weldall:login" } });
      await db.user.create({
        data: { id: actor.id, name: "Test", email: actor.email, emailVerified: true },
      });
      await db.emailScopeAssignment.create({
        data: {
          normalizedEmail: actor.email,
          createdBy: actor.id,
          updatedBy: actor.id,
          grants: { create: { scopeId: loginScope.id, createdBy: actor.id } },
        },
      });
    });
    afterEach(() => {
      vi.clearAllMocks();
      vi.unstubAllGlobals();
    });
    afterAll(async () => {
      const connectors = await db.connector.findMany({
        where: { key: { startsWith: prefix } },
        select: { id: true },
      });
      const ids = connectors.map((c) => c.id);
      const values = await db.encryptedValue.findMany({
        where: { OR: [{ connection: { ownerId: actor.id } }, { attempt: { ownerId: actor.id } }] },
        select: { id: true },
      });
      await db.connectionAuthorization.deleteMany({ where: { ownerId: actor.id } });
      await db.connection.deleteMany({ where: { ownerId: actor.id } });
      await db.iacObjectBinding.deleteMany({
        where: {
          connectorId: { in: ids },
        },
      });
      await db.connector.deleteMany({ where: { id: { in: ids } } });
      await db.scope.deleteMany({ where: { key: { startsWith: prefix } } });
      await db.encryptedValue.deleteMany({
        where: { id: { in: values.map(({ id }) => id) } },
      });
      await db.iacWorkspace.deleteMany({ where: { name: { startsWith: prefix } } });
      await db.machineClient.deleteMany({ where: { clientId: { startsWith: prefix } } });
      await db.emailScopeAssignment.deleteMany({
        where: { normalizedEmail: { startsWith: prefix } },
      });
      await db.user.delete({ where: { id: actor.id } });
      await db.auditEvent.deleteMany({ where: { actorId: actor.id } });
      await db.replayMarker.deleteMany({ where: { key: { startsWith: prefix } } });
      vi.unstubAllEnvs();
    });
    it("requires all configured Weldall scopes for discovery and connection setup", async () => {
      const scopeKey = scopeKeySchema.parse(`${prefix}:connector-use`);
      await db.scope.create({
        data: {
          key: scopeKey,
          description: "Use the managed connector",
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      });
      const f = await fixture();
      const connector = await transaction((tx) =>
        saveConnectorConfiguration({
          tx,
          value: { ...config(f.key), enabled: true, requiredScopes: [scopeKey] },
          id: f.connector.id,
          expectedVersion: f.connector.version,
          actor,
        }),
      );
      await expect(
        startConnection({ actor, input: { connector: f.key, name: `${f.key}-denied` } }),
      ).rejects.toMatchObject({ code: "connection_denied", status: 403 });
      expect((await listConnectors(actor)).some(({ key }) => key === f.key)).toBe(false);

      const authorizedActor = { ...actor, scopeKeys: [scopeKey] };
      const attempt = await startConnection({
        actor: authorizedActor,
        input: { connector: f.key, name: `${f.key}-allowed` },
      });
      expect(
        (await listConnectors(authorizedActor)).find(({ key }) => key === f.key),
      ).toMatchObject({
        requiredScopes: [scopeKey],
      });
      expect(connector.requiredScopes.map(({ scope }) => scope.key)).toEqual([scopeKey]);
      const scope = await db.scope.findUniqueOrThrow({ where: { key: scopeKey } });
      const { url } = await submitScopeSelection({
        actor: authorizedActor,
        id: attempt.id,
        selection: { scopes: selected },
      });
      const state = new URL(url).searchParams.get("state")!;
      await expect(completeConnection({ state, code: "code", cancelled: false })).rejects.toThrow(
        "not available",
      );
      expect(completeGoogle).not.toHaveBeenCalled();
      const assignment = await db.emailScopeAssignment.findUniqueOrThrow({
        where: { normalizedEmail: actor.email },
      });
      await db.emailScopeGrant.create({
        data: {
          assignmentId: assignment.id,
          scopeId: scope.id,
          createdBy: actor.id,
        },
      });
      vi.mocked(completeGoogle).mockResolvedValueOnce({
        accountId: "scope-authorized-account",
        accountName: "scope-authorized@example.com",
        credentials: credentials(),
      });
      expect(await completeConnection({ state, code: "code", cancelled: false })).toBe("success");
      await db.emailScopeGrant.delete({
        where: { assignmentId_scopeId: { assignmentId: assignment.id, scopeId: scope.id } },
      });
      await expect(
        db.$transaction((tx) =>
          mutateScope({
            tx,
            input: { action: "delete", id: scope.id, expectedVersion: scope.version },
            actor: {
              type: "user",
              id: actor.id,
              email: actor.email,
              requestId: actor.requestId,
              source: "admin_api",
            },
          }),
        ),
      ).rejects.toThrow(`required by connector ${f.key}`);
    });

    it("requires live login permission at callback before provider exchange", async () => {
      const f = await fixture();
      const { state } = await authorize({ key: f.key, name: `${f.key}-login-revoked` });
      const loginScope = await db.scope.findUniqueOrThrow({ where: { key: "weldall:login" } });
      const assignment = await db.emailScopeAssignment.findUniqueOrThrow({
        where: { normalizedEmail: actor.email },
      });
      await db.emailScopeGrant.delete({
        where: { assignmentId_scopeId: { assignmentId: assignment.id, scopeId: loginScope.id } },
      });
      try {
        await expect(
          completeConnection({ state, code: "code", cancelled: false }),
        ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
        expect(completeGoogle).not.toHaveBeenCalled();
      } finally {
        await db.emailScopeGrant.upsert({
          where: {
            assignmentId_scopeId: { assignmentId: assignment.id, scopeId: loginScope.id },
          },
          create: { assignmentId: assignment.id, scopeId: loginScope.id, createdBy: actor.id },
          update: {},
        });
      }
    });

    it("stores LOCAL_ENV and keeps client secrets in fixed application encryption", async () => {
      const f = await fixture();
      expect(f.connector.envelopeProvider).toBe("LOCAL_ENV");
      expect(readConnectorSecrets(f.connector)).toEqual({
        clientSecret: "never-public-client-secret",
      });
      const original = process.env.WELDALL_CONNECTOR_KEK!;
      try {
        delete process.env.WELDALL_CONNECTOR_KEK;
        expect(readConnectorSecrets(f.connector)).toEqual({
          clientSecret: "never-public-client-secret",
        });
      } finally {
        process.env.WELDALL_CONNECTOR_KEK = original;
      }
      await expect(
        transaction((tx) =>
          saveConnectorConfiguration({
            tx,
            value: { ...config(f.key), envelopeProvider: "OPENBAO" },
            id: f.connector.id,
            expectedVersion: f.connector.version,
            actor,
          }),
        ),
      ).rejects.toThrow();
      expect(
        (await db.connector.findUniqueOrThrow({ where: { id: f.connector.id } })).envelopeProvider,
      ).toBe("LOCAL_ENV");
    });
    it("creates an enabled connector with its write-only secret in one save", async () => {
      const key = `${prefix}-${++n}`;
      const connector = await transaction((tx) =>
        saveConnectorConfiguration({
          tx,
          value: { ...config(key), enabled: true },
          id: undefined,
          expectedVersion: null,
          actor,
          providerSecrets: { clientSecret: "new-client-secret" },
        }),
      );
      expect(connector.enabled).toBe(true);
      expect(readConnectorSecrets(connector)).toEqual({ clientSecret: "new-client-secret" });
      const publicRow = (await listConfiguration()).connectors.find(
        (row) => row.id === connector.id,
      );
      expect(publicRow?.secretConfigured).toBe(true);
      expect(JSON.stringify(publicRow)).not.toMatch(/new-client-secret|encryptedClientSecret/);
      const audit = await db.auditEvent.findMany({ where: { subjectId: connector.id } });
      expect(JSON.stringify(audit)).not.toContain("new-client-secret");
    });
    it("preserves an omitted secret and replaces it even when configuration is unchanged", async () => {
      const f = await fixture();
      const value = { ...config(f.key), enabled: true, name: "Renamed" };
      const renamed = await transaction((tx) =>
        saveConnectorConfiguration({
          tx,
          value,
          id: f.connector.id,
          expectedVersion: f.connector.version,
          actor,
        }),
      );
      expect(renamed.encryptedProviderSecrets).toBe(f.connector.encryptedProviderSecrets);
      const replaced = await transaction((tx) =>
        saveConnectorConfiguration({
          tx,
          value,
          id: renamed.id,
          expectedVersion: renamed.version,
          actor,
          providerSecrets: { clientSecret: "replacement-secret" },
        }),
      );
      expect(readConnectorSecrets(replaced)).toEqual({ clientSecret: "replacement-secret" });
      expect(replaced.version).toBe(renamed.version + 1);
      await expect(
        transaction((tx) =>
          saveConnectorConfiguration({
            tx,
            value,
            id: renamed.id,
            expectedVersion: renamed.version,
            actor,
            providerSecrets: { clientSecret: "stale-secret" },
          }),
        ),
      ).rejects.toThrow("Configuration changed");
      expect(
        readConnectorSecrets(await db.connector.findUniqueOrThrow({ where: { id: renamed.id } })),
      ).toEqual({ clientSecret: "replacement-secret" });
    });
    it("can save a replacement client ID and secret together without disabling an unused connector", async () => {
      const f = await fixture();
      const changed = await transaction((tx) =>
        saveConnectorConfiguration({
          tx,
          value: {
            ...config(f.key),
            provider: {
              ...config(f.key).provider,
              clientId: "replacement.apps.googleusercontent.com",
            },
            enabled: true,
          },
          id: f.connector.id,
          expectedVersion: f.connector.version,
          actor,
          providerSecrets: { clientSecret: "replacement-client-secret" },
        }),
      );
      expect(changed.enabled).toBe(true);
      expect(changed.providerConfig).toMatchObject({
        clientId: "replacement.apps.googleusercontent.com",
      });
      expect(readConnectorSecrets(changed)).toEqual({ clientSecret: "replacement-client-secret" });
    });
    it("does not partially save configuration when the submitted secret is invalid or encryption fails", async () => {
      const f = await fixture();
      await expect(
        transaction((tx) =>
          saveConnectorConfiguration({
            tx,
            value: { ...config(f.key), name: "Must not persist" },
            id: f.connector.id,
            expectedVersion: f.connector.version,
            actor,
            providerSecrets: { clientSecret: "   " },
          }),
        ),
      ).rejects.toThrow();
      expect(
        await db.connector.findUniqueOrThrow({
          where: { id: f.connector.id },
          include: { requiredScopes: { include: { scope: { select: { key: true } } } } },
        }),
      ).toEqual(f.connector);
      const key = `${prefix}-${++n}`;
      const original = process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY!;
      try {
        delete process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY;
        await expect(
          transaction((tx) =>
            saveConnectorConfiguration({
              tx,
              value: { ...config(key), enabled: true },
              id: undefined,
              expectedVersion: null,
              actor,
              providerSecrets: { clientSecret: "never-saved-secret" },
            }),
          ),
        ).rejects.toThrow("Application encryption is unavailable");
        expect(await db.connector.findUnique({ where: { key } })).toBeNull();
      } finally {
        process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY = original;
      }
    });
    it("de-provisions stale client secrets when the OAuth client changes", async () => {
      const f = await fixture();
      await expect(
        transaction((tx) =>
          saveConnectorConfiguration({
            tx,
            value: {
              ...config(f.key),
              enabled: true,
              provider: {
                ...config(f.key).provider,
                clientId: "replacement.apps.googleusercontent.com",
              },
            },
            id: f.connector.id,
            expectedVersion: f.connector.version,
            actor,
          }),
        ),
      ).rejects.toThrow("new OAuth client secret");
      const changed = await transaction((tx) =>
        saveConnectorConfiguration({
          tx,
          value: {
            ...config(f.key),
            provider: {
              ...config(f.key).provider,
              clientId: "replacement.apps.googleusercontent.com",
            },
          },
          id: f.connector.id,
          expectedVersion: f.connector.version,
          actor,
        }),
      );
      expect(changed.encryptedProviderSecrets).toBeNull();
    });
    it("checks ownership before secret decryption", async () => {
      const f = await ready();
      const original = process.env.WELDALL_CONNECTOR_KEK!;
      try {
        delete process.env.WELDALL_CONNECTOR_KEK;
        await expect(
          accessCredentials({ actor: { ...actor, id: "different-user" }, selector: f.id }),
        ).rejects.toThrow("not found");
        await expect(accessCredentials({ actor, selector: f.id })).rejects.toThrow("unavailable");
      } finally {
        process.env.WELDALL_CONNECTOR_KEK = original;
      }
    });
    it("loads credential-free connection details even when the connection is outside the recent overview", async () => {
      const f = await ready();
      await db.connection.update({
        where: { id: f.id },
        data: { createdAt: new Date("2000-01-01T00:00:00Z") },
      });
      await db.connection.createMany({
        data: Array.from({ length: 201 }, (_, i) => ({
          ownerId: actor.id,
          connectorId: f.connector.id,
          name: `${f.key}-recent-${i}`,
          accountId: `account-${i}`,
          accountName: `account-${i}@example.com`,
          providerSelection: { scopes: selected },
          providerGrant: { scopes: selected },
          status: "RECONNECT_REQUIRED" as const,
        })),
      });
      const overview = await listConnections();
      expect(overview).toHaveLength(200);
      expect(overview.some((row) => row.id === f.id)).toBe(false);
      const details = await getConnectionDetails(f.id);
      expect(details).toMatchObject({
        id: f.id,
        connectorKey: f.key,
        ownerId: actor.id,
        owner: { email: actor.email },
      });
      expect(details.selectedScopes).toEqual([...selected].sort());
      expect(JSON.stringify(details)).not.toMatch(
        /never-public|credentialId|ciphertext|encryptedClientSecret|wrappedDek/,
      );
      await expect(getConnectionDetails(randomUUID())).rejects.toMatchObject({
        code: "not_found",
        status: 404,
      });
    });
    it("binds selections to configuration versions and never returns credentials", async () => {
      const f = await ready();
      await expect(
        findOwnedConnection({ tx: db, selector: f.id, actor: { ...actor, id: "different-user" } }),
      ).rejects.toThrow("not found");
      await expect(
        getAuthorizationAttempt({ actor: { ...actor, id: "different-user" }, id: f.attempt.id }),
      ).rejects.toThrow("not found");
      expect(JSON.stringify(await listConnections(actor))).not.toMatch(
        /never-public|credentialId|ciphertext|encryptedClientSecret|wrappedDek/,
      );
      expect(JSON.stringify(await listConfiguration())).not.toMatch(
        /never-public|ciphertext|fingerprint/,
      );
      const a = await startConnection({
        actor,
        input: { connector: f.key, name: `${f.key}-new` },
      });
      await transaction((tx) =>
        saveConnectorConfiguration({
          tx,
          value: {
            ...config(f.key),
            enabled: true,
            provider: { ...config(f.key).provider, allowedScopes: [read], defaultScopes: [] },
          },
          id: f.connector.id,
          expectedVersion: f.connector.version,
          actor,
        }),
      );
      await expect(
        submitScopeSelection({ actor, id: a.id, selection: { scopes: selected } }),
      ).rejects.toThrow("configuration changed");
    });
    it.each(["reduced", "expanded", "alias"])(
      "retains %s callback credentials only for revocation",
      async (mode) => {
        const f = await fixture();
        const { state, attempt } = await authorize({ key: f.key, name: f.key });
        const scopes =
          mode === "reduced"
            ? requiredScopes
            : mode === "expanded"
              ? [...selected, read]
              : selected.map((scope) =>
                  scope === "https://www.googleapis.com/auth/userinfo.email" ? "email" : scope,
                );
        vi.mocked(completeGoogle).mockResolvedValueOnce({
          accountId: "account",
          accountName: "account@example.com",
          credentials: { ...credentials(), grantedScopes: scopes },
        });
        expect(await completeConnection({ state, code: "code", cancelled: false })).toBe("failed");
        expect((await getAuthorizationAttempt({ actor, id: attempt.id })).status).toBe(
          "NEEDS_REVOCATION",
        );
        expect(
          await db.connection.findFirst({ where: { connectorId: f.connector.id } }),
        ).toBeNull();
      },
    );
    it("keeps stable identity on reconnect and rejects replay or account switching", async () => {
      const f = await ready();
      const next = await authorize({ key: f.key, name: f.key, reconnect: f.id });
      vi.mocked(completeGoogle).mockResolvedValueOnce({
        accountId: "other-account",
        accountName: "other@example.com",
        credentials: credentials(),
      });
      expect(await completeConnection({ state: next.state, code: "code", cancelled: false })).toBe(
        "failed",
      );
      expect((await db.connection.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("READY");
      expect((await getAuthorizationAttempt({ actor, id: next.attempt.id })).status).toBe(
        "NEEDS_REVOCATION",
      );
      const successful = await authorize({ key: f.key, name: f.key, reconnect: f.id });
      vi.mocked(completeGoogle).mockResolvedValueOnce({
        accountId: "google-account",
        accountName: "google@example.com",
        credentials: credentials(),
      });
      expect(
        await completeConnection({ state: successful.state, code: "code", cancelled: false }),
      ).toBe("success");
      expect(
        (await getAuthorizationAttempt({ actor, id: successful.attempt.id })).connection?.id,
      ).toBe(f.id);
      await expect(
        completeConnection({ state: successful.state, code: "code", cancelled: false }),
      ).rejects.toThrow("already used");
    });
    it("owner disconnect deletes local state even when Google revocation is unconfirmed", async () => {
      const f = await ready();
      const row = await db.connection.findUniqueOrThrow({ where: { id: f.id } });
      const before = await saveSecret({
        tx: db,
        provider: f.connector.envelopeProvider,
        context: `connection:${f.id}:credentials`,
        value: JSON.stringify({ ...credentials(), expiresAt: 0 }),
        id: row.credentialId,
      });
      vi.mocked(refreshGoogle).mockResolvedValueOnce({
        ...credentials(),
        refreshToken: "rotated",
        grantedScopes: requiredScopes,
      });
      await accessCredentials({ actor, selector: f.id });
      const after = await db.encryptedValue.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.wrappedDek).not.toEqual(before.wrappedDek);
      expect(after.nonce).not.toBe(before.nonce);
      expect(
        JSON.parse(await decrypt({ envelope: after, context: `connection:${f.id}:credentials` })),
      ).toMatchObject({ refreshToken: "rotated", grantedScopes: requiredScopes });
      expect((await db.connection.findUniqueOrThrow({ where: { id: f.id } })).status).toBe(
        "RECONNECT_REQUIRED",
      );
      vi.mocked(revokeGoogle).mockRejectedValueOnce(new Error("provider unavailable"));
      expect(await disconnectConnection({ actor, selector: f.id })).toMatchObject({
        status: "DISCONNECTED",
        revocationConfirmed: false,
        message: expect.stringContaining("provider account settings"),
      });
      expect(revokeGoogle).toHaveBeenCalledWith("rotated");
      await expect(accessCredentials({ actor, selector: f.id })).rejects.toThrow("not found");
      expect(await db.connection.findUnique({ where: { id: f.id } })).toBeNull();
      expect(await db.encryptedValue.findUnique({ where: { id: before.id } })).toBeNull();
      expect(
        await db.auditEvent.findFirst({
          where: {
            subjectId: f.id,
            metadata: { path: ["operation"], equals: "disconnect.deleted_revocation_unconfirmed" },
          },
        }),
      ).not.toBeNull();
      await expect(
        startConnection({
          actor,
          input: { connector: f.key, name: f.key },
        }),
      ).resolves.toMatchObject({ id: expect.any(String) });
    });
    it.each(["success", "google-error", "missing-key"] as const)(
      "admin Disconnect deletes the connection after best-effort revocation: %s",
      async (mode) => {
        const f = await ready();
        const before = await db.connection.findUniqueOrThrow({ where: { id: f.id } });
        if (mode === "google-error")
          vi.mocked(revokeGoogle).mockRejectedValueOnce(new Error("Google unavailable"));
        else if (mode === "success") vi.mocked(revokeGoogle).mockResolvedValueOnce();
        const key = process.env.WELDALL_CONNECTOR_KEK!;
        try {
          if (mode === "missing-key") delete process.env.WELDALL_CONNECTOR_KEK;
          expect(await disconnectAndDeleteConnection({ actor, id: f.id })).toEqual({
            revocationConfirmed: mode === "success",
          });
        } finally {
          process.env.WELDALL_CONNECTOR_KEK = key;
        }
        expect(await db.connection.findUnique({ where: { id: f.id } })).toBeNull();
        expect(await db.connectionAuthorization.count({ where: { connectionId: f.id } })).toBe(0);
        expect(
          await db.encryptedValue.findUnique({ where: { id: before.credentialId! } }),
        ).toBeNull();
        if (mode === "missing-key") expect(revokeGoogle).not.toHaveBeenCalled();
        else expect(revokeGoogle).toHaveBeenCalledWith("never-public-refresh");
        const audit = await db.auditEvent.findMany({ where: { subjectId: f.id } });
        expect(
          audit.some(
            (event) =>
              (event.metadata as { operation: string }).operation ===
              `disconnect.deleted_revocation_${mode === "success" ? "confirmed" : "unconfirmed"}`,
          ),
        ).toBe(true);
        expect(JSON.stringify(audit)).not.toContain("never-public-refresh");
      },
    );
    it("admin Disconnect reports unconfirmed revocation when credentials are missing", async () => {
      const f = await ready();
      const row = await db.connection.findUniqueOrThrow({ where: { id: f.id } });
      await db.connection.update({
        where: { id: f.id },
        data: { credentialId: null, status: "RECONNECT_REQUIRED", revocationError: null },
      });
      await db.encryptedValue.delete({ where: { id: row.credentialId! } });
      expect(await disconnectAndDeleteConnection({ actor, id: f.id })).toEqual({
        revocationConfirmed: false,
      });
      expect(revokeGoogle).not.toHaveBeenCalled();
      expect(await db.connection.findUnique({ where: { id: f.id } })).toBeNull();
    });
    it("admin Disconnect removes dependent reconnect attempts and revokes their retained tokens too", async () => {
      const f = await ready();
      const next = await authorize({ key: f.key, name: f.key, reconnect: f.id });
      vi.mocked(completeGoogle).mockResolvedValueOnce({
        accountId: "wrong-account",
        accountName: "other@example.com",
        credentials: { ...credentials(), refreshToken: "rejected-reconnect-refresh" },
      });
      expect(await completeConnection({ state: next.state, code: "code", cancelled: false })).toBe(
        "failed",
      );
      const pending = await authorize({ key: f.key, name: f.key, reconnect: f.id });
      const attempts = await db.connectionAuthorization.findMany({ where: { connectionId: f.id } });
      vi.mocked(revokeGoogle).mockResolvedValueOnce();
      vi.mocked(revokeGoogle).mockResolvedValueOnce();
      expect(await disconnectAndDeleteConnection({ actor, id: f.id })).toEqual({
        revocationConfirmed: true,
      });
      expect(revokeGoogle).toHaveBeenCalledWith("never-public-refresh");
      expect(revokeGoogle).toHaveBeenCalledWith("rejected-reconnect-refresh");
      expect(await db.connectionAuthorization.count({ where: { connectionId: f.id } })).toBe(0);
      expect(
        await db.encryptedValue.count({
          where: { id: { in: attempts.flatMap((a) => (a.payloadId ? [a.payloadId] : [])) } },
        }),
      ).toBe(0);
      await expect(
        completeConnection({ state: pending.state, code: "late", cancelled: false }),
      ).rejects.toThrow();
    });
    it("admin Disconnect blocks processing and waits for an in-flight refresh before deleting its rotated token", async () => {
      const f = await ready();
      const row = await db.connection.findUniqueOrThrow({ where: { id: f.id } });
      await saveSecret({
        tx: db,
        provider: f.connector.envelopeProvider,
        context: `connection:${f.id}:credentials`,
        value: JSON.stringify({ ...credentials(), expiresAt: 0 }),
        id: row.credentialId,
      });
      const entered = Promise.withResolvers<void>();
      const result = Promise.withResolvers<ReturnType<typeof credentials>>();
      vi.mocked(refreshGoogle).mockImplementationOnce(() => {
        entered.resolve();
        return result.promise;
      });
      const refreshing = accessCredentials({ actor, selector: f.id });
      await entered.promise;
      await expect(disconnectAndDeleteConnection({ actor, id: f.id })).rejects.toThrow(
        "Token processing",
      );
      expect((await db.connection.findUniqueOrThrow({ where: { id: f.id } })).status).toBe(
        "REVOCATION_PENDING",
      );
      expect(revokeGoogle).not.toHaveBeenCalled();
      result.resolve({ ...credentials(), refreshToken: "admin-disconnect-rotated" });
      await refreshing;
      vi.mocked(revokeGoogle).mockResolvedValueOnce();
      expect(await disconnectAndDeleteConnection({ actor, id: f.id })).toEqual({
        revocationConfirmed: true,
      });
      expect(revokeGoogle).toHaveBeenCalledWith("admin-disconnect-rotated");
      expect(await db.connection.findUnique({ where: { id: f.id } })).toBeNull();
    });
    it("admin Disconnect waits for a reconnect exchange and later removes the rejected callback tokens", async () => {
      const f = await ready();
      const next = await authorize({ key: f.key, name: f.key, reconnect: f.id });
      const entered = Promise.withResolvers<void>();
      const result = Promise.withResolvers<Awaited<ReturnType<typeof completeGoogle>>>();
      vi.mocked(completeGoogle).mockImplementationOnce(() => {
        entered.resolve();
        return result.promise;
      });
      const completing = completeConnection({ state: next.state, code: "code", cancelled: false });
      await entered.promise;
      await expect(disconnectAndDeleteConnection({ actor, id: f.id })).rejects.toThrow(
        "Token processing",
      );
      expect(revokeGoogle).not.toHaveBeenCalled();
      result.resolve({
        accountId: "google-account",
        accountName: "google@example.com",
        credentials: { ...credentials(), refreshToken: "in-flight-reconnect-token" },
      });
      expect(await completing).toBe("failed");
      vi.mocked(revokeGoogle).mockResolvedValueOnce();
      vi.mocked(revokeGoogle).mockResolvedValueOnce();
      expect(await disconnectAndDeleteConnection({ actor, id: f.id })).toEqual({
        revocationConfirmed: true,
      });
      expect(revokeGoogle).toHaveBeenCalledWith("in-flight-reconnect-token");
      expect(await db.connection.findUnique({ where: { id: f.id } })).toBeNull();
      expect(await db.connectionAuthorization.count({ where: { connectionId: f.id } })).toBe(0);
    });
    it("admin Disconnect blocks usage before contacting Google and deletes locally even when Google fails", async () => {
      const f = await ready();
      const entered = Promise.withResolvers<void>();
      const result = Promise.withResolvers<void>();
      vi.mocked(revokeGoogle).mockImplementationOnce(() => {
        entered.resolve();
        return result.promise;
      });
      const disconnecting = disconnectAndDeleteConnection({ actor, id: f.id });
      await entered.promise;
      await expect(accessCredentials({ actor, selector: f.id })).rejects.toThrow("not ready");
      await expect(authorize({ key: f.key, name: f.key, reconnect: f.id })).rejects.toThrow(
        "cannot be reconnected",
      );
      result.reject(new Error("Google unavailable"));
      expect(await disconnecting).toEqual({ revocationConfirmed: false });
      expect(await db.connection.findUnique({ where: { id: f.id } })).toBeNull();
    });
    it("keeps an in-flight refresh unavailable after disconnect and retains rotation for explicit revocation", async () => {
      const f = await ready();
      const row = await db.connection.findUniqueOrThrow({ where: { id: f.id } });
      await saveSecret({
        tx: db,
        provider: f.connector.envelopeProvider,
        context: `connection:${f.id}:credentials`,
        value: JSON.stringify({ ...credentials(), expiresAt: 0 }),
        id: row.credentialId,
      });
      const entered = Promise.withResolvers<void>();
      const result = Promise.withResolvers<ReturnType<typeof credentials>>();
      vi.mocked(refreshGoogle).mockImplementationOnce(() => {
        entered.resolve();
        return result.promise;
      });
      const refreshing = accessCredentials({ actor, selector: f.id });
      await entered.promise;
      expect((await disconnectConnection({ actor, selector: f.id })).status).toBe(
        "REVOCATION_PENDING",
      );
      expect(revokeGoogle).not.toHaveBeenCalled();
      result.resolve({ ...credentials(), refreshToken: "rotated-while-disconnecting" });
      await refreshing;
      expect((await db.connection.findUniqueOrThrow({ where: { id: f.id } })).status).toBe(
        "REVOCATION_PENDING",
      );
      await expect(accessCredentials({ actor, selector: f.id })).rejects.toThrow("not ready");
      vi.mocked(revokeGoogle).mockResolvedValueOnce();
      expect((await disconnectConnection({ actor, selector: f.id })).status).toBe("DISCONNECTED");
      expect(revokeGoogle).toHaveBeenCalledWith("rotated-while-disconnecting");
      expect(await db.connection.findUnique({ where: { id: f.id } })).toBeNull();
    });
    it("does not let stale callbacks undo disconnect", async () => {
      const f = await ready();
      const next = await authorize({ key: f.key, name: f.key, reconnect: f.id });
      vi.mocked(revokeGoogle).mockResolvedValueOnce();
      await disconnectConnection({ actor, selector: f.id });
      vi.mocked(completeGoogle).mockResolvedValueOnce({
        accountId: "google-account",
        accountName: "google@example.com",
        credentials: credentials(),
      });
      await expect(
        completeConnection({ state: next.state, code: "code", cancelled: false }),
      ).rejects.toThrow("expired or already used");
      expect(await db.connection.findUnique({ where: { id: f.id } })).toBeNull();
    });
    it("detects UI drift without treating refresh/ciphertext writes as configuration drift", async () => {
      const f = await fixture();
      const workspace = await db.iacWorkspace.create({
        data: { id: randomUUID(), name: prefix, issuer: "https://weldall.example.com" },
      });
      await db.iacObjectBinding.create({
        data: {
          workspaceId: workspace.id,
          address: "connector.google",
          kind: "CONNECTOR",
          naturalIdentity: f.key,
          connectorId: f.connector.id,
        },
      });
      const manifest = parseDesiredState({
        apiVersion: "weldall.dev/v1",
        workspace: { id: workspace.id, name: workspace.name, issuer: workspace.issuer },
        connectors: { google: { ...config(f.key), enabled: true } },
      });
      const planned = async () =>
        createPlan(manifest, await loadPlanningState({ tx: db, manifest }));
      expect((await planned()).actions[0]?.action).toBe("noop");
      await transaction((tx) =>
        saveConnectorConfiguration({
          tx,
          value: { ...config(f.key), enabled: true, name: "UI edit" },
          id: f.connector.id,
          expectedVersion: f.connector.version,
          actor,
        }),
      );
      expect((await planned()).actions[0]).toMatchObject({ action: "update", drift: true });
      await transaction((tx) =>
        saveConnectorConfiguration({
          tx,
          value: manifest.connectors.google,
          id: f.connector.id,
          expectedVersion: f.connector.version + 1,
          actor,
        }),
      );
      expect((await planned()).actions[0]?.action).toBe("noop");
    });
    it("deletes a connector before a same-apply required scope removal", async () => {
      const iacScope = await db.scope.findUniqueOrThrow({ where: { key: IAC_SCOPE_KEY } });
      const keys = await generateEs256KeyPair();
      const thumbprint = await calculateJwkThumbprint(keys.publicJwk, "sha256");
      const runner = await db.machineClient.create({
        data: {
          clientId: `${prefix}-connector-delete-runner`,
          name: "Connector delete runner",
          createdBy: actor.id,
          updatedBy: actor.id,
          keys: {
            create: {
              kid: "current",
              publicJwk: keys.publicJwk,
              thumbprint,
              createdBy: actor.id,
            },
          },
          allowedScopes: { create: { scopeId: iacScope.id } },
        },
      });
      const iacActor = {
        clientId: runner.clientId,
        keyId: "current",
        keyThumbprint: thumbprint,
        requestId: `${prefix}-connector-delete-apply`,
      };
      const workspace = {
        id: randomUUID(),
        name: `${prefix}-connector-delete`,
        issuer: "https://weldall.example.com",
      };
      const adminEmail = `${prefix}-connector-delete-admin@example.com`;
      await db.user.create({
        data: {
          id: `${prefix}-connector-delete-admin`,
          name: "Connector delete admin",
          email: adminEmail,
          emailVerified: true,
        },
      });
      const scopeKey = `${prefix}:connector-delete`;
      const current = parseDesiredState({
        apiVersion: "weldall.dev/v1",
        workspace,
        emailAssignments: { admin: { email: adminEmail, scopes: ["weldall:administer"] } },
        scopes: { connector_delete: { key: scopeKey, description: "Connector delete" } },
        connectors: {
          google: {
            ...config(`${prefix}-iac-delete-google`),
            requiredScopes: [scopeKey],
          },
        },
      });
      const apply = async (manifest: typeof current) => {
        const plan = await planIac(manifest);
        expect(plan.blockers).toEqual([]);
        await applyIac(
          {
            manifest,
            plannedRevision: plan.revision,
            configDigest: plan.configDigest,
            planDigest: plan.digest,
            operationId: randomUUID(),
          },
          iacActor,
        );
      };
      await apply(current);
      const removed = parseDesiredState({
        apiVersion: "weldall.dev/v1",
        workspace,
        emailAssignments: { admin: { email: adminEmail, scopes: ["weldall:administer"] } },
      });
      await apply(removed);
      await expect(db.connector.findUnique({ where: { key: `${prefix}-iac-delete-google` } }))
        .resolves.toBeNull();
      await expect(db.scope.findUnique({ where: { key: scopeKey } })).resolves.toBeNull();
    });
    it("checks freshness on each generic dispatch and audits fingerprints without URLs", async () => {
      const f = await ready();
      const fetcher = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ items: [] }), {
          headers: {
            "content-type": "application/json",
            "set-cookie": "private",
            authorization: "private",
          },
        }),
      );
      vi.stubGlobal("fetch", fetcher);
      const fresh = vi.spyOn(googleProvider, "ensureGrantCurrent");
      const url = `https://weldall.example.com/connectors/${f.key}`;
      const target =
        "https://www.googleapis.com/calendar/future-v99/private@example.com/events?arbitrary=private-query";
      const response = await executeConnectionRequest({
        request: new Request(url, {
          headers: {
            "x-weldall-connection": f.id,
            "x-weldall-upstream-url": target,
            authorization: "DPoP weldall",
            dpop: "proof",
            cookie: "private",
          },
        }),
        actor,
        connectorKey: f.key,
      });
      expect(await response.json()).toEqual({ items: [] });
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("authorization")).toBeNull();
      expect(fetcher.mock.calls[0]?.[0].origin).toBe("https://www.googleapis.com");
      expect(fetcher.mock.calls[0]?.[1].headers.get("authorization")).toBe(
        "Bearer never-public-access",
      );
      expect(fetcher.mock.calls[0]?.[1].headers.get("dpop")).toBeNull();
      expect(fresh).toHaveBeenCalledTimes(1);
      const audit = await db.auditEvent.findMany({
        where: { subjectId: f.id, eventType: "connector.request" },
      });
      expect(audit[0]?.metadata).toMatchObject({
        provider: "google",
        method: "GET",
        requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: 200,
      });
      expect(JSON.stringify(audit)).not.toMatch(
        /private@example|private-query|future-v99|never-public/,
      );
      await expect(
        executeConnectionRequest({
          request: new Request(url, {
            headers: { "x-weldall-connection": f.id, "x-weldall-upstream-url": target },
          }),
          actor,
          connectorKey: "different-connector",
        }),
      ).rejects.toThrow("not available");
      await expect(
        executeConnectionRequest({
          request: new Request(url, {
            headers: { "x-weldall-connection": f.id, "x-weldall-upstream-url": target },
          }),
          actor: { ...actor, id: "different-owner" },
          connectorKey: f.key,
        }),
      ).rejects.toThrow("not found");
      expect(fetcher).toHaveBeenCalledTimes(1);
      fresh.mockRestore();
    });
    it("fails closed on unknown providers, unsafe origins, rate limits and authentication failures", async () => {
      const f = await ready();
      const fetcher = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
      vi.stubGlobal("fetch", fetcher);
      const execute = (target = "https://gmail.googleapis.com/arbitrary") =>
        executeConnectionRequest({
          request: new Request(`https://weldall.example.com/connectors/${f.key}`, {
            headers: { "x-weldall-connection": f.id, "x-weldall-upstream-url": target },
          }),
          actor,
          connectorKey: f.key,
        });
      await expect(execute("https://evil.example/private")).rejects.toMatchObject({
        code: "invalid_target",
      });
      await db.connector.update({
        where: { id: f.connector.id },
        data: { providerType: "unknown" },
      });
      await expect(execute()).rejects.toMatchObject({ code: "unsupported_provider" });
      await db.connector.update({
        where: { id: f.connector.id },
        data: { providerType: "google" },
      });
      await db.connection.update({
        where: { id: f.id },
        data: { rateWindow: new Date(), rateCount: 60 },
      });
      await expect(execute()).rejects.toMatchObject({ code: "rate_limit" });
      expect(fetcher).not.toHaveBeenCalled();
      await db.connection.update({ where: { id: f.id }, data: { rateCount: 0 } });
      expect((await execute()).status).toBe(401);
      expect((await db.connection.findUniqueOrThrow({ where: { id: f.id } })).status).toBe(
        "RECONNECT_REQUIRED",
      );
      await expect(execute()).rejects.toThrow("not available");
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it("applies, detects UI drift, preserves secrets, imports, moves and unmanages introduced primitives", async () => {
      await ensureSystemScopes(db, actor.id);
      const scopes = await db.scope.findMany({
        where: { key: { in: ["weldall:administer", "weldall:iac"] } },
      });
      await db.emailScopeAssignment.create({
        data: {
          normalizedEmail: actor.email,
          createdBy: actor.id,
          updatedBy: actor.id,
          grants: {
            create: {
              scopeId: scopes.find((s) => s.key === "weldall:administer")!.id,
              createdBy: actor.id,
            },
          },
        },
      });
      const keys = await generateEs256KeyPair(),
        thumbprint = await calculateJwkThumbprint(keys.publicJwk);
      await db.machineClient.create({
        data: {
          clientId: actor.id,
          name: "IaC test",
          createdBy: actor.id,
          updatedBy: actor.id,
          keys: {
            create: { kid: "current", publicJwk: keys.publicJwk, thumbprint, createdBy: actor.id },
          },
          allowedScopes: { create: { scopeId: scopes.find((s) => s.key === "weldall:iac")!.id } },
        },
      });
      const iacActor = {
        clientId: actor.id,
        keyId: "current",
        keyThumbprint: thumbprint,
        requestId: actor.requestId,
      };
      const name = `${prefix}-iac`;
      const requiredScopeKey = `${prefix}:iac-connector`;
      const iacConfig = { ...config(name), requiredScopes: [requiredScopeKey] };
      let manifest = parseDesiredState({
        apiVersion: "weldall.dev/v1",
        workspace: { id: randomUUID(), name: prefix, issuer: "https://weldall.example.com" },
        scopes: {
          connector: { key: requiredScopeKey, description: "Use the IaC connector" },
        },
        connectors: { google: iacConfig },
      });
      const plan = await planIac(manifest);
      expect(plan.blockers).toEqual([]);
      const request = {
        manifest,
        plannedRevision: plan.revision,
        configDigest: plan.configDigest,
        planDigest: plan.digest,
        operationId: randomUUID(),
      };
      const result = await applyIac(request, iacActor);
      expect(await applyIac(request, iacActor)).toEqual(result);
      let connector = await db.connector.findUniqueOrThrow({ where: { key: name } });
      await saveConnectorSecrets({
        id: connector.id,
        secrets: { clientSecret: "iac-secret" },
        expectedVersion: connector.version,
        actor,
      });
      connector = await db.connector.findUniqueOrThrow({ where: { id: connector.id } });
      await transaction((tx) =>
        saveConnectorConfiguration({
          tx,
          value: { ...iacConfig, name: "UI changed" },
          id: connector.id,
          expectedVersion: connector.version,
          actor,
        }),
      );
      const drift = await planIac(manifest);
      expect(drift.actions).toContainEqual(
        expect.objectContaining({ address: "connector.google", drift: true }),
      );
      await applyIac(
        {
          manifest,
          plannedRevision: drift.revision,
          configDigest: drift.configDigest,
          planDigest: drift.digest,
          operationId: randomUUID(),
        },
        iacActor,
      );
      const restored = await db.connector.findUniqueOrThrow({ where: { id: connector.id } });
      expect(restored.name).toBe("Google");
      expect(restored.encryptedProviderSecrets).toBe(connector.encryptedProviderSecrets);
      const manual = await fixture();
      const imported = await importIac(
        {
          workspace: manifest.workspace,
          kind: "connector",
          identity: manual.key,
          address: "connector.imported",
          operationId: randomUUID(),
        },
        iacActor,
      );
      expect(JSON.stringify(imported)).not.toMatch(
        /never-public|encryptedClientSecret|ciphertext|wrappedDek/,
      );
      await moveIacState(
        {
          workspaceId: manifest.workspace.id,
          from: "connector.google",
          to: "connector.renamed",
          operationId: randomUUID(),
        },
        iacActor,
      );
      expect((await getIacState(manifest.workspace.id)).objects).toContainEqual(
        expect.objectContaining({ address: "connector.renamed", objectId: connector.id }),
      );
      manifest = parseDesiredState({ ...manifest, connectors: { renamed: iacConfig } });
      await unmanageIac(
        {
          workspaceId: manifest.workspace.id,
          address: "connector.imported",
          manifest,
          configDigest: digest(manifest),
          operationId: randomUUID(),
        },
        iacActor,
      );
      expect(await db.connector.findUnique({ where: { id: manual.connector.id } })).not.toBeNull();
      expect(
        await db.iacObjectBinding.findUnique({ where: { connectorId: manual.connector.id } }),
      ).toBeNull();
    });
    it("shares DPoP replay protection through normal PostgreSQL constraints", async () => {
      const key = `${prefix}-replay`,
        expires = new Date(Date.now() + 60000);
      expect(await createPostgresReplayStore().consume(key, expires)).toBe(true);
      expect(await createPostgresReplayStore().consume(key, expires)).toBe(false);
    });
  },
);
