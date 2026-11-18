import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, ensureSystemScopes } from "@weldall/db";
import { generateEs256KeyPair } from "@weldall/sdk";
import { calculateJwkThumbprint } from "jose";
import {
  BOT_TOKEN,
  FORGEJO_BASE_URL,
  forgejoConfig,
  mockForgejo,
  type ForgejoScenario,
} from "./fixtures/forgejo-api";

const mocks = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string } | null,
}));
vi.mock("../src/server/oauth/cli-api", async () => {
  const { WeldallAuthError } = await import("@weldall/sdk");
  return {
    authenticateCliApiRequest: vi.fn(async () => {
      if (!mocks.user) throw new WeldallAuthError("invalid_token", "missing", 401);
      return mocks.user;
    }),
  };
});
import { parseDesiredState, type DesiredState } from "../src/server/iac/contracts";
import { applyIac, planIac, type IacActor } from "../src/server/iac/service";
import {
  rotateSharedConnectionCredential,
  setSharedConnectionEnabled,
} from "../src/server/connectors/core/shared-connections";
import { deleteConnection } from "../src/server/connectors/core/connections";
import { openGitHost } from "../src/server/connectors/core/git-hosts";
import { GET } from "../src/app/api/admin/connectors/[key]/check/route";
import { WELDALL_ISSUER } from "../src/server/oauth/constants";

// Use the operator-approved local database or CI's existing disposable test service; never reset either here.
const approved =
  /^postgresql:\/\/postgres@localhost:5433\/weldall_connector_test_[a-f0-9]{32}$/.test(
    process.env.POSTGRES_URL ?? "",
  ) ||
  (process.env.CI === "true" &&
    process.env.POSTGRES_URL === "postgresql://postgres:postgres@localhost:5432/postgres");
const prefix = `fjsetup-${randomBytes(6).toString("hex")}`;
const person = (name: string) => ({
  id: `${prefix}-${name}`,
  email: `${prefix}-${name}@example.com`,
  name,
});
const admin = person("admin");
/** Signed in with the login permission, but not an administrator. */
const member = person("member");
/** Without the login permission. */
const outsider = person("outsider");
const adminActor = {
  id: admin.id,
  email: admin.email,
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
const workspaces: string[] = [];
/** A complete Forgejo connector as an administrator declares it, with its token connection. */
const manifest = () => {
  const id = randomUUID();
  workspaces.push(id);
  const key = `${prefix}-${workspaces.length}`;
  return parseDesiredState({
    apiVersion: "weldall.dev/v1",
    workspace: { id, name: key, issuer: "https://weldall.example.com" },
    scopes: { publish: { key: `${key}:publish`, description: "Publish apps" } },
    connectors: {
      forgejo: {
        key,
        name: "Forgejo",
        type: "forgejo",
        enabled: true,
        envelopeProvider: "LOCAL_ENV",
        requiredScopes: [`${key}:publish`],
        provider: { ...forgejoConfig },
      },
    },
    sharedConnections: {
      token: {
        key: `${key}-token`,
        connectorKey: key,
        name: "Forgejo bot token",
        enabled: false,
        useScopes: [`${key}:publish`],
        credentialManagerEmail: admin.email,
        serviceAccountLabel: "weldall-bot",
        provider: { kind: "forgejo-bot-token" },
      },
    },
  });
};
async function apply(m: DesiredState) {
  const plan = await planIac(m);
  expect(plan.blockers).toEqual([]);
  return applyIac(
    {
      manifest: m,
      plannedRevision: plan.revision,
      configDigest: plan.configDigest,
      planDigest: plan.digest,
      operationId: randomUUID(),
    },
    actor,
  );
}
async function runCheck(
  user: typeof admin | null,
  connectorKey: string,
  scenario: ForgejoScenario = {},
) {
  mocks.user = user;
  const forgejo = mockForgejo(scenario);
  const response = await GET(
    new Request(`${WELDALL_ISSUER}/api/admin/connectors/${connectorKey}/check`, {
      headers: { authorization: "DPoP test" },
    }),
    { params: Promise.resolve({ key: connectorKey }) },
  );
  return { status: response.status, json: (await response.json()) as any, forgejo };
}
const stateOf = (json: any, id: string) =>
  json.checks.find((check: { id: string }) => check.id === id)?.state;

describe.skipIf(!approved)("Forgejo setup by IaC and the admin UI on disposable PostgreSQL", () => {
  beforeAll(async () => {
    vi.stubEnv("WELDALL_CONNECTOR_KEK", randomBytes(32).toString("base64"));
    vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    await ensureSystemScopes(db, prefix);
    for (const [user, scopes] of [
      [admin, ["weldall:administer", "weldall:login"]],
      [member, ["weldall:login"]],
      [outsider, []],
    ] as const) {
      await db.user.create({
        data: { id: user.id, email: user.email, name: user.name, emailVerified: true },
      });
      await db.emailScopeAssignment.create({
        data: {
          normalizedEmail: user.email,
          createdBy: prefix,
          updatedBy: prefix,
          grants: {
            create: scopes.map((key) => ({ scope: { connect: { key } }, createdBy: prefix })),
          },
        },
      });
    }
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
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    mocks.user = null;
  });
  afterAll(async () => {
    if (!approved) return;
    await db.app.deleteMany({ where: { ownerId: admin.id } });
    for (const row of await db.connection.findMany({
      where: { connector: { key: { startsWith: prefix } } },
      select: { id: true },
    }))
      await deleteConnection({ id: row.id, actor: adminActor });
    await db.iacWorkspace.deleteMany({ where: { id: { in: workspaces } } });
    await db.connector.deleteMany({ where: { key: { startsWith: prefix } } });
    await db.scope.deleteMany({ where: { key: { startsWith: prefix } } });
    await db.machineClient.deleteMany({ where: { clientId: actor.clientId } });
    await db.emailScopeAssignment.deleteMany({
      where: { normalizedEmail: { startsWith: prefix } },
    });
    await db.auditEvent.deleteMany({ where: { actorId: { startsWith: prefix } } });
    await db.auditEvent.deleteMany({ where: { requestId: prefix } });
    await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
    vi.unstubAllEnvs();
  });

  it("declares the connector by IaC, takes the token through the admin UI path and checks it", async () => {
    const m = manifest();
    const connectorKey = m.connectors.forgejo!.key;
    await apply(m);
    const connector = await db.connector.findUniqueOrThrow({ where: { key: connectorKey } });
    expect(connector).toMatchObject({ enabled: true, providerType: "forgejo" });
    expect(connector.providerConfig).toEqual({
      ...forgejoConfig,
      previewStatusContext: "weldall/preview",
      liveStatusContext: "weldall/live",
    });
    const shared = await db.connection.findUniqueOrThrow({
      where: { key: m.sharedConnections!.token!.key },
    });
    const before = await runCheck(admin, connectorKey);
    expect(before.status).toBe(200);
    expect(stateOf(before.json, "credential")).toBe("fail");
    expect(stateOf(before.json, "bot-token")).toBe("fail");
    expect(before.forgejo.calls).toEqual([]);

    // The admin UI's "Provision access token" (tRPC admin.managed.rotateSharedCredential).
    await rotateSharedConnectionCredential(
      { id: shared.id, version: shared.version, providerInput: { token: BOT_TOKEN } },
      adminActor,
    );
    const current = await db.connection.findUniqueOrThrow({ where: { id: shared.id } });
    expect(JSON.stringify(current)).not.toContain(BOT_TOKEN);
    await setSharedConnectionEnabled(
      { id: shared.id, version: current.version, enabled: true },
      adminActor,
    );
    m.sharedConnections!.token!.enabled = true;
    const plan = await planIac(m);
    expect(plan.blockers).toEqual([]);
    expect(plan.actions.every((action) => action.action === "noop")).toBe(true);

    const host = await openGitHost({ connectorId: connector.id });
    mockForgejo();
    const target = await host.getForwardingTarget(
      { repository: { owner: "example-org", name: "app-expenses" }, access: "write" },
      AbortSignal.timeout(5_000),
    );
    expect(target).toMatchObject({ expiresAt: null });
    expect(target.url.href).toBe(`${FORGEJO_BASE_URL}/example-org/app-expenses.git`);

    const ready = await runCheck(admin, connectorKey);
    expect(ready.status).toBe(200);
    expect(ready.json).toMatchObject({
      connector: { key: connectorKey, name: "Forgejo", type: "forgejo" },
      repository: null,
      summary: { pass: 11, fail: 0, unverifiable: 3 },
    });
    expect(JSON.stringify(ready.json)).not.toContain(BOT_TOKEN);
    expect(ready.forgejo.calls.every(({ method }) => method === "GET")).toBe(true);
    const audit = await db.auditEvent.findMany({
      where: { eventType: "git_host.checked", subjectId: connector.id },
    });
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain(BOT_TOKEN);
  });

  it("blocks an unavailable setup mode, an unsafe base URL and a new instance while a token is provisioned", async () => {
    const managed = manifest();
    managed.connectors.forgejo!.provider = {
      ...(managed.connectors.forgejo!.provider as object),
      setupMode: "weldall-managed",
    };
    expect((await planIac(managed)).blockers).toContainEqual(
      expect.objectContaining({
        code: "UNSUPPORTED_SETUP_MODE",
        message: expect.stringContaining("Forgejo"),
      }),
    );
    expect(() =>
      parseDesiredState({
        ...JSON.parse(JSON.stringify(manifest())),
        connectors: {
          forgejo: {
            ...manifest().connectors.forgejo,
            provider: { ...forgejoConfig, baseUrl: "https://127.0.0.1" },
          },
        },
      }),
    ).toThrow();

    const m = manifest();
    await apply(m);
    const shared = await db.connection.findUniqueOrThrow({
      where: { key: m.sharedConnections!.token!.key },
    });
    await rotateSharedConnectionCredential(
      { id: shared.id, version: shared.version, providerInput: { token: BOT_TOKEN } },
      adminActor,
    );
    m.connectors.forgejo!.provider = {
      ...(m.connectors.forgejo!.provider as object),
      botUser: "another-bot",
    };
    expect((await planIac(m)).blockers).toContainEqual(
      expect.objectContaining({
        code: "CLIENT_IN_USE",
        message: expect.stringContaining("Forgejo instance or bot user"),
      }),
    );
  });
});
