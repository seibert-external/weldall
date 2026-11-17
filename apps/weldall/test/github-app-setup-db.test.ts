import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, ensureSystemScopes } from "@weldall/db";
import { generateEs256KeyPair } from "@weldall/sdk";
import { calculateJwkThumbprint } from "jose";
import { botIdentity, mockGitHubChecks, type ChecksScenario } from "./fixtures/github-api";

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
import { deleteConnection, getConnectionDetails } from "../src/server/connectors/core/connections";
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
const prefix = `ghsetup-${randomBytes(6).toString("hex")}`;
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
const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
}).privateKey;

/** A complete GitHub App connector as an administrator declares it, with its key connection. */
const manifest = () => {
  const id = randomUUID();
  workspaces.push(id);
  const key = `${prefix}-${workspaces.length}`;
  return parseDesiredState({
    apiVersion: "weldall.dev/v1",
    workspace: { id, name: key, issuer: "https://weldall.example.com" },
    scopes: { publish: { key: `${key}:publish`, description: "Publish apps" } },
    connectors: {
      github: {
        key,
        name: "GitHub",
        type: "github-app",
        enabled: true,
        envelopeProvider: "LOCAL_ENV",
        requiredScopes: [`${key}:publish`],
        provider: {
          appId: 123456,
          organization: "acme-apps",
          installationId: "987654",
          templates: [{ name: "react", repository: "acme-apps/react-starter" }],
          repositoryNamePrefix: "app-",
          reviewerTeam: "app-reviewers",
          setupMode: "customer-managed",
          liveEnvironments: ["production", "live"],
        },
      },
    },
    sharedConnections: {
      key: {
        key: `${key}-key`,
        connectorKey: key,
        name: "GitHub App key",
        enabled: false,
        useScopes: [`${key}:publish`],
        credentialManagerEmail: admin.email,
        serviceAccountLabel: "GitHub App",
        provider: { kind: "github-app-private-key" },
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
  scenario: ChecksScenario = {},
) {
  mocks.user = user;
  const github = mockGitHubChecks(scenario);
  const response = await GET(
    new Request(`${WELDALL_ISSUER}/api/admin/connectors/${connectorKey}/check`, {
      headers: { authorization: "DPoP test" },
    }),
    { params: Promise.resolve({ key: connectorKey }) },
  );
  return { status: response.status, json: (await response.json()) as any, github };
}
const stateOf = (json: any, id: string) =>
  json.checks.find((check: { id: string }) => check.id === id)?.state;

describe.skipIf(!approved)(
  "GitHub App setup by IaC and the admin UI on disposable PostgreSQL",
  () => {
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

    it("declares the connector by IaC, takes the key through the admin UI path and opens the Git host", async () => {
      const m = manifest();
      const connectorKey = m.connectors.github!.key;
      await apply(m);
      const connector = await db.connector.findUniqueOrThrow({ where: { key: connectorKey } });
      expect(connector).toMatchObject({ enabled: true, providerType: "github-app" });
      expect(connector.providerConfig).toEqual({
        appId: "123456",
        organization: "acme-apps",
        installationId: "987654",
        apiBaseUrl: "https://api.github.com",
        templates: [{ name: "react", repository: "acme-apps/react-starter" }],
        repositoryNamePrefix: "app-",
        reviewerTeam: "app-reviewers",
        setupMode: "customer-managed",
        liveEnvironments: ["production", "live"],
      });
      const shared = await db.connection.findUniqueOrThrow({
        where: { key: m.sharedConnections!.key!.key },
      });
      expect(shared).toMatchObject({ enabled: false, credentialId: null, status: "READY" });
      expect(await getConnectionDetails(shared.id)).toMatchObject({
        hasCredential: false,
        readiness: "MISSING_CREDENTIAL",
      });
      await expect(openGitHost({ connectorId: connector.id })).rejects.toMatchObject({
        code: "credential_unavailable",
      });
      const before = await runCheck(admin, connectorKey);
      expect(before.status).toBe(200);
      expect(stateOf(before.json, "credential")).toBe("fail");
      expect(stateOf(before.json, "app-authentication")).toBe("fail");
      expect(before.github.calls).toEqual([]);

      // The admin UI's "Provision private key" (tRPC admin.managed.rotateSharedCredential).
      await rotateSharedConnectionCredential(
        { id: shared.id, version: shared.version, providerInput: { privateKey } },
        adminActor,
      );
      await expect(openGitHost({ connectorId: connector.id })).rejects.toMatchObject({
        code: "credential_unavailable",
      });
      // Checkable before enabling: the key is used, the disabled connection is reported.
      const provisioned = await runCheck(admin, connectorKey);
      expect(stateOf(provisioned.json, "credential")).toBe("fail");
      expect(stateOf(provisioned.json, "app-authentication")).toBe("pass");

      const current = await db.connection.findUniqueOrThrow({ where: { id: shared.id } });
      await setSharedConnectionEnabled(
        { id: shared.id, version: current.version, enabled: true },
        adminActor,
      );
      // The manifest follows the UI; the next plan changes nothing.
      m.sharedConnections!.key!.enabled = true;
      const plan = await planIac(m);
      expect(plan.blockers).toEqual([]);
      expect(plan.actions.every((action) => action.action === "noop")).toBe(true);

      const host = await openGitHost({ connectorId: connector.id });
      mockGitHubChecks();
      await expect(
        host.readCommitIdentity(
          { repository: { owner: "acme-apps", name: "app-expenses" } },
          AbortSignal.timeout(5_000),
        ),
      ).resolves.toEqual(botIdentity);

      const ready = await runCheck(admin, connectorKey);
      expect(ready.status).toBe(200);
      expect(ready.json).toMatchObject({
        connector: { key: connectorKey, name: "GitHub", type: "github-app" },
        repository: null,
        summary: { pass: 13, fail: 0, unverifiable: 2 },
      });
      expect(ready.json.checks[0]).toEqual({
        id: "connector",
        title: "Connector enabled",
        state: "pass",
        required: true,
        reason: `The connector "${connectorKey}" is enabled.`,
        action: null,
      });
      expect(JSON.stringify(ready.json)).not.toMatch(/ghs_check_|PRIVATE KEY|eyJ/);
      const audit = await db.auditEvent.findMany({
        where: { eventType: "git_host.checked", subjectId: connector.id },
        orderBy: { occurredAt: "asc" },
      });
      expect(audit).toHaveLength(3);
      expect(audit[2]).toMatchObject({
        actorId: admin.id,
        outcome: "success",
        subjectType: "connector",
        metadata: {
          connectorId: connector.id,
          repositoryOwner: null,
          repositoryName: null,
          passed: 13,
          failed: 0,
          unverifiable: 2,
          failedChecks: [],
        },
      });
      expect(audit[0]!.metadata).toMatchObject({
        failedChecks: ["credential", "app-authentication"],
      });
    });

    it("checks the branch rule on an existing app's repository", async () => {
      const m = manifest();
      await apply(m);
      const connectorKey = m.connectors.github!.key;
      const connector = await db.connector.findUniqueOrThrow({ where: { key: connectorKey } });
      const shared = await db.connection.findUniqueOrThrow({
        where: { key: m.sharedConnections!.key!.key },
      });
      await rotateSharedConnectionCredential(
        { id: shared.id, version: shared.version, providerInput: { privateKey } },
        adminActor,
      );
      await db.app.create({
        data: {
          name: "expenses",
          purpose: "Tracks team expenses",
          ownerId: admin.id,
          connectorId: connector.id,
          repositoryOwner: "acme-apps",
          repositoryName: "app-expenses",
          defaultBranch: "main",
          template: "react",
          templateCommit: "c".repeat(40),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      const { json } = await runCheck(admin, connectorKey, { rules: { body: [] } });
      expect(json.repository).toEqual({ owner: "acme-apps", name: "app-expenses" });
      expect(stateOf(json, "branch-rule")).toBe("fail");
      expect(stateOf(json, "reviewer-team-access")).toBe("pass");
    });

    it("is for administrators only and names unknown or unsuitable connectors", async () => {
      const m = manifest();
      await apply(m);
      const connectorKey = m.connectors.github!.key;
      const denied = await runCheck(member, connectorKey);
      expect(denied).toMatchObject({ status: 403, json: { error: "forbidden" } });
      expect(denied.github.calls).toEqual([]);
      expect((await runCheck(outsider, connectorKey)).status).toBe(401);
      expect((await runCheck(null, connectorKey)).status).toBe(401);
      expect(await runCheck(admin, `${prefix}-missing`)).toMatchObject({
        status: 404,
        json: { error: "not_found" },
      });
      const mcp = await db.connector.create({
        data: {
          key: `${prefix}-mcp`,
          name: "Atlassian",
          providerType: "atlassian-mcp",
          enabled: false,
          envelopeProvider: "LOCAL_ENV",
          providerConfig: { allowedScopes: ["read:jira:agent-interface"], defaultScopes: [] },
          createdBy: prefix,
          updatedBy: prefix,
        },
      });
      expect(await runCheck(admin, mcp.key)).toMatchObject({
        status: 400,
        json: { error: "unsupported_provider" },
      });
      expect(
        await db.auditEvent.count({
          where: { eventType: "git_host.checked", actorId: { in: [member.id, outsider.id] } },
        }),
      ).toBe(0);
    });

    it("blocks an unavailable setup mode and a new App while a key is provisioned", async () => {
      const managed = manifest();
      managed.connectors.github!.provider = {
        ...(managed.connectors.github!.provider as object),
        setupMode: "weldall-managed",
      };
      expect((await planIac(managed)).blockers).toContainEqual(
        expect.objectContaining({ code: "UNSUPPORTED_SETUP_MODE" }),
      );

      const m = manifest();
      await apply(m);
      const shared = await db.connection.findUniqueOrThrow({
        where: { key: m.sharedConnections!.key!.key },
      });
      await rotateSharedConnectionCredential(
        { id: shared.id, version: shared.version, providerInput: { privateKey } },
        adminActor,
      );
      m.connectors.github!.provider = {
        ...(m.connectors.github!.provider as object),
        appId: "654321",
      };
      expect((await planIac(m)).blockers).toContainEqual(
        expect.objectContaining({
          code: "CLIENT_IN_USE",
          message: expect.stringContaining("GitHub App"),
        }),
      );
    });
  },
);
