import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, ensureSystemScopes } from "@weldall/db";
import { generateEs256KeyPair } from "@weldall/sdk";
import { calculateJwkThumbprint } from "jose";
import { parseDesiredState, type DesiredState } from "../src/server/iac/contracts";
import {
  planIac,
  applyIac,
  importIac,
  moveIacState,
  unmanageIac,
  getIacState,
  type IacActor,
} from "../src/server/iac/service";
import {
  rotateSharedConnectionCredential,
  setSharedConnectionEnabled,
} from "../src/server/connectors/core/shared-connections";
import { getConnectionDetails, deleteConnection } from "../src/server/connectors/core/connections";
import * as sharedConfiguration from "../src/server/connectors/core/shared-connections";
import { resolveUsableConnection } from "../src/server/connectors/core/connection-access";
import {
  updateGroupProvider,
  getGroupProvider,
  testGroupProvider,
} from "../src/server/group-providers/service";
import { saveLoginProvider } from "../src/server/admin/login-providers";
import { publicLoginProviders, currentProvider } from "../src/server/auth/login-service";
import { publicLoginProvider } from "../src/server/domain/secret-primitive-contracts";

const discovery = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../src/server/auth/oidc-runtime", () => ({ discover: discovery }));
const approved =
  /^postgresql:\/\/postgres@localhost:5433\/weldall_connector_test_[a-f0-9]{32}$/.test(
    process.env.POSTGRES_URL ?? "",
  ) ||
  (process.env.CI === "true" &&
    process.env.POSTGRES_URL === "postgresql://postgres:postgres@localhost:5432/postgres");
const prefix = `iac-secret-${randomBytes(6).toString("hex")}`;
const admin = {
  id: prefix,
  email: `${prefix}@example.com`,
  requestId: prefix,
  type: "user" as const,
  scopeKeys: [],
};
const actor: IacActor = {
  clientId: `${prefix}-runner`,
  keyId: "current",
  keyThumbprint: "",
  requestId: prefix,
};
const workspaces: string[] = [],
  loginIds: string[] = [];
let originalInstallation: any;
let originallyEnabled: string[] = [];
const workspace = () => {
  const id = randomUUID();
  workspaces.push(id);
  return { id, name: `${prefix}-${workspaces.length}`, issuer: "https://weldall.example.com" };
};
const login = () => {
  const id = randomUUID();
  loginIds.push(id);
  return {
    id,
    name: "Draft login",
    buttonLabel: "Test login",
    buttonColor: "#112233",
    sortOrder: 0,
    issuer: "https://id.example.com",
    clientId: "fixture-client",
    tokenEndpointAuthMethod: "client_secret_post" as const,
    scopes: ["openid", "email"],
    allowedEmailDomains: [],
    enabled: false,
  };
};
const manifest = () => {
  const ws = workspace();
  const key = `${prefix}-${workspaces.length}`;
  return parseDesiredState({
    apiVersion: "weldall.dev/v1",
    workspace: ws,
    scopes: { use: { key: `${key}:use`, description: "Fixture use" } },
    connectors: {
      mcp: {
        key,
        name: "Disabled MCP",
        type: "atlassian-mcp",
        enabled: false,
        envelopeProvider: "LOCAL_ENV",
        requiredScopes: [],
        provider: { allowedScopes: ["read:jira:agent-interface"], defaultScopes: [] },
      },
    },
    sharedConnections: {
      bot: {
        key,
        connectorKey: key,
        name: "Bot",
        enabled: false,
        useScopes: [`${key}:use`],
        credentialManagerEmail: admin.email,
        serviceAccountLabel: "Fixture account",
        provider: { kind: "service-account-api-key", cloudIds: [] },
      },
    },
    groupProviders: {
      directory: {
        key,
        name: "Directory",
        adapterType: "management-api-v1",
        baseUrl: "https://directory.example.com",
        enabled: false,
      },
    },
    groupAssignments: { group: { provider: key, groupId: "fixture", scopes: [`${key}:use`] } },
    loginProviders: { sso: login() },
  });
};
async function apply(m: DesiredState, approval = false) {
  const plan = await planIac(m);
  expect(plan.blockers).toEqual([]);
  return applyIac(
    {
      manifest: m,
      plannedRevision: plan.revision,
      configDigest: plan.configDigest,
      planDigest: plan.digest,
      operationId: randomUUID(),
      ...(approval ? { authorityConfirmation: plan.digest } : {}),
    },
    actor,
  );
}
async function rows(m: DesiredState) {
  return {
    shared: await db.connection.findUniqueOrThrow({
      where: { key: m.sharedConnections!.bot!.key },
    }),
    group: await db.groupProvider.findUniqueOrThrow({
      where: { key: m.groupProviders!.directory!.key },
    }),
    login: await db.loginProvider.findUniqueOrThrow({ where: { id: m.loginProviders!.sso!.id } }),
  };
}
async function provision(m: DesiredState) {
  const before = await rows(m);
  await rotateSharedConnectionCredential(
    {
      id: before.shared.id,
      version: before.shared.version,
      providerInput: { apiKey: "fixture-static-secret" },
    },
    admin,
  );
  await updateGroupProvider(
    {
      id: before.group.id,
      expectedVersion: before.group.version,
      name: before.group.name,
      baseUrl: before.group.baseUrl,
      enabled: false,
      token: "fixture-directory-token",
    },
    admin,
  );
  const { id, enabled, ...config } = publicLoginProvider(before.login);
  await saveLoginProvider({ userId: admin.id, sessionId: prefix }, prefix, {
    providerId: id,
    expectedVersion: before.login.version,
    enabled,
    config: { ...config, clientSecret: "fixture-client-secret" },
    acknowledgeAuthority: false,
    acknowledgeLockout: false,
  });
  return rows(m);
}

describe.skipIf(!approved)("UI-only IaC secret primitives on disposable PostgreSQL", () => {
  beforeAll(async () => {
    vi.stubEnv("WELDALL_CONNECTOR_KEK", randomBytes(32).toString("base64"));
    vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    await ensureSystemScopes(db, prefix);
    await db.user.create({
      data: { id: admin.id, email: admin.email, name: "IaC test admin", emailVerified: true },
    });
    await db.session.create({
      data: {
        id: prefix,
        token: randomUUID(),
        userId: admin.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    await db.emailScopeAssignment.create({
      data: {
        normalizedEmail: admin.email,
        createdBy: prefix,
        updatedBy: prefix,
        grants: {
          create: [
            { scope: { connect: { key: "weldall:administer" } }, createdBy: prefix },
            { scope: { connect: { key: "weldall:login" } }, createdBy: prefix },
          ],
        },
      },
    });
    const key = await generateEs256KeyPair();
    actor.keyThumbprint = await calculateJwkThumbprint(key.publicJwk);
    await db.machineClient.create({
      data: {
        clientId: actor.clientId,
        name: prefix,
        enabled: true,
        createdBy: prefix,
        updatedBy: prefix,
        keys: {
          create: {
            kid: actor.keyId,
            thumbprint: actor.keyThumbprint,
            publicJwk: JSON.parse(JSON.stringify(key.publicJwk)),
            createdBy: prefix,
          },
        },
        allowedScopes: { create: { scope: { connect: { key: "weldall:iac" } } } },
      },
    });
    originallyEnabled = (
      await db.loginProvider.findMany({ where: { enabled: true }, select: { id: true } })
    ).map(({ id }) => id);
    await db.loginProvider.updateMany({
      where: { id: { in: originallyEnabled } },
      data: { enabled: false },
    });
    originalInstallation = await db.loginInstallation.findUniqueOrThrow({
      where: { id: "default" },
    });
    await db.loginInstallation.update({
      where: { id: "default" },
      data: { state: "COMPLETED", completedAdminUserId: admin.id, completedAt: new Date() },
    });
  });
  afterAll(async () => {
    if (!approved) return;
    for (const row of await db.connection.findMany({
      where: { connector: { key: { startsWith: prefix } } },
      select: { id: true },
    }))
      await deleteConnection({ id: row.id, actor: admin });
    await db.iacWorkspace.deleteMany({ where: { id: { in: workspaces } } });
    await db.connector.deleteMany({ where: { key: { startsWith: prefix } } });
    await db.groupScopeAssignment.deleteMany({
      where: { provider: { key: { startsWith: prefix } } },
    });
    await db.groupProvider.deleteMany({ where: { key: { startsWith: prefix } } });
    await db.loginProvider.deleteMany({ where: { id: { in: loginIds } } });
    await db.loginProvider.updateMany({
      where: { id: { in: originallyEnabled } },
      data: { enabled: true },
    });
    await db.scope.deleteMany({ where: { key: { startsWith: prefix } } });
    await db.machineClient.deleteMany({ where: { clientId: actor.clientId } });
    await db.emailScopeAssignment.deleteMany({ where: { normalizedEmail: admin.email } });
    if (originalInstallation)
      await db.loginInstallation.update({
        where: { id: "default" },
        data: {
          state: originalInstallation.state,
          completedAdminUserId: originalInstallation.completedAdminUserId,
          completedAt: originalInstallation.completedAt,
        },
      });
    await db.user.deleteMany({ where: { id: admin.id } });
    await db.auditEvent.deleteMany({ where: { requestId: prefix } });
    vi.unstubAllEnvs();
  });

  it("creates complete disabled stacks without credentials, fake grants or discovery and produces a no-op", async () => {
    const m = manifest();
    discovery.mockClear();
    await apply(m);
    const saved = await rows(m);
    expect(saved.shared).toMatchObject({
      enabled: false,
      credentialId: null,
      providerGrant: {},
      ownerId: admin.id,
    });
    expect(saved.group).toMatchObject({ enabled: false, encryptedToken: null });
    expect(saved.login).toMatchObject({
      enabled: false,
      encryptedClientSecret: null,
      validatedAt: null,
    });
    expect(discovery).not.toHaveBeenCalled();
    expect((await planIac(m)).actions.every((a) => a.action === "noop")).toBe(true);
    expect(await getConnectionDetails(saved.shared.id)).toMatchObject({
      enabled: false,
      hasCredential: false,
      readiness: "MISSING_CREDENTIAL",
      management: { type: "iac" },
    });
    expect(await getGroupProvider(saved.group.id)).toMatchObject({
      hasToken: false,
      readiness: "MISSING_CREDENTIAL",
    });
    expect((await publicLoginProviders()).some((p) => p.id === saved.login.id)).toBe(false);
    await expect(currentProvider(saved.login.id)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    await expect(
      resolveUsableConnection({ selector: saved.shared.key!, actor: admin }),
    ).rejects.toMatchObject({ code: "connection_denied" });
    const audits = await db.auditEvent.findMany({ where: { subjectId: saved.shared.id } });
    expect(audits[0]).toMatchObject({ actorType: "machine", actorId: actor.clientId });
  });
  it("blocks missing credentials and unknown custodians in plan and apply without partial writes", async () => {
    const m = manifest();
    m.sharedConnections!.bot!.enabled = true;
    m.groupProviders!.directory!.enabled = true;
    m.loginProviders!.sso!.enabled = true;
    m.sharedConnections!.bot!.credentialManagerEmail = "unknown@example.com";
    const plan = await planIac(m);
    expect(plan.blockers.filter((b) => b.code === "MISSING_CREDENTIAL")).toHaveLength(3);
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "UNKNOWN_CUSTODIAN" }));
    await expect(
      applyIac(
        {
          manifest: m,
          plannedRevision: plan.revision,
          configDigest: plan.configDigest,
          planDigest: plan.digest,
          operationId: randomUUID(),
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "PLAN_BLOCKED" });
    expect(await db.iacWorkspace.findUnique({ where: { id: m.workspace.id } })).toBeNull();
  });
  it("never interprets an old client's omitted sections as deletion", async () => {
    const m = manifest();
    await apply(m);
    const {
      sharedConnections: _shared,
      groupProviders: _groups,
      loginProviders: _logins,
      ...old
    } = m;
    const plan = await planIac(old);
    expect(plan.blockers.filter((b) => b.code === "CLIENT_UPGRADE_REQUIRED")).toHaveLength(3);
    await expect(
      applyIac(
        {
          manifest: old,
          plannedRevision: plan.revision,
          configDigest: plan.configDigest,
          planDigest: plan.digest,
          operationId: randomUUID(),
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "PLAN_BLOCKED" });
    expect((await getIacState(m.workspace.id)).objects).toHaveLength(6);
  });
  it("UI provisioning preserves disabled intent, rotation stales plans but not public desired content", async () => {
    const m = manifest();
    await apply(m);
    const stale = await planIac(m);
    const saved = await provision(m);
    expect(saved.shared.enabled || saved.group.enabled || saved.login.enabled).toBe(false);
    expect(
      saved.shared.credentialId && saved.group.encryptedToken && saved.login.encryptedClientSecret,
    ).toBeTruthy();
    expect(discovery).toHaveBeenCalled();
    await expect(
      applyIac(
        {
          manifest: m,
          plannedRevision: stale.revision,
          configDigest: stale.configDigest,
          planDigest: stale.digest,
          operationId: randomUUID(),
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "STALE_PLAN" });
    const plan = await planIac(m);
    expect(plan.actions.every((a) => a.action === "noop")).toBe(true);
    await apply(m);
    expect(await rows(m)).toEqual(saved);
    for (const value of [plan, await getIacState(m.workspace.id)]) {
      const encoded = JSON.stringify(value);
      for (const marker of [
        "fixture-static-secret",
        "fixture-directory-token",
        "fixture-client-secret",
        saved.group.encryptedToken!,
        saved.login.encryptedClientSecret!,
      ])
        expect(encoded).not.toContain(marker);
    }
    // A policy change must never carry a credential to a new endpoint.
    const changed = structuredClone(m);
    changed.groupProviders!.directory!.baseUrl = "https://attacker.example.com";
    expect((await planIac(changed)).blockers).toContainEqual(
      expect.objectContaining({ code: "CREDENTIAL_BINDING" }),
    );
    await expect(
      testGroupProvider({ id: saved.group.id, baseUrl: "https://attacker.example.com" }, admin),
    ).rejects.toThrow("replacement token");
    changed.loginProviders!.sso!.clientId = "different-client";
    expect(
      (await planIac(changed)).blockers.filter((b) => b.code === "CREDENTIAL_BINDING"),
    ).toHaveLength(2);
  });
  it("requires fresh plan-bound identity approval server-side and never disables the final provider", async () => {
    const m = manifest();
    await apply(m);
    await provision(m);
    m.loginProviders!.sso!.enabled = true;
    const plan = await planIac(m);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        address: "loginProvider.sso",
        requiresAuthorityConfirmation: true,
      }),
    );
    await expect(apply(m)).rejects.toMatchObject({ code: "AUTHORITY_CONFIRMATION_REQUIRED" });
    m.loginProviders!.sso!.buttonLabel = "Changed plan";
    const next = await planIac(m);
    await expect(
      applyIac(
        {
          manifest: m,
          plannedRevision: next.revision,
          configDigest: next.configDigest,
          planDigest: next.digest,
          authorityConfirmation: plan.digest,
          operationId: randomUUID(),
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_CONFIRMATION_REQUIRED" });
    await apply(m, true);
    expect((await publicLoginProviders()).some((p) => p.id === m.loginProviders!.sso!.id)).toBe(
      true,
    );
    const active = await db.loginProvider.findMany({ where: { enabled: true } });
    expect(active).toHaveLength(1);
    {
      const disabled = structuredClone(m);
      disabled.loginProviders!.sso!.enabled = false;
      expect((await planIac(disabled)).blockers).toContainEqual(
        expect.objectContaining({ code: "LAST_LOGIN_PROVIDER" }),
      );
      const deleted = structuredClone(m);
      deleted.loginProviders = {};
      expect((await planIac(deleted)).blockers).toContainEqual(
        expect.objectContaining({ code: "LAST_LOGIN_PROVIDER" }),
      );
    }
    // Explicitly disable our fixture through the existing UI recovery route.
    const row = (await rows(m)).login;
    const { id, enabled: _enabled, ...config } = publicLoginProvider(row);
    await saveLoginProvider({ userId: admin.id, sessionId: prefix }, prefix, {
      providerId: id,
      config,
      expectedVersion: row.version,
      enabled: false,
      acknowledgeAuthority: false,
      acknowledgeLockout: true,
    });
  });
  it.each([false, true])(
    "imports every kind (enabled=%s), preserves identities/ciphertexts through move and unmanage, and rejects foreign ownership",
    async (enabled) => {
      const m = manifest();
      m.groupAssignments = {};
      await apply(m);
      await provision(m);
      m.connectors.mcp!.enabled = enabled;
      m.sharedConnections!.bot!.enabled = enabled;
      m.groupProviders!.directory!.enabled = enabled;
      m.loginProviders!.sso!.enabled = enabled;
      await apply(m, enabled);
      const before = await rows(m);
      const entries = [
        ["connector", "mcp", "connectors", m.connectors.mcp!.key],
        ["sharedConnection", "bot", "sharedConnections", before.shared.key!],
        ["groupProvider", "directory", "groupProviders", before.group.key],
        ["loginProvider", "sso", "loginProviders", before.login.id],
      ] as const;
      const destination = parseDesiredState({ apiVersion: m.apiVersion, workspace: workspace() });
      for (const [kind, name, section, identity] of entries) {
        const address = `${kind}.${name}`;
        await expect(
          importIac(
            {
              workspace: destination.workspace,
              kind,
              identity,
              address,
              operationId: randomUUID(),
            },
            actor,
          ),
        ).rejects.toMatchObject({ code: "OWNED" });
        const without = structuredClone(m);
        delete (without[section] as any)[name];
        const plan = await planIac(without);
        await unmanageIac(
          {
            workspaceId: m.workspace.id,
            address,
            manifest: without,
            configDigest: plan.configDigest,
            operationId: randomUUID(),
          },
          actor,
        );
        const result: any = await importIac(
          { workspace: destination.workspace, kind, identity, address, operationId: randomUUID() },
          actor,
        );
        (destination as any)[section] = { [name]: result.state };
        await moveIacState(
          {
            workspaceId: destination.workspace.id,
            from: address,
            to: `${kind}.moved`,
            operationId: randomUUID(),
          },
          actor,
        );
        (destination as any)[section] = { moved: result.state };
      }
      expect(await rows(m)).toEqual(before);
      const plan = await planIac(destination);
      expect(plan.blockers).toEqual([]);
      expect(plan.actions.every((a) => a.action === "noop")).toBe(true);
    },
  );
  it("moves shared scope references before deleting old scopes and cleans the dependency graph atomically", async () => {
    const m = manifest();
    await apply(m);
    const saved = await provision(m);
    const prior = m.scopes.use!.key;
    m.scopes = { other: { key: `${prior}-other`, description: "Replacement" } };
    m.sharedConnections!.bot!.useScopes = [m.scopes.other!.key];
    m.groupAssignments.group!.scopes = [m.scopes.other!.key];
    await apply(m);
    expect(await db.scope.findUnique({ where: { key: prior } })).toBeNull();
    expect((await rows(m)).shared.credentialId).toBe(saved.shared.credentialId);
    await apply(
      parseDesiredState({
        apiVersion: m.apiVersion,
        workspace: m.workspace,
        sharedConnections: {},
        groupProviders: {},
        loginProviders: {},
      }),
    );
    expect((await getIacState(m.workspace.id)).objects).toEqual([]);
  });
  it.each([false, true])(
    "renames a scope at the same address with shared credentials intact (also replace directory=%s)",
    async (replaceDirectory) => {
      const m = manifest();
      await apply(m);
      const before = await provision(m);
      const credential = await db.encryptedValue.findUniqueOrThrow({
        where: { id: before.shared.credentialId! },
      });
      m.connectors.mcp!.enabled = true;
      m.sharedConnections!.bot!.enabled = true;
      await apply(m);
      const oldKey = m.scopes.use!.key;
      m.scopes.use!.key = `${oldKey}-renamed`;
      m.sharedConnections!.bot!.useScopes = [m.scopes.use!.key];
      m.sharedConnections!.new_bot = {
        ...m.sharedConnections!.bot!,
        key: `${m.sharedConnections!.bot!.key}-new`,
        enabled: false,
      };
      m.groupAssignments.group!.scopes = [m.scopes.use!.key];
      if (replaceDirectory) {
        m.groupProviders!.directory!.key += "-renamed";
        m.groupAssignments.group!.provider = m.groupProviders!.directory!.key;
      }
      await apply(m);
      expect(await db.scope.findUnique({ where: { key: oldKey } })).toBeNull();
      const after = await rows(m);
      expect(after.shared.id).toBe(before.shared.id);
      expect(after.shared.credentialId).toBe(before.shared.credentialId);
      expect(after.shared.enabled).toBe(true);
      expect(await db.encryptedValue.findUniqueOrThrow({ where: { id: credential.id } })).toEqual(
        credential,
      );
      for (const config of Object.values(m.sharedConnections!)) {
        const row = await db.connection.findUniqueOrThrow({
          where: { key: config.key },
          include: { useScopes: { include: { scope: true } } },
        });
        expect(row.useScopes.map(({ scope }) => scope.key)).toEqual([m.scopes.use!.key]);
      }
      expect((await planIac(m)).actions.every((a) => a.action === "noop")).toBe(true);
      if (replaceDirectory)
        expect(await db.groupProvider.findUnique({ where: { id: before.group.id } })).toBeNull();
    },
  );
  it("replaces a group provider at the same address after moving its managed assignments", async () => {
    const m = manifest();
    await apply(m);
    const before = await provision(m);
    m.groupProviders!.directory!.key += "-renamed";
    m.groupAssignments.group!.provider = m.groupProviders!.directory!.key;
    await apply(m);
    const after = await rows(m);
    expect(after.group.id).not.toBe(before.group.id);
    expect(after.group.encryptedToken).toBeNull();
    expect(await db.groupProvider.findUnique({ where: { id: before.group.id } })).toBeNull();
    expect(await db.groupScopeAssignment.count({ where: { providerId: after.group.id } })).toBe(1);
    expect((await planIac(m)).actions.every((a) => a.action === "noop")).toBe(true);
  });
  it("rolls back staged scope links and provider replacements when the final connection write fails", async () => {
    const original = manifest();
    await apply(original);
    const before = await provision(original);
    const state = await getIacState(original.workspace.id);
    const m = structuredClone(original);
    m.scopes.use!.key += "-renamed";
    m.sharedConnections!.bot!.useScopes = [m.scopes.use!.key];
    m.groupProviders!.directory!.key += "-renamed";
    m.groupAssignments.group!.provider = m.groupProviders!.directory!.key;
    m.groupAssignments.group!.scopes = [m.scopes.use!.key];
    const write = vi
      .spyOn(sharedConfiguration, "saveSharedConnectionConfiguration")
      .mockImplementationOnce(async ({ tx }) => {
        expect(
          await tx.connectionUseScope.count({ where: { connectionId: before.shared.id } }),
        ).toBe(0);
        expect(await tx.scope.findUnique({ where: { key: m.scopes.use!.key } })).not.toBeNull();
        expect(
          await tx.groupProvider.findUnique({ where: { key: m.groupProviders!.directory!.key } }),
        ).not.toBeNull();
        throw new Error("late connection write failure");
      });
    try {
      await expect(apply(m)).rejects.toThrow("late connection write failure");
      expect(write).toHaveBeenCalledOnce();
      expect(await rows(original)).toEqual(before);
      expect(await getIacState(original.workspace.id)).toEqual(state);
      expect(await db.scope.findUnique({ where: { key: m.scopes.use!.key } })).toBeNull();
      expect(
        await db.groupProvider.findUnique({ where: { key: m.groupProviders!.directory!.key } }),
      ).toBeNull();
    } finally {
      write.mockRestore();
    }
  });
  it("still blocks replacing a group provider with unmanaged assignments", async () => {
    const m = manifest();
    await apply(m);
    const before = await rows(m);
    await db.groupScopeAssignment.create({
      data: {
        providerId: before.group.id,
        groupId: "unmanaged",
        createdBy: prefix,
        updatedBy: prefix,
      },
    });
    m.groupProviders!.directory!.key += "-renamed";
    m.groupAssignments.group!.provider = m.groupProviders!.directory!.key;
    const plan = await planIac(m);
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "EXTERNAL_REFERENCE" }));
    await expect(
      applyIac(
        {
          manifest: m,
          plannedRevision: plan.revision,
          configDigest: plan.configDigest,
          planDigest: plan.digest,
          operationId: randomUUID(),
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: "PLAN_BLOCKED" });
    expect(await db.groupProvider.findUnique({ where: { id: before.group.id } })).toEqual(
      before.group,
    );
    expect(
      await db.groupProvider.findUnique({ where: { key: m.groupProviders!.directory!.key } }),
    ).toBeNull();
  });
  it("recreates deleted drafts with tombstones but blocks credentialless enabled restoration", async () => {
    const m = manifest();
    await apply(m);
    const before = await rows(m);
    await deleteConnection({ id: before.shared.id, actor: admin });
    const state = await getIacState(m.workspace.id);
    expect(state.objects.find((o) => o.kind === "sharedConnection")?.tombstone).toBe(true);
    m.sharedConnections!.bot!.enabled = true;
    expect((await planIac(m)).blockers).toContainEqual(
      expect.objectContaining({ code: "MISSING_CREDENTIAL" }),
    );
    m.sharedConnections!.bot!.enabled = false;
    await apply(m);
    expect((await rows(m)).shared.id).not.toBe(before.shared.id);
    await db.loginProvider.delete({ where: { id: before.login.id } });
    await apply(m);
    expect((await rows(m)).login).toMatchObject({
      id: before.login.id,
      encryptedClientSecret: null,
      validatedAt: null,
    });
  });
  it("creates and plans OpenBao drafts without contacting OpenBao; failed provisioning leaves them untouched", async () => {
    const m = manifest();
    m.connectors.mcp!.envelopeProvider = "OPENBAO";
    vi.stubEnv("WELDALL_OPENBAO_HOST", "");
    vi.stubEnv("WELDALL_OPENBAO_TOKEN", "");
    await apply(m);
    const before = await rows(m);
    expect((await planIac(m)).blockers).toEqual([]);
    await expect(
      rotateSharedConnectionCredential(
        {
          id: before.shared.id,
          version: before.shared.version,
          providerInput: { apiKey: "fixture-secret" },
        },
        admin,
      ),
    ).rejects.toThrow();
    expect(await rows(m)).toEqual(before);
  });
  it("does not repair credential errors by toggling enabled and never grants invocation rights to the custodian", async () => {
    const m = manifest();
    await apply(m);
    const row = (await provision(m)).shared;
    await db.connection.update({ where: { id: row.id }, data: { status: "RECONNECT_REQUIRED" } });
    await setSharedConnectionEnabled({ id: row.id, version: row.version, enabled: true }, admin);
    expect(await getConnectionDetails(row.id)).toMatchObject({
      enabled: true,
      status: "RECONNECT_REQUIRED",
    });
    await expect(
      resolveUsableConnection({ selector: row.key!, actor: admin }),
    ).rejects.toMatchObject({ code: "connection_denied" });
  });
});
