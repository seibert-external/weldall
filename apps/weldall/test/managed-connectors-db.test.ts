import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, ensureSystemScopes } from "@weldall/db";
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
import { executeConnectionRequest } from "../src/server/connectors/execution";
import {
  saveEncryptionKeyConfiguration,
  saveConnectorConfiguration,
  runConnectorTransaction as transaction,
  saveConnectorClientSecret,
  reencryptConnectorSecrets,
  deleteEncryptionKeyConfiguration,
  listManagedConnectorConfiguration as listConfiguration,
} from "../src/server/connectors/configuration";
import { decrypt, encrypt, saveSecret } from "../src/server/connectors/encryption";
import {
  accessCredentials,
  completeConnection,
  disconnectConnection,
  discardConnection,
  getAuthorizationAttempt,
  listConnections,
  findOwnedConnection,
  startConnection,
  submitScopeSelection,
} from "../src/server/connectors/connections";
import {
  completeGoogleAuthorization as completeGoogle,
  refreshGoogleCredentials as refreshGoogle,
  revokeGoogleAuthorization as revokeGoogle,
} from "../src/server/connectors/google";
import { requiredScopes } from "../src/server/connectors/scopes";
import { createPostgresReplayStore } from "../src/server/oauth/replay";
import { parseDesiredState } from "../src/server/iac/contracts";
import { createPlan, loadPlanningState } from "../src/server/iac/planner";

vi.mock("../src/server/connectors/google", async (original) => ({
  ...(await original<typeof import("../src/server/connectors/google")>()),
  completeGoogleAuthorization: vi.fn(),
  refreshGoogleCredentials: vi.fn(),
  revokeGoogleAuthorization: vi.fn(),
}));
const target = "postgresql://postgres@localhost:5433/postgres";
// Use the operator-approved local database or CI's existing disposable test service; never reset either here.
const approvedTarget =
  process.env.POSTGRES_URL === target ||
  (process.env.CI === "true" &&
    process.env.POSTGRES_URL === "postgresql://postgres:postgres@localhost:5432/postgres");
const prefix = `managed-${randomUUID()}`;
const actor = { id: prefix, requestId: prefix, email: `${prefix}@example.com` };
const read = "https://www.googleapis.com/auth/gmail.readonly",
  calendar = "https://www.googleapis.com/auth/calendar.readonly";
const selected = [...requiredScopes, calendar];
const config = (key: string) => ({
  key,
  name: "Google",
  type: "google" as const,
  enabled: false,
  encryptionKey: key,
  clientId: "test.apps.googleusercontent.com",
  enabledApis: ["gmail", "calendar"],
  allowedScopes: [read, calendar].sort(),
  defaultScopes: [calendar],
});
const keyConfig = (key: string) => ({
  key,
  name: "Test",
  activeVersion: "1",
  versions: {
    "1": { source: { type: "local-env", variable: "MANAGED_TEST_A" } },
  },
});
const credentials = () => ({
  accessToken: "never-public-access",
  refreshToken: "never-public-refresh",
  expiresAt: Date.now() + 3600000,
  grantedScopes: selected,
});
let n = 0;
/** Creates an isolated key and enabled connector fixture through production mutation paths. */
async function fixture() {
  const key = `${prefix}-${++n}`;
  const logical = await transaction((tx) =>
    saveEncryptionKeyConfiguration({
      tx,
      value: keyConfig(key),
      id: undefined,
      expectedVersion: null,
      actor,
    }),
  );
  let connector = await transaction((tx) =>
    saveConnectorConfiguration({
      tx,
      value: config(key),
      id: undefined,
      expectedVersion: null,
      actor,
    }),
  );
  await saveConnectorClientSecret({
    id: connector.id,
    secret: "never-public-client-secret",
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
  return { key, logical, connector };
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
  const { url } = await submitScopeSelection({ actor, id: attempt.id, selected });
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
      vi.stubEnv("WELDALL_ENCRYPTION_SOURCES", "MANAGED_TEST_A,MANAGED_TEST_B");
      vi.stubEnv("MANAGED_TEST_A", randomBytes(32).toString("base64"));
      vi.stubEnv("MANAGED_TEST_B", randomBytes(32).toString("base64"));
      await db.user.create({
        data: { id: actor.id, name: "Test", email: actor.email, emailVerified: true },
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
      await db.connectionAuthorization.deleteMany({ where: { ownerId: actor.id } });
      await db.connection.deleteMany({ where: { ownerId: actor.id } });
      await db.iacObjectBinding.deleteMany({
        where: {
          OR: [{ connectorId: { in: ids } }, { encryptionKey: { key: { startsWith: prefix } } }],
        },
      });
      await db.connector.deleteMany({ where: { id: { in: ids } } });
      await db.encryptedValue.deleteMany({
        where: { key: { key: { key: { startsWith: prefix } } } },
      });
      await db.encryptionKeyVersion.deleteMany({ where: { key: { key: { startsWith: prefix } } } });
      await db.encryptionKey.deleteMany({ where: { key: { startsWith: prefix } } });
      await db.iacWorkspace.deleteMany({ where: { name: prefix } });
      await db.machineClient.deleteMany({ where: { clientId: actor.id } });
      await db.emailScopeAssignment.deleteMany({ where: { normalizedEmail: actor.email } });
      await db.user.delete({ where: { id: actor.id } });
      await db.auditEvent.deleteMany({ where: { actorId: actor.id } });
      await db.replayMarker.deleteMany({ where: { key: { startsWith: prefix } } });
      vi.unstubAllEnvs();
    });
    it("resolves historical versions, purpose AAD, approved sources and immutable material", async () => {
      const f = await fixture();
      const data = await encrypt({
        tx: db,
        keyId: f.logical.id,
        plaintext: "plaintext",
        context: "test-purpose",
      });
      const envelope = await db.encryptedValue.create({ data });
      await expect(
        decrypt({ tx: db, value: envelope, context: "wrong-purpose" }),
      ).rejects.toThrow();
      const next = {
        ...keyConfig(f.key),
        activeVersion: "2",
        versions: {
          ...keyConfig(f.key).versions,
          "2": { source: { type: "local-env", variable: "MANAGED_TEST_B" } },
        },
      };
      await transaction((tx) =>
        saveEncryptionKeyConfiguration({
          tx,
          value: next,
          id: f.logical.id,
          expectedVersion: 1,
          actor,
        }),
      );
      expect(await decrypt({ tx: db, value: envelope, context: "test-purpose" })).toBe("plaintext");
      expect(
        (
          await encrypt({
            tx: db,
            keyId: f.logical.id,
            plaintext: "new",
            context: "test-purpose",
          })
        ).keyVersion,
      ).toBe("2");
      const original = process.env.MANAGED_TEST_A;
      process.env.MANAGED_TEST_A = randomBytes(32).toString("base64");
      await expect(decrypt({ tx: db, value: envelope, context: "test-purpose" })).rejects.toThrow(
        "unavailable",
      );
      process.env.MANAGED_TEST_A = original!;
      await expect(
        transaction((tx) =>
          saveEncryptionKeyConfiguration({
            tx,
            value: keyConfig(f.key),
            id: f.logical.id,
            expectedVersion: 2,
            actor,
          }),
        ),
      ).rejects.toThrow("historical");
      await expect(
        transaction((tx) =>
          saveEncryptionKeyConfiguration({
            tx,
            value: {
              ...keyConfig(`${f.key}-unapproved`),
              versions: {
                "1": { source: { type: "local-env", variable: "PATH" } },
              },
            },
            id: undefined,
            expectedVersion: null,
            actor,
          }),
        ),
      ).rejects.toThrow("unavailable");
      await expect(
        transaction((tx) =>
          deleteEncryptionKeyConfiguration({ tx, id: f.logical.id, version: 2, actor }),
        ),
      ).rejects.toThrow("referenced");
    });
    it("de-provisions stale client secrets when the OAuth client changes", async () => {
      const f = await fixture();
      const originalSecretId = f.connector.secretId!;
      await expect(
        transaction((tx) =>
          saveConnectorConfiguration({
            tx,
            value: {
              ...config(f.key),
              enabled: true,
              clientId: "replacement.apps.googleusercontent.com",
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
          value: { ...config(f.key), clientId: "replacement.apps.googleusercontent.com" },
          id: f.connector.id,
          expectedVersion: f.connector.version,
          actor,
        }),
      );
      expect(changed.secretId).toBeNull();
      await expect(
        db.encryptedValue.findUniqueOrThrow({ where: { id: originalSecretId } }),
      ).rejects.toThrow();
    });
    it("re-encrypts explicitly and rolls back on unavailable old material", async () => {
      const f = await ready();
      const row = await db.connection.findUniqueOrThrow({ where: { id: f.id } });
      const old = await db.encryptedValue.findUniqueOrThrow({ where: { id: row.credentialId! } });
      const second = await transaction((tx) =>
        saveEncryptionKeyConfiguration({
          tx,
          value: {
            ...keyConfig(`${f.key}-second`),
            versions: {
              "1": { source: { type: "local-env", variable: "MANAGED_TEST_B" } },
            },
          },
          id: undefined,
          expectedVersion: null,
          actor,
        }),
      );
      const connector = await transaction((tx) =>
        saveConnectorConfiguration({
          tx,
          value: { ...config(f.key), enabled: true, encryptionKey: second.key },
          id: f.connector.id,
          expectedVersion: f.connector.version,
          actor,
        }),
      );
      expect((await db.encryptedValue.findUniqueOrThrow({ where: { id: old.id } })).keyId).toBe(
        f.logical.id,
      );
      const material = process.env.MANAGED_TEST_A!;
      delete process.env.MANAGED_TEST_A;
      await expect(
        reencryptConnectorSecrets({
          connectorId: connector.id,
          expectedVersion: connector.version,
          actor,
        }),
      ).rejects.toThrow();
      expect((await db.encryptedValue.findUniqueOrThrow({ where: { id: old.id } })).version).toBe(
        old.version,
      );
      process.env.MANAGED_TEST_A = material;
      expect(
        (
          await reencryptConnectorSecrets({
            connectorId: connector.id,
            expectedVersion: connector.version,
            actor,
          })
        ).count,
      ).toBe(2);
      expect((await db.encryptedValue.findUniqueOrThrow({ where: { id: old.id } })).keyId).toBe(
        second.id,
      );
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
        /never-public|credentialId|ciphertext|secretId/,
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
          value: { ...config(f.key), enabled: true, allowedScopes: [read], defaultScopes: [] },
          id: f.connector.id,
          expectedVersion: f.connector.version,
          actor,
        }),
      );
      await expect(submitScopeSelection({ actor, id: a.id, selected })).rejects.toThrow(
        "configuration changed",
      );
    });
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
    it("refreshes centrally, preserves reduced grants and blocks failed revocation until manual retry", async () => {
      const f = await ready();
      const row = await db.connection.findUniqueOrThrow({ where: { id: f.id } });
      await saveSecret({
        tx: db,
        keyId: f.logical.id,
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
      expect((await db.connection.findUniqueOrThrow({ where: { id: f.id } })).status).toBe(
        "RECONNECT_REQUIRED",
      );
      vi.mocked(revokeGoogle).mockRejectedValueOnce(new Error("provider unavailable"));
      expect((await disconnectConnection({ actor, selector: f.id })).status).toBe(
        "REVOCATION_PENDING",
      );
      await expect(accessCredentials({ actor, selector: f.id })).rejects.toThrow("not ready");
      expect(
        (await db.connection.findUniqueOrThrow({ where: { id: f.id } })).credentialId,
      ).not.toBeNull();
      vi.mocked(revokeGoogle).mockResolvedValueOnce();
      expect((await disconnectConnection({ actor, selector: f.id })).status).toBe("DISCONNECTED");
      expect(vi.mocked(revokeGoogle).mock.calls[1]?.[0]).toBe("rotated");
      expect(
        (await db.connection.findUniqueOrThrow({ where: { id: f.id } })).credentialId,
      ).toBeNull();
    });
    it("records administrator terminal cleanup without claiming provider revocation", async () => {
      const f = await ready();
      vi.mocked(revokeGoogle).mockRejectedValueOnce(
        new Error("invalid token is not grant revocation proof"),
      );
      await disconnectConnection({ actor, selector: f.id });
      const blocked = await db.connection.findUniqueOrThrow({ where: { id: f.id } });
      await discardConnection({ actor, id: f.id, version: blocked.version });
      const result = await disconnectConnection({ actor, selector: f.id });
      expect(result).toMatchObject({ status: "DISCONNECTED", revocationConfirmed: false });
      expect(
        await db.encryptedValue.findUnique({ where: { id: blocked.credentialId! } }),
      ).toBeNull();
      await expect(accessCredentials({ actor, selector: f.id })).rejects.toThrow("not ready");
      const next = await authorize({ key: f.key, name: f.key, reconnect: f.id });
      vi.mocked(completeGoogle).mockResolvedValueOnce({
        accountId: "google-account",
        accountName: "google@example.com",
        credentials: credentials(),
      });
      expect(await completeConnection({ state: next.state, code: "code", cancelled: false })).toBe(
        "success",
      );
      expect((await getAuthorizationAttempt({ actor, id: next.attempt.id })).connection?.id).toBe(
        f.id,
      );
    });
    it("keeps an in-flight refresh unavailable after disconnect and retains rotation for explicit revocation", async () => {
      const f = await ready();
      const row = await db.connection.findUniqueOrThrow({ where: { id: f.id } });
      await saveSecret({
        tx: db,
        keyId: f.logical.id,
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
      expect(await completeConnection({ state: next.state, code: "code", cancelled: false })).toBe(
        "failed",
      );
      expect((await db.connection.findUniqueOrThrow({ where: { id: f.id } })).status).toBe(
        "DISCONNECTED",
      );
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
    it("executes only allowed operations centrally and filters provider credentials", async () => {
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
      const url = `https://weldall.example.com/connectors/${f.key}/calendar/v3/calendars/primary/events`;
      const response = await executeConnectionRequest({
        request: new Request(url, {
          headers: {
            "x-weldall-connection": f.id,
            authorization: "DPoP weldall",
            dpop: "proof",
            cookie: "private",
          },
        }),
        actor,
        connectorKey: f.key,
        path: "/calendar/v3/calendars/primary/events",
      });
      expect(await response.json()).toEqual({ items: [] });
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("authorization")).toBeNull();
      expect(fetcher.mock.calls[0]?.[0].origin).toBe("https://www.googleapis.com");
      expect(fetcher.mock.calls[0]?.[1].headers.get("authorization")).toBe(
        "Bearer never-public-access",
      );
      expect(fetcher.mock.calls[0]?.[1].headers.get("dpop")).toBeNull();
      await expect(
        executeConnectionRequest({
          request: new Request(url, {
            method: "POST",
            headers: { "x-weldall-connection": f.id },
          }),
          actor,
          connectorKey: f.key,
          path: "/gmail/v1/users/me/messages/send",
        }),
      ).rejects.toThrow("not available");
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
      let manifest = parseDesiredState({
        apiVersion: "weldall.dev/v1",
        workspace: { id: randomUUID(), name: prefix, issuer: "https://weldall.example.com" },
        encryptionKeys: { key: keyConfig(name) },
        connectors: { google: config(name) },
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
      await saveConnectorClientSecret({
        id: connector.id,
        secret: "iac-secret",
        expectedVersion: connector.version,
        actor,
      });
      connector = await db.connector.findUniqueOrThrow({ where: { id: connector.id } });
      await transaction((tx) =>
        saveConnectorConfiguration({
          tx,
          value: { ...config(name), name: "UI changed" },
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
      expect(restored.secretId).toBe(connector.secretId);
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
      expect(JSON.stringify(imported)).not.toMatch(/never-public|secretId|ciphertext/);
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
      manifest = parseDesiredState({ ...manifest, connectors: { renamed: config(name) } });
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
