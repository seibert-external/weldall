import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, ensureSystemScopes } from "@weldall/db";
import {
  createWeldallMcpClient,
  createDpopProof,
  generateEs256KeyPair,
  requestMachineToken,
  type DpopKeyPair,
} from "@weldall/sdk";
import { scopeKeySchema } from "../src/server/policy/scope-key";
import {
  createSharedConnection,
  updateSharedConnectionAccess,
  rotateSharedConnectionCredential,
  setSharedConnectionEnabled,
} from "../src/server/connectors/core/shared-connections";
import {
  deleteConnection,
  listAccessibleConnections,
  getConnectionDetails,
  findOwnedConnection,
} from "../src/server/connectors/core/connections";
import {
  prepareConnectionAccess,
  resolveUsableConnection,
} from "../src/server/connectors/core/connection-access";
import { authorizeConnectionUse } from "../src/server/connectors/core/authorization";
import {
  saveConnectorConfiguration,
  runConnectorTransaction,
} from "../src/server/connectors/configuration";
import { parseDesiredState } from "../src/server/iac/contracts";
import { createPlan, loadPlanningState } from "../src/server/iac/planner";
import { mutateScope } from "../src/server/domain/primitive-mutations";
import { WELDALL_ISSUER, WELDALL_RESOURCE } from "../src/server/oauth/constants";
import { authenticateConnectorRuntimeActor } from "../src/server/connectors/http";
import { startMcpFixture, FIXTURE_AUTHORIZATION, type McpFixture } from "./fixtures/mcp-server";

const network = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock("../src/server/connectors/core/secure-fetch", () => ({
  resolvePublicIpv4: vi.fn(async () => "93.184.216.34"),
  createPinnedFetch: () => network.fetch,
}));
const approved =
  /^postgresql:\/\/postgres@localhost:5433\/weldall_connector_test_[a-f0-9]{32}$/.test(
    process.env.POSTGRES_URL ?? "",
  ) ||
  (process.env.CI === "true" &&
    process.env.POSTGRES_URL === "postgresql://postgres:postgres@localhost:5432/postgres");
const prefix = `shared-${randomBytes(6).toString("hex")}`;
const manager = {
  id: prefix,
  email: `${prefix}@example.com`,
  type: "user" as const,
  requestId: prefix,
  scopeKeys: [],
};
const user = {
  ...manager,
  id: `${prefix}-user`,
  email: `${prefix}-user@example.com`,
  scopeKeys: [`${prefix}:use`, `${prefix}:connector`].map((key) => scopeKeySchema.parse(key)),
};
let connectorId: string, machineId: string;
let key: DpopKeyPair;
let upstream: McpFixture;
const secret = "fixture-service-account-key-do-not-log";
const providerInput = {
  kind: "service-account-api-key",
  apiKey: secret,
  cloudIds: [],
};
let sequence = 0;
const input = () => ({
  connectorId,
  key: `${prefix}-${++sequence}`,
  name: "Repeated display label",
  useScopeKeys: [user.scopeKeys[0]!],
  providerInput,
});
const scopes = () => ["weldall:mcp", ...user.scopeKeys];
async function token(requested = scopes()) {
  return requestMachineToken({
    issuer: WELDALL_ISSUER,
    resource: WELDALL_RESOURCE,
    clientId: `${prefix}-machine`,
    kid: "current",
    key,
    scopes: requested,
    fetch: async (url, init) =>
      (await import("../src/server/oauth/facade")).tokenFacade(new Request(url, init)),
  });
}
async function machineActor(accessToken: string) {
  const url = `${WELDALL_ISSUER}/api/me/mcp/connections`;
  return authenticateConnectorRuntimeActor({
    request: new Request(url, {
      headers: {
        authorization: `DPoP ${accessToken}`,
        dpop: await createDpopProof({ ...key, url, method: "GET", accessToken }),
      },
    }),
  });
}
const resolve = (selector: string, actor: Parameters<typeof resolveUsableConnection>[0]["actor"]) =>
  resolveUsableConnection({ selector, actor });

describe.skipIf(!approved)("shared connections on approved disposable PostgreSQL", () => {
  beforeAll(async () => {
    vi.stubEnv("WELDALL_CONNECTOR_KEK", randomBytes(32).toString("base64"));
    const signing = await generateEs256KeyPair();
    vi.stubEnv("WELDALL_SIGNING_PRIVATE_JWK", JSON.stringify(signing.privateJwk));
    vi.stubEnv("WELDALL_SIGNING_PUBLIC_JWK", JSON.stringify(signing.publicJwk));
    vi.stubEnv("WELDALL_SIGNING_KID", "shared-mcp-test");
    await ensureSystemScopes(db, manager.id);
    for (const actor of [manager, user])
      await db.user.create({
        data: { id: actor.id, email: actor.email, name: "Fixture", emailVerified: true },
      });
    for (const scope of user.scopeKeys)
      await db.scope.create({
        data: {
          key: scope,
          description: "Shared fixture",
          createdBy: manager.id,
          updatedBy: manager.id,
        },
      });
    for (const actor of [manager, user]) {
      const keys =
        actor === manager
          ? ["weldall:login", "weldall:administer"]
          : ["weldall:login", ...user.scopeKeys];
      const rows = await db.scope.findMany({ where: { key: { in: keys } } });
      await db.emailScopeAssignment.create({
        data: {
          normalizedEmail: actor.email,
          createdBy: manager.id,
          updatedBy: manager.id,
          grants: { create: rows.map((scope) => ({ scopeId: scope.id, createdBy: manager.id })) },
        },
      });
    }
    const connector = await runConnectorTransaction((tx) =>
      saveConnectorConfiguration({
        tx,
        actor: manager,
        id: undefined,
        expectedVersion: null,
        value: {
          key: prefix,
          name: "Shared MCP",
          type: "atlassian-mcp",
          enabled: true,
          envelopeProvider: "LOCAL_ENV",
          requiredScopes: [user.scopeKeys[1]!],
          provider: { allowedScopes: ["read:jira:agent-interface"], defaultScopes: [] },
        },
      }),
    );
    connectorId = connector.id;
    key = await generateEs256KeyPair();
    const rows = await db.scope.findMany({ where: { key: { in: [...scopes(), "weldall:iac"] } } });
    const machine = await db.machineClient.create({
      data: {
        clientId: `${prefix}-machine`,
        name: "Fixture machine",
        createdBy: prefix,
        updatedBy: prefix,
        keys: {
          create: {
            kid: "current",
            publicJwk: key.publicJwk,
            thumbprint: key.jkt,
            createdBy: prefix,
          },
        },
        allowedScopes: { create: rows.map((scope) => ({ scopeId: scope.id })) },
      },
    });
    machineId = machine.id;
    upstream = await startMcpFixture();
    network.fetch.mockImplementation((url, init) => {
      expect(String(url)).toBe("https://mcp.atlassian.com/v2/mcp");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${secret}`);
      const headers = new Headers(init?.headers);
      headers.set("authorization", FIXTURE_AUTHORIZATION);
      return fetch(upstream.endpoint, { ...init, headers });
    });
  });
  afterAll(async () => {
    await upstream?.close();
    const rows = await db.connection.findMany({
      where: { ownerId: { in: [manager.id, user.id] } },
    });
    for (const row of rows) await deleteConnection({ actor: manager, id: row.id });
    await db.connector.deleteMany({ where: { id: connectorId } });
    await db.machineClient.deleteMany({ where: { id: machineId } });
    await db.emailScopeAssignment.deleteMany({
      where: { normalizedEmail: { in: [manager.email, user.email] } },
    });
    await db.scope.deleteMany({ where: { createdBy: manager.id, isSystem: false } });
    await db.user.deleteMany({ where: { id: { in: [manager.id, user.id] } } });
    await db.auditEvent.deleteMany({
      where: {
        OR: [{ requestId: prefix }, { actorId: machineId }, { actorId: `${prefix}-machine` }],
      },
    });
    vi.unstubAllEnvs();
  });
  it("requires admin, unique stable key and non-system nonempty use scopes without OAuth attempts", async () => {
    await expect(createSharedConnection(input(), user)).rejects.toMatchObject({
      code: "forbidden",
    });
    for (const useScopeKeys of [[], ["missing:scope"], ["weldall:mcp"], ["weldall:login"]])
      await expect(createSharedConnection({ ...input(), useScopeKeys }, manager)).rejects.toThrow();
    await expect(
      createSharedConnection(
        { ...input(), providerInput: { ...providerInput, apiKey: "" } },
        manager,
      ),
    ).rejects.toThrow();
    const value = input();
    const created = await createSharedConnection(value, manager);
    await expect(createSharedConnection(value, manager)).rejects.toMatchObject({
      code: "key_exists",
    });
    await expect(createSharedConnection(input(), manager)).resolves.toHaveProperty("id");
    expect(await db.connectionAuthorization.count({ where: { connectorId } })).toBe(0);
    const row = await getConnectionDetails(created.id);
    expect(row).toMatchObject({
      accessMode: "SCOPED",
      key: value.key,
      name: value.name,
      accountName: value.name,
      useScopes: value.useScopeKeys,
      grantedScopes: [],
    });
    expect(JSON.stringify(row)).not.toContain(secret);
    const stored = await db.encryptedValue.findFirst({ where: { connection: { id: created.id } } });
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(secret);
  });
  it("allows all-of use scopes, denies managers, personal names, missing and foreign IDs uniformly", async () => {
    const value = input();
    const created = await createSharedConnection(value, manager);
    const machine = await machineActor((await token()).accessToken);
    for (const actor of [user, machine])
      expect((await resolve(value.key, actor)).authorizationSource).toBe("scope");
    for (const [selector, actor] of [
      [value.key, manager],
      ["missing", user],
      [value.name, machine],
    ] as const)
      await expect(resolve(selector, actor)).rejects.toMatchObject({
        code: "connection_denied",
        status: 403,
      });
    await expect(
      findOwnedConnection({ tx: db, selector: created.id, actor: manager }),
    ).rejects.toThrow();
    const personal = await db.connection.create({
      data: {
        ownerId: user.id,
        connectorId,
        name: `${prefix}-personal`,
        accountId: "personal",
        accountName: "Personal",
        providerSelection: {},
        providerGrant: {},
      },
    });
    expect((await resolve(personal.id, user)).authorizationSource).toBe("owner");
    for (const actor of [manager, machine])
      await expect(resolve(personal.id, actor)).rejects.toMatchObject({
        code: "connection_denied",
      });
    const found = await listAccessibleConnections(machine);
    expect(found.some((row) => row.id === created.id)).toBe(true);
    expect(found.every((row) => row.accessMode === "SCOPED" && !("ownerId" in row))).toBe(true);
    const narrow = await machineActor(
      (await token(["weldall:mcp", user.scopeKeys[0]!])).accessToken,
    );
    await expect(resolve(value.key, narrow)).rejects.toMatchObject({ code: "connection_denied" });
    const missingUse = await machineActor(
      (await token(["weldall:mcp", user.scopeKeys[1]!])).accessToken,
    );
    await expect(resolve(value.key, missingUse)).rejects.toMatchObject({
      code: "connection_denied",
    });
    await expect(machineActor((await token(["weldall:iac"])).accessToken)).rejects.toThrow();
    await deleteConnection({ actor: manager, id: personal.id });
  });
  it("applies connector scopes before the runtime catalog limit", async () => {
    const first = await createSharedConnection(input(), manager);
    const second = await createSharedConnection(input(), manager);
    const blocked = await db.connector.create({
      data: {
        key: `${prefix}-blocked`,
        name: "Inaccessible connector",
        providerType: "atlassian-mcp",
        enabled: true,
        envelopeProvider: "LOCAL_ENV",
        createdBy: manager.id,
        updatedBy: manager.id,
        providerConfig: { allowedScopes: ["read:jira:agent-interface"], defaultScopes: [] },
        requiredScopes: { create: { scope: { connect: { key: "weldall:administer" } } } },
      },
    });
    try {
      const original = await db.connection.findUniqueOrThrow({ where: { id: first.id } });
      await db.connection.createMany({
        data: Array.from({ length: 200 }, (_, i) => ({
          ownerId: manager.id,
          connectorId: blocked.id,
          accessMode: "SCOPED",
          key: `${prefix}-blocked-${i}`,
          name: "Blocked",
          accountId: "blocked",
          accountName: "Blocked",
          providerSelection: original.providerSelection!,
          providerGrant: original.providerGrant!,
        })),
      });
      const blockedRows = await db.connection.findMany({ where: { connectorId: blocked.id } });
      const useScope = await db.scope.findUniqueOrThrow({ where: { key: user.scopeKeys[0] } });
      await db.connectionUseScope.createMany({
        data: blockedRows.map(({ id }) => ({ connectionId: id, scopeId: useScope.id })),
      });
      const machine = await machineActor((await token()).accessToken);
      for (const actor of [user, machine]) {
        const found = await listAccessibleConnections(actor);
        expect(found.map(({ id }) => id)).toEqual(expect.arrayContaining([first.id, second.id]));
        expect(found.some(({ connectorKey }) => connectorKey === blocked.key)).toBe(false);
      }
    } finally {
      await db.connection.deleteMany({ where: { connectorId: blocked.id } });
      await db.connector.delete({ where: { id: blocked.id } });
    }
  });
  it("authorizes and rechecks a user with a one-connection pool", async () => {
    const created = await createSharedConnection(input(), manager);
    const url = new URL(process.env.POSTGRES_URL!);
    url.searchParams.set("connection_limit", "1");
    url.searchParams.set("pool_timeout", "1");
    const output = execFileSync(
      "pnpm",
      [
        "exec",
        "tsx",
        "-e",
        `
      import { db } from "@weldall/db";
      import { authorizeConnectionUse } from "./src/server/connectors/core/authorization.ts";
      (async () => {
        try {
          await authorizeConnectionUse({
            actor: ${JSON.stringify(user)}, selector: ${JSON.stringify(created.id)}, connectorKey: ${JSON.stringify(prefix)},
            signal: AbortSignal.timeout(10000), run: async (connection) => { await connection.assertCurrent(); }
          });
          console.log("authorized");
        } finally { await db.$disconnect(); }
      })().catch(() => { process.exitCode = 1; });
    `,
      ],
      { encoding: "utf8", env: { ...process.env, POSTGRES_URL: url.href }, timeout: 15000 },
    );
    expect(output).toContain("authorized");
  }, 20000);
  it("uses the real machine-token and SDK DPoP path through discovery and a single upstream call", async () => {
    const value = input();
    await createSharedConnection(value, manager);
    const accessToken = (await token()).accessToken;
    const client = createWeldallMcpClient({
      issuer: WELDALL_ISSUER,
      accessToken,
      key,
      fetch: async (url, init) => {
        const request = new Request(url, init);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/connections"))
          return (await import("../src/app/api/me/mcp/connections/route")).GET(request);
        if (path.endsWith("/connectors"))
          return (await import("../src/app/api/me/mcp/connectors/route")).GET(request);
        return (await import("../src/app/api/me/mcp/connectors/[key]/call/route")).POST(request, {
          params: Promise.resolve({ key: prefix }),
        });
      },
    });
    expect(await client.listConnectors()).toContainEqual({
      key: prefix,
      name: "Shared MCP",
      capabilities: ["mcp"],
    });
    expect(
      (await client.listConnections({ connectorKey: prefix })).some((row) => row.key === value.key),
    ).toBe(true);
    expect(
      await client.callTool({
        connectorKey: prefix,
        connection: value.key,
        name: "fixture.read",
        arguments: {},
      }),
    ).toHaveProperty("content");
    const events = await db.auditEvent.findMany({ where: { actorId: machineId } });
    expect(
      events.some(
        (event) => (event.metadata as Record<string, unknown>).authorizationSource === "scope",
      ),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain(secret);
  });
  it("rechecks revoked live scopes, key revocation and disablement without bypass from a token", async () => {
    const value = input();
    const created = await createSharedConnection(value, manager);
    const accessToken = (await token()).accessToken;
    const machine = await machineActor(accessToken);
    const scope = await db.scope.findUniqueOrThrow({ where: { key: user.scopeKeys[0] } });
    await authorizeConnectionUse({
      actor: machine,
      selector: created.id,
      connectorKey: prefix,
      signal: AbortSignal.timeout(5000),
      run: async (connection) => {
        await db.machineAllowedScope.delete({
          where: { machineClientId_scopeId: { machineClientId: machineId, scopeId: scope.id } },
        });
        try {
          await expect(connection.assertCurrent()).rejects.toMatchObject({
            code: "connection_denied",
          });
        } finally {
          await db.machineAllowedScope.create({
            data: { machineClientId: machineId, scopeId: scope.id },
          });
        }
      },
    });
    await db.machineClient.update({ where: { id: machineId }, data: { enabled: false } });
    await expect(machineActor(accessToken)).rejects.toThrow();
    await db.machineClient.update({ where: { id: machineId }, data: { enabled: true } });
    await db.machineClientKey.updateMany({
      where: { machineClientId: machineId },
      data: { revokedAt: new Date() },
    });
    await expect(resolve(created.id, machine)).rejects.toThrow();
    await db.machineClientKey.updateMany({
      where: { machineClientId: machineId },
      data: { revokedAt: null },
    });
  });
  it("reads current user grants inside the transaction, not at preparation time", async () => {
    const created = await createSharedConnection(input(), manager);
    const resolvePrepared = await prepareConnectionAccess(user);
    const assignment = await db.emailScopeAssignment.findUniqueOrThrow({
      where: { normalizedEmail: user.email },
    });
    const scope = await db.scope.findUniqueOrThrow({ where: { key: user.scopeKeys[0] } });
    await db.emailScopeGrant.delete({
      where: { assignmentId_scopeId: { assignmentId: assignment.id, scopeId: scope.id } },
    });
    try {
      await expect(
        runConnectorTransaction((tx) => resolvePrepared(tx, created.id)),
      ).rejects.toMatchObject({ code: "connection_denied" });
    } finally {
      await db.emailScopeGrant.create({
        data: { assignmentId: assignment.id, scopeId: scope.id, createdBy: manager.id },
      });
    }
  });
  it("rechecks live user scope removal after credentials have been authorized", async () => {
    const created = await createSharedConnection(input(), manager);
    const assignment = await db.emailScopeAssignment.findUniqueOrThrow({
      where: { normalizedEmail: user.email },
    });
    const scope = await db.scope.findUniqueOrThrow({ where: { key: user.scopeKeys[0] } });
    await authorizeConnectionUse({
      actor: user,
      selector: created.id,
      connectorKey: prefix,
      signal: AbortSignal.timeout(5000),
      run: async (connection) => {
        await db.emailScopeGrant.delete({
          where: { assignmentId_scopeId: { assignmentId: assignment.id, scopeId: scope.id } },
        });
        try {
          await expect(connection.assertCurrent()).rejects.toMatchObject({
            code: "connection_denied",
          });
        } finally {
          await db.emailScopeGrant.create({
            data: { assignmentId: assignment.id, scopeId: scope.id, createdBy: manager.id },
          });
        }
      },
    });
  });
  it("blocks IaC deletion of a scope referenced by an operational shared connection", async () => {
    const scope = await db.scope.create({
      data: {
        key: `${prefix}:iac`,
        description: "IaC fixture",
        createdBy: manager.id,
        updatedBy: manager.id,
      },
    });
    const created = await createSharedConnection(
      { ...input(), useScopeKeys: [scope.key] },
      manager,
    );
    const workspace = { id: randomUUID(), name: prefix, issuer: WELDALL_ISSUER };
    await db.iacWorkspace.create({
      data: {
        ...workspace,
        bindings: {
          create: {
            address: "scope.shared",
            kind: "SCOPE",
            naturalIdentity: scope.key,
            scopeId: scope.id,
          },
        },
      },
    });
    try {
      const manifest = parseDesiredState({ apiVersion: "weldall.dev/v1", workspace });
      const state = await loadPlanningState({ tx: db, manifest });
      expect(createPlan(manifest, state).blockers).toContainEqual(
        expect.objectContaining({
          code: "EXTERNAL_REFERENCE",
          address: "scope.shared",
          message: expect.stringContaining("shared connection"),
        }),
      );
    } finally {
      await db.iacWorkspace.delete({ where: { id: workspace.id } });
      await deleteConnection({ id: created.id, actor: manager });
      await db.scope.delete({ where: { id: scope.id } });
    }
  });
  it("disables and re-enables shared access without deleting credentials or bypassing admin/CAS checks", async () => {
    const created = await createSharedConnection(input(), manager);
    const machine = await machineActor((await token()).accessToken);
    const before = await db.connection.findUniqueOrThrow({ where: { id: created.id } });
    const encrypted = await db.encryptedValue.findUniqueOrThrow({
      where: { id: before.credentialId! },
    });
    for (const actor of [user, machine])
      await expect(
        setSharedConnectionEnabled({ ...created, version: 1, enabled: false }, actor),
      ).rejects.toMatchObject({ code: "forbidden" });
    await setSharedConnectionEnabled({ ...created, version: 1, enabled: false }, manager);
    expect(await getConnectionDetails(created.id)).toMatchObject({
      status: "DISABLED",
      version: 2,
    });
    expect(await db.encryptedValue.findUnique({ where: { id: before.credentialId! } })).toEqual(
      encrypted,
    );
    for (const actor of [user, machine]) {
      await expect(resolve(created.id, actor)).rejects.toMatchObject({ code: "connection_denied" });
      expect((await listAccessibleConnections(actor)).some((row) => row.id === created.id)).toBe(
        false,
      );
      await expect(
        setSharedConnectionEnabled({ ...created, version: 2, enabled: true }, actor),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(
      setSharedConnectionEnabled({ ...created, version: 1, enabled: true }, manager),
    ).rejects.toMatchObject({ code: "conflict" });
    await rotateSharedConnectionCredential(
      { ...created, version: 2, providerInput: { apiKey: "rotated-fixture-key" } },
      manager,
    );
    expect(await getConnectionDetails(created.id)).toMatchObject({
      status: "DISABLED",
      version: 3,
    });
    await expect(resolve(created.id, user)).rejects.toMatchObject({ code: "connection_denied" });
    await setSharedConnectionEnabled({ ...created, version: 3, enabled: true }, manager);
    expect(await getConnectionDetails(created.id)).toMatchObject({ status: "READY", version: 4 });
    for (const actor of [user, machine])
      expect((await resolve(created.id, actor)).row.id).toBe(created.id);
    await authorizeConnectionUse({
      actor: user,
      selector: created.id,
      connectorKey: prefix,
      signal: AbortSignal.timeout(5000),
      run: async (connection) => {
        expect(connection.credentials).toMatchObject({ apiKey: "rotated-fixture-key" });
        await connection.assertCurrent();
      },
    });
    await expect(
      setSharedConnectionEnabled({ ...created, version: 4, enabled: true }, manager),
    ).rejects.toMatchObject({ code: "conflict" });
    const events = await db.auditEvent.findMany({ where: { subjectId: created.id } });
    expect(events.map((event) => (event.metadata as Record<string, unknown>).operation)).toEqual(
      expect.arrayContaining(["connection.shared.disabled", "connection.shared.enabled"]),
    );
  });
  it("fences an authorized request across disablement and reactivation", async () => {
    const created = await createSharedConnection(input(), manager);
    await authorizeConnectionUse({
      actor: user,
      selector: created.id,
      connectorKey: prefix,
      signal: AbortSignal.timeout(5000),
      run: async (connection) => {
        await setSharedConnectionEnabled({ ...created, version: 1, enabled: false }, manager);
        await expect(connection.assertCurrent()).rejects.toMatchObject({
          code: "connection_denied",
        });
        await setSharedConnectionEnabled({ ...created, version: 2, enabled: true }, manager);
        await expect(connection.assertCurrent()).rejects.toMatchObject({ code: "conflict" });
      },
    });
  });
  it.each(["RECONNECT_REQUIRED", "REFRESHING", "REVOCATION_PENDING"] as const)(
    "does not turn %s into a disabled or ready connection",
    async (status) => {
      const created = await createSharedConnection(input(), manager);
      await db.connection.update({ where: { id: created.id }, data: { status } });
      for (const enabled of [false, true])
        await expect(
          setSharedConnectionEnabled({ ...created, version: 1, enabled }, manager),
        ).rejects.toMatchObject({ code: "conflict" });
      expect(await getConnectionDetails(created.id)).toMatchObject({ status, version: 1 });
    },
  );
  it("fences rotation/access edits with CAS and restricts scope deletion until references are removed", async () => {
    const value = input();
    const created = await createSharedConnection(value, manager);
    await expect(
      updateSharedConnectionAccess({ ...created, version: 1, useScopeKeys: [] }, manager),
    ).rejects.toThrow();
    await rotateSharedConnectionCredential(
      { ...created, version: 1, providerInput: { apiKey: secret } },
      manager,
    );
    await expect(
      rotateSharedConnectionCredential(
        { ...created, version: 1, providerInput: { apiKey: secret } },
        manager,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await updateSharedConnectionAccess(
      { ...created, version: 2, useScopeKeys: value.useScopeKeys },
      manager,
    );
    const scope = await db.scope.findUniqueOrThrow({ where: { key: user.scopeKeys[0] } });
    await expect(
      runConnectorTransaction((tx) =>
        mutateScope({
          tx,
          input: { action: "delete", id: scope.id, expectedVersion: scope.version },
          actor: { ...manager, source: "admin_api" },
        }),
      ),
    ).rejects.toMatchObject({ details: { reason: "in_use" } });
    const isolated = await db.scope.create({
      data: {
        key: `${prefix}:isolated`,
        description: "Restrict fixture",
        createdBy: manager.id,
        updatedBy: manager.id,
      },
    });
    const reference = await createSharedConnection(
      { ...input(), useScopeKeys: [isolated.key] },
      manager,
    );
    await expect(db.scope.delete({ where: { id: isolated.id } })).rejects.toThrow(
      "ConnectionUseScope",
    );
    await deleteConnection({ actor: manager, id: reference.id });
    await db.scope.delete({ where: { id: isolated.id } });
    const before = await db.connection.findUniqueOrThrow({ where: { id: created.id } });
    await setSharedConnectionEnabled({ ...created, version: 3, enabled: false }, manager);
    await expect(resolve(created.id, user)).rejects.toMatchObject({ code: "connection_denied" });
    await deleteConnection({ actor: manager, id: created.id });
    expect(await db.connectionUseScope.count({ where: { connectionId: created.id } })).toBe(0);
    expect(await db.encryptedValue.findUnique({ where: { id: before.credentialId! } })).toBeNull();
  });
});
