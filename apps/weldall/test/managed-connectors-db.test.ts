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
import { executeConnection } from "../src/server/connectors/execution";
import {
  mutateKey,
  mutateConnector,
  transaction,
  setClientSecret,
  reencryptConnector,
  deleteKey,
  listConfiguration,
} from "../src/server/connectors/configuration";
import { decrypt, encrypt, saveSecret } from "../src/server/connectors/encryption";
import {
  accessCredentials,
  completeConnection,
  disconnect,
  discardConnection,
  getAttempt,
  listConnections,
  ownedConnection,
  startConnection,
  submitSelection,
} from "../src/server/connectors/connections";
import { completeGoogle, refreshGoogle, revokeGoogle } from "../src/server/connectors/google";
import { requiredScopes } from "../src/server/connectors/scopes";
import { createPostgresReplayStore } from "../src/server/oauth/replay";
import { parseDesiredState } from "../src/server/iac/contracts";
import { createPlan, loadPlanningState } from "../src/server/iac/planner";

vi.mock("../src/server/connectors/google", async (original) => ({
  ...(await original<typeof import("../src/server/connectors/google")>()),
  completeGoogle: vi.fn(),
  refreshGoogle: vi.fn(),
  revokeGoogle: vi.fn(),
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
  versions: { "1": { source: { type: "env", name: "MANAGED_TEST_A" } } },
});
const credentials = () => ({
  accessToken: "never-public-access",
  refreshToken: "never-public-refresh",
  expiresAt: Date.now() + 3600000,
  grantedScopes: selected,
});
let n = 0;
async function fixture() {
  const key = `${prefix}-${++n}`;
  const logical = await transaction((tx) => mutateKey(tx, keyConfig(key), undefined, null, actor));
  let connector = await transaction((tx) =>
    mutateConnector(tx, config(key), undefined, null, actor),
  );
  await setClientSecret(connector.id, "never-public-client-secret", connector.version, actor);
  connector = await transaction((tx) =>
    mutateConnector(tx, { ...config(key), enabled: true }, connector.id, 2, actor),
  );
  return { key, logical, connector };
}
async function authorize(key: string, name: string, reconnect?: string) {
  const attempt = await startConnection(actor, {
    connector: key,
    name,
    ...(reconnect ? { reconnect } : {}),
  });
  const { url } = await submitSelection(actor, attempt.id, selected);
  return { attempt, state: new URL(url).searchParams.get("state")! };
}
async function ready() {
  const f = await fixture();
  const { attempt, state } = await authorize(f.key, f.key);
  vi.mocked(completeGoogle).mockResolvedValueOnce({
    accountId: "google-account",
    accountName: "google@example.com",
    credentials: credentials(),
  });
  expect(await completeConnection(state, "code", false)).toBe("success");
  const result = await getAttempt(actor, attempt.id);
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
      const data = await encrypt(db, f.logical.id, "plaintext", "test-purpose");
      const envelope = await db.encryptedValue.create({ data });
      await expect(decrypt(db, envelope, "wrong-purpose")).rejects.toThrow();
      const next = {
        ...keyConfig(f.key),
        activeVersion: "2",
        versions: {
          ...keyConfig(f.key).versions,
          "2": { source: { type: "env", name: "MANAGED_TEST_B" } },
        },
      };
      await transaction((tx) => mutateKey(tx, next, f.logical.id, 1, actor));
      expect(await decrypt(db, envelope, "test-purpose")).toBe("plaintext");
      expect((await encrypt(db, f.logical.id, "new", "test-purpose")).keyVersion).toBe("2");
      const original = process.env.MANAGED_TEST_A;
      process.env.MANAGED_TEST_A = randomBytes(32).toString("base64");
      await expect(decrypt(db, envelope, "test-purpose")).rejects.toThrow("unavailable");
      process.env.MANAGED_TEST_A = original!;
      await expect(
        transaction((tx) => mutateKey(tx, keyConfig(f.key), f.logical.id, 2, actor)),
      ).rejects.toThrow("historical");
      await expect(
        transaction((tx) =>
          mutateKey(
            tx,
            {
              ...keyConfig(`${f.key}-unapproved`),
              versions: { "1": { source: { type: "env", name: "PATH" } } },
            },
            undefined,
            null,
            actor,
          ),
        ),
      ).rejects.toThrow("unavailable");
      await expect(transaction((tx) => deleteKey(tx, f.logical.id, 2, actor))).rejects.toThrow(
        "referenced",
      );
    });
    it("de-provisions stale client secrets when the OAuth client changes", async () => {
      const f = await fixture();
      const originalSecretId = f.connector.secretId!;
      await expect(
        transaction((tx) =>
          mutateConnector(
            tx,
            { ...config(f.key), enabled: true, clientId: "replacement.apps.googleusercontent.com" },
            f.connector.id,
            f.connector.version,
            actor,
          ),
        ),
      ).rejects.toThrow("new OAuth client secret");
      const changed = await transaction((tx) =>
        mutateConnector(
          tx,
          { ...config(f.key), clientId: "replacement.apps.googleusercontent.com" },
          f.connector.id,
          f.connector.version,
          actor,
        ),
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
        mutateKey(
          tx,
          {
            ...keyConfig(`${f.key}-second`),
            versions: { "1": { source: { type: "env", name: "MANAGED_TEST_B" } } },
          },
          undefined,
          null,
          actor,
        ),
      );
      const connector = await transaction((tx) =>
        mutateConnector(
          tx,
          { ...config(f.key), enabled: true, encryptionKey: second.key },
          f.connector.id,
          f.connector.version,
          actor,
        ),
      );
      expect((await db.encryptedValue.findUniqueOrThrow({ where: { id: old.id } })).keyId).toBe(
        f.logical.id,
      );
      const material = process.env.MANAGED_TEST_A!;
      delete process.env.MANAGED_TEST_A;
      await expect(reencryptConnector(connector.id, connector.version, actor)).rejects.toThrow();
      expect((await db.encryptedValue.findUniqueOrThrow({ where: { id: old.id } })).version).toBe(
        old.version,
      );
      process.env.MANAGED_TEST_A = material;
      expect((await reencryptConnector(connector.id, connector.version, actor)).count).toBe(2);
      expect((await db.encryptedValue.findUniqueOrThrow({ where: { id: old.id } })).keyId).toBe(
        second.id,
      );
    });
    it("binds selections to configuration versions and never returns credentials", async () => {
      const f = await ready();
      await expect(ownedConnection(db, f.id, { ...actor, id: "different-user" })).rejects.toThrow(
        "not found",
      );
      await expect(getAttempt({ ...actor, id: "different-user" }, f.attempt.id)).rejects.toThrow(
        "not found",
      );
      expect(JSON.stringify(await listConnections(actor))).not.toMatch(
        /never-public|credentialId|ciphertext|secretId/,
      );
      expect(JSON.stringify(await listConfiguration())).not.toMatch(
        /never-public|ciphertext|fingerprint/,
      );
      const a = await startConnection(actor, { connector: f.key, name: `${f.key}-new` });
      await transaction((tx) =>
        mutateConnector(
          tx,
          { ...config(f.key), enabled: true, allowedScopes: [read], defaultScopes: [] },
          f.connector.id,
          f.connector.version,
          actor,
        ),
      );
      await expect(submitSelection(actor, a.id, selected)).rejects.toThrow("configuration changed");
    });
    it("keeps stable identity on reconnect and rejects replay or account switching", async () => {
      const f = await ready();
      const next = await authorize(f.key, f.key, f.id);
      vi.mocked(completeGoogle).mockResolvedValueOnce({
        accountId: "other-account",
        accountName: "other@example.com",
        credentials: credentials(),
      });
      expect(await completeConnection(next.state, "code", false)).toBe("failed");
      expect((await db.connection.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("READY");
      expect((await getAttempt(actor, next.attempt.id)).status).toBe("NEEDS_REVOCATION");
      const successful = await authorize(f.key, f.key, f.id);
      vi.mocked(completeGoogle).mockResolvedValueOnce({
        accountId: "google-account",
        accountName: "google@example.com",
        credentials: credentials(),
      });
      expect(await completeConnection(successful.state, "code", false)).toBe("success");
      expect((await getAttempt(actor, successful.attempt.id)).connection?.id).toBe(f.id);
      await expect(completeConnection(successful.state, "code", false)).rejects.toThrow(
        "already used",
      );
    });
    it("refreshes centrally, preserves reduced grants and blocks failed revocation until manual retry", async () => {
      const f = await ready();
      const row = await db.connection.findUniqueOrThrow({ where: { id: f.id } });
      await saveSecret(
        db,
        f.logical.id,
        `connection:${f.id}:credentials`,
        JSON.stringify({ ...credentials(), expiresAt: 0 }),
        row.credentialId,
      );
      vi.mocked(refreshGoogle).mockResolvedValueOnce({
        ...credentials(),
        refreshToken: "rotated",
        grantedScopes: requiredScopes,
      });
      await accessCredentials(actor, f.id);
      expect((await db.connection.findUniqueOrThrow({ where: { id: f.id } })).status).toBe(
        "RECONNECT_REQUIRED",
      );
      vi.mocked(revokeGoogle).mockRejectedValueOnce(new Error("provider unavailable"));
      expect((await disconnect(actor, f.id)).status).toBe("REVOCATION_PENDING");
      await expect(accessCredentials(actor, f.id)).rejects.toThrow("not ready");
      expect(
        (await db.connection.findUniqueOrThrow({ where: { id: f.id } })).credentialId,
      ).not.toBeNull();
      vi.mocked(revokeGoogle).mockResolvedValueOnce();
      expect((await disconnect(actor, f.id)).status).toBe("DISCONNECTED");
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
      await disconnect(actor, f.id);
      const blocked = await db.connection.findUniqueOrThrow({ where: { id: f.id } });
      await discardConnection(actor, f.id, blocked.version);
      const result = await disconnect(actor, f.id);
      expect(result).toMatchObject({ status: "DISCONNECTED", revocationConfirmed: false });
      expect(
        await db.encryptedValue.findUnique({ where: { id: blocked.credentialId! } }),
      ).toBeNull();
      await expect(accessCredentials(actor, f.id)).rejects.toThrow("not ready");
      const next = await authorize(f.key, f.key, f.id);
      vi.mocked(completeGoogle).mockResolvedValueOnce({
        accountId: "google-account",
        accountName: "google@example.com",
        credentials: credentials(),
      });
      expect(await completeConnection(next.state, "code", false)).toBe("success");
      expect((await getAttempt(actor, next.attempt.id)).connection?.id).toBe(f.id);
    });
    it("keeps an in-flight refresh unavailable after disconnect and retains rotation for explicit revocation", async () => {
      const f = await ready();
      const row = await db.connection.findUniqueOrThrow({ where: { id: f.id } });
      await saveSecret(
        db,
        f.logical.id,
        `connection:${f.id}:credentials`,
        JSON.stringify({ ...credentials(), expiresAt: 0 }),
        row.credentialId,
      );
      const entered = Promise.withResolvers<void>();
      const result = Promise.withResolvers<ReturnType<typeof credentials>>();
      vi.mocked(refreshGoogle).mockImplementationOnce(() => {
        entered.resolve();
        return result.promise;
      });
      const refreshing = accessCredentials(actor, f.id);
      await entered.promise;
      expect((await disconnect(actor, f.id)).status).toBe("REVOCATION_PENDING");
      expect(revokeGoogle).not.toHaveBeenCalled();
      result.resolve({ ...credentials(), refreshToken: "rotated-while-disconnecting" });
      await refreshing;
      expect((await db.connection.findUniqueOrThrow({ where: { id: f.id } })).status).toBe(
        "REVOCATION_PENDING",
      );
      await expect(accessCredentials(actor, f.id)).rejects.toThrow("not ready");
      vi.mocked(revokeGoogle).mockResolvedValueOnce();
      expect((await disconnect(actor, f.id)).status).toBe("DISCONNECTED");
      expect(revokeGoogle).toHaveBeenCalledWith("rotated-while-disconnecting");
    });
    it("does not let stale callbacks undo disconnect", async () => {
      const f = await ready();
      const next = await authorize(f.key, f.key, f.id);
      vi.mocked(revokeGoogle).mockResolvedValueOnce();
      await disconnect(actor, f.id);
      vi.mocked(completeGoogle).mockResolvedValueOnce({
        accountId: "google-account",
        accountName: "google@example.com",
        credentials: credentials(),
      });
      expect(await completeConnection(next.state, "code", false)).toBe("failed");
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
      const planned = async () => createPlan(manifest, await loadPlanningState(db, manifest));
      expect((await planned()).actions[0]?.action).toBe("noop");
      await transaction((tx) =>
        mutateConnector(
          tx,
          { ...config(f.key), enabled: true, name: "UI edit" },
          f.connector.id,
          f.connector.version,
          actor,
        ),
      );
      expect((await planned()).actions[0]).toMatchObject({ action: "update", drift: true });
      await transaction((tx) =>
        mutateConnector(
          tx,
          manifest.connectors.google,
          f.connector.id,
          f.connector.version + 1,
          actor,
        ),
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
      const response = await executeConnection(
        new Request(url, {
          headers: {
            "x-weldall-connection": f.id,
            authorization: "DPoP weldall",
            dpop: "proof",
            cookie: "private",
          },
        }),
        actor,
        f.key,
        "/calendar/v3/calendars/primary/events",
      );
      expect(await response.json()).toEqual({ items: [] });
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("authorization")).toBeNull();
      expect(fetcher.mock.calls[0]?.[0].origin).toBe("https://www.googleapis.com");
      expect(fetcher.mock.calls[0]?.[1].headers.get("authorization")).toBe(
        "Bearer never-public-access",
      );
      expect(fetcher.mock.calls[0]?.[1].headers.get("dpop")).toBeNull();
      await expect(
        executeConnection(
          new Request(url, { method: "POST", headers: { "x-weldall-connection": f.id } }),
          actor,
          f.key,
          "/gmail/v1/users/me/messages/send",
        ),
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
      await setClientSecret(connector.id, "iac-secret", connector.version, actor);
      connector = await db.connector.findUniqueOrThrow({ where: { id: connector.id } });
      await transaction((tx) =>
        mutateConnector(
          tx,
          { ...config(name), name: "UI changed" },
          connector.id,
          connector.version,
          actor,
        ),
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
