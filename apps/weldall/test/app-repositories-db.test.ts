import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, ensureSystemScopes } from "@weldall/db";
import { mockGitHub, templateCommit, type GitHubScenario } from "./fixtures/github-api";

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
// The real host with a test key: decrypting the shared connection's key is covered elsewhere.
vi.mock("../src/server/connectors/core/git-hosts", async () => {
  const { db } = await import("@weldall/db");
  const { parseGitHubAppPrivateKey } =
    await import("../src/server/connectors/providers/github-app/private-key");
  const { parseGitHubAppConfiguration } =
    await import("../src/server/connectors/providers/github-app/config");
  const { createGitHubAppHost } =
    await import("../src/server/connectors/providers/github-app/host");
  const { createInstallationTokenCache } =
    await import("../src/server/connectors/providers/github-app/tokens");
  const pkcs8 = parseGitHubAppPrivateKey(
    generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    }).privateKey,
  );
  return {
    openGitHost: async ({ connectorId }: { connectorId: string }) =>
      createGitHubAppHost({
        config: parseGitHubAppConfiguration(
          (await db.connector.findUniqueOrThrow({ where: { id: connectorId } })).providerConfig,
        ),
        loadPrivateKey: async () => pkcs8,
        tokens: createInstallationTokenCache(),
        timing: { readyTimeoutMs: 300, pollIntervalMs: 5 },
      }),
  };
});
import { POST } from "../src/app/api/me/apps/route";
import { WELDALL_ISSUER } from "../src/server/oauth/constants";
import { isAppRepositoryReady } from "../src/server/app-registry/service";

const target = "postgresql://postgres@localhost:5433/postgres";
// Use the operator-approved local database or CI's existing disposable test service; never reset either here.
const approvedTarget =
  process.env.POSTGRES_URL === target ||
  /^postgresql:\/\/postgres@localhost:5433\/weldall_connector_test_[a-f0-9]{32}$/.test(
    process.env.POSTGRES_URL ?? "",
  ) ||
  (process.env.CI === "true" &&
    process.env.POSTGRES_URL === "postgresql://postgres:postgres@localhost:5432/postgres");
const prefix = `apprepo-${randomUUID()}`;
const publishScope = `${prefix}:publish`;
const person = (name: string) => ({
  id: `${prefix}-${name}`,
  email: `${prefix}-${name}@example.com`,
  name,
});
const alice = person("alice");
const bob = person("bob");
/** Signed in, but without the connector's required scope. */
const eve = person("eve");
/** Without the login permission. */
const mallory = person("mallory");
const connectorKey = `${prefix}-github`;
let connectorId: string;

const url = `${WELDALL_ISSUER}/api/me/apps`;
async function call(
  user: typeof alice,
  body: Record<string, unknown>,
  scenario: GitHubScenario = {},
) {
  mocks.user = user;
  const github = mockGitHub(scenario);
  const response = await POST(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "DPoP test" },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    json: (await response.json()) as any,
    generated: github.calls.filter(({ path }) => path.endsWith("/generate")).length,
  };
}
const create = (name = "Expenses") => ({
  connector: connectorKey,
  template: "react",
  name,
  purpose: "Tracks team expenses",
});
const auditFor = (actorId: string) =>
  db.auditEvent.findMany({
    where: { actorId, eventType: { startsWith: "git_repository." } },
    orderBy: { occurredAt: "asc" },
  });
const appsOn = () => db.app.findMany({ where: { connectorId } });

describe.skipIf(!approvedTarget)(
  "app repository creation endpoint on explicitly selected disposable PostgreSQL",
  () => {
    beforeAll(async () => {
      if (!approvedTarget) throw new Error("Unsafe database target");
      await ensureSystemScopes(db, prefix);
      const scope = await db.scope.create({
        data: {
          key: publishScope,
          description: "Publish apps",
          createdBy: prefix,
          updatedBy: prefix,
        },
      });
      const login = await db.scope.findUniqueOrThrow({ where: { key: "weldall:login" } });
      for (const [user, scopes] of [
        [alice, [login, scope]],
        [bob, [login, scope]],
        [eve, [login]],
        [mallory, [scope]],
      ] as const) {
        await db.user.create({
          data: { id: user.id, email: user.email, name: user.name, emailVerified: true },
        });
        await db.emailScopeAssignment.create({
          data: {
            normalizedEmail: user.email,
            createdBy: prefix,
            updatedBy: prefix,
            grants: { create: scopes.map(({ id }) => ({ scopeId: id, createdBy: prefix })) },
          },
        });
      }
      connectorId = (
        await db.connector.create({
          data: {
            key: connectorKey,
            name: "GitHub",
            providerType: "github-app",
            enabled: true,
            envelopeProvider: "LOCAL_ENV",
            providerConfig: {
              appId: "123456",
              organization: "acme-apps",
              installationId: "987654",
              apiBaseUrl: "https://api.github.com",
              templates: [{ name: "react", repository: "acme-apps/react-starter" }],
              repositoryNamePrefix: "app-",
              reviewerTeam: "app-reviewers",
              setupMode: "customer-managed",
            },
            createdBy: prefix,
            updatedBy: prefix,
            requiredScopes: { create: { scopeId: scope.id } },
          },
        })
      ).id;
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      mocks.user = null;
    });

    afterAll(async () => {
      if (!approvedTarget) return;
      await db.app.deleteMany({ where: { ownerId: { startsWith: prefix } } });
      await db.connector.deleteMany({ where: { key: { startsWith: prefix } } });
      await db.emailScopeAssignment.deleteMany({
        where: { normalizedEmail: { startsWith: prefix } },
      });
      await db.scope.deleteMany({ where: { key: publishScope } });
      await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
      await db.auditEvent.deleteMany({ where: { actorId: { startsWith: prefix } } });
    });

    it("creates the repository, registers the app for the caller and audits it", async () => {
      const before = Date.now();
      const { status, json, generated } = await call(alice, create(), {
        rules: { status: 200, body: [] },
      });

      expect(status).toBe(200);
      expect(generated).toBe(1);
      const [app] = await appsOn();
      expect(json).toEqual({
        created: true,
        app: {
          id: app!.id,
          name: "expenses",
          purpose: "Tracks team expenses",
          expiresAt: app!.expiresAt.toISOString(),
        },
        connector: connectorKey,
        repository: {
          owner: "acme-apps",
          name: "app-expenses",
          id: "4242",
          webUrl: "https://github.com/acme-apps/app-expenses",
          defaultBranch: "main",
        },
        template: { name: "react", commit: templateCommit },
        git: {
          remotePath: `/git/${connectorKey}/acme-apps/app-expenses.git`,
          remoteUrl: `${WELDALL_ISSUER}/git/${connectorKey}/acme-apps/app-expenses.git`,
        },
        warnings: [expect.objectContaining({ code: "default_branch_unprotected" })],
      });
      expect(app).toMatchObject({
        ownerId: alice.id,
        repositoryOwner: "acme-apps",
        repositoryName: "app-expenses",
        repositoryId: "4242",
        defaultBranch: "main",
        template: "react",
        templateCommit,
      });
      const days = (app!.expiresAt.getTime() - before) / 86_400_000;
      expect(days).toBeGreaterThanOrEqual(90);
      expect(days).toBeLessThan(91);
      const [audit] = await auditFor(alice.id);
      expect(audit).toMatchObject({
        eventType: "git_repository.created",
        outcome: "success",
        subjectType: "app",
        subjectId: app!.id,
        metadata: {
          connectorId,
          appId: app!.id,
          repositoryOwner: "acme-apps",
          repositoryName: "app-expenses",
          template: "react",
          templateCommit,
          defaultBranch: "main",
          existingRepository: false,
          warnings: ["default_branch_unprotected"],
        },
      });
    });

    it("is idempotent for the same owner and a conflict for another owner", async () => {
      const again = await call(alice, { ...create(" EXPENSES "), connector: undefined });
      expect(again.status).toBe(200);
      expect(again.generated).toBe(0);
      expect(again.json).toMatchObject({
        created: false,
        repository: { name: "app-expenses" },
        template: { commit: templateCommit },
        warnings: [],
      });
      expect(await appsOn()).toHaveLength(1);
      expect((await auditFor(alice.id)).at(-1)).toMatchObject({
        eventType: "git_repository.created",
        metadata: { existingRepository: true },
      });

      const other = await call(bob, create());
      expect(other.status).toBe(409);
      expect(other.json).toMatchObject({ error: "app_exists" });
      expect(other.generated).toBe(0);
      expect(await auditFor(bob.id)).toEqual([
        expect.objectContaining({
          eventType: "git_repository.denied",
          metadata: expect.objectContaining({ appId: null, repositoryName: "app-expenses" }),
        }),
      ]);

      const otherTemplate = await call(alice, { ...create(), template: "vue" });
      expect(otherTemplate).toMatchObject({ status: 400, json: { error: "unknown_template" } });
    });

    it("keeps the repository registered when the reviewer team lacks access and resumes after the fix", async () => {
      const failed = await call(alice, create("Team"), { team: { status: 404 } });
      expect(failed.status).toBe(409);
      expect(failed.json.error).toBe("reviewer_team_access_missing");
      const app = await db.app.findFirstOrThrow({
        where: { connectorId, repositoryName: "app-team" },
      });
      expect(app).toMatchObject({ ownerId: alice.id, templateCommit: null, defaultBranch: "main" });
      expect(isAppRepositoryReady(app)).toBe(false);
      expect((await auditFor(alice.id)).at(-1)).toMatchObject({
        eventType: "git_repository.denied",
        subjectId: app.id,
        metadata: expect.objectContaining({ appId: app.id }),
      });

      const resumed = await call(alice, create("Team"));
      expect(resumed.status).toBe(200);
      expect(resumed.generated).toBe(0);
      expect(resumed.json).toMatchObject({ created: false, app: { id: app.id } });
      const ready = await db.app.findUniqueOrThrow({ where: { id: app.id } });
      expect(ready).toMatchObject({ templateCommit });
      expect(isAppRepositoryReady(ready)).toBe(true);
    });

    it("resumes when a concurrent call of the same owner created the repository first", async () => {
      mocks.user = alice;
      const github = mockGitHub();
      const upstream = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (!String(input).endsWith("/generate")) return upstream(input, init);
          // The other call won: GitHub created its repository and it registered the app.
          await db.app.create({
            data: {
              name: "race",
              purpose: "Tracks team expenses",
              ownerId: alice.id,
              connectorId,
              repositoryOwner: "acme-apps",
              repositoryName: "app-race",
              repositoryId: "777",
              defaultBranch: "main",
              template: "react",
              expiresAt: new Date(Date.now() + 86_400_000),
            },
          });
          return Response.json(
            { errors: [{ message: "name already exists on this account" }] },
            { status: 422 },
          );
        }),
      );
      const response = await POST(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "DPoP test" },
          body: JSON.stringify(create("Race")),
        }),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        created: false,
        repository: { name: "app-race" },
        template: { commit: templateCommit },
      });
      expect(github.calls.some(({ path }) => path === "/repos/acme-apps/app-race")).toBe(true);
      expect(await db.app.count({ where: { connectorId, repositoryName: "app-race" } })).toBe(1);
    });

    it("refuses a repository that exists on GitHub but is not registered", async () => {
      const { status, json } = await call(alice, create("Taken"), {
        generate: {
          status: 422,
          body: { errors: [{ message: "name already exists on this account" }] },
        },
      });
      expect(status).toBe(409);
      expect(json).toMatchObject({ error: "repository_exists" });
      expect(json.error_description).toMatch(/not registered in Weldall/);
      expect(json.error_description).toMatch(/leftover of a failed creation/);
      expect(
        await db.app.findFirst({ where: { connectorId, repositoryName: "app-taken" } }),
      ).toBeNull();
    });

    it("does not register a repository GitHub did not make private", async () => {
      const { status, json } = await call(alice, create("Public"), {
        repository: { private: false, visibility: "public" },
      });
      expect(status).toBe(502);
      expect(json.error).toBe("repository_not_private");
      expect(
        await db.app.findFirst({ where: { connectorId, repositoryName: "app-public" } }),
      ).toBeNull();
      expect((await auditFor(alice.id)).at(-1)).toMatchObject({
        eventType: "git_repository.failed",
        reasonCode: "internal_error",
      });
    });

    it("authorizes with the login permission and the connector's required scopes", async () => {
      const denied = await call(eve, create("Eve"));
      expect(denied).toMatchObject({ status: 403, json: { error: "connection_denied" } });
      expect(denied.generated).toBe(0);
      expect(await auditFor(eve.id)).toEqual([
        expect.objectContaining({
          eventType: "git_repository.denied",
          reasonCode: "scope_not_granted",
        }),
      ]);
      const implicit = await call(eve, { ...create("Eve"), connector: undefined });
      expect(implicit).toMatchObject({ status: 404, json: { error: "not_found" } });

      expect(await call(mallory, create("Mallory"))).toMatchObject({
        status: 401,
        json: { error: "unauthorized" },
      });
      mocks.user = null;
      const anonymous = await POST(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(create()),
        }),
      );
      expect(anonymous.status).toBe(401);

      expect(await call(alice, { ...create(), connector: `${prefix}-missing` })).toMatchObject({
        status: 404,
        json: { error: "not_found" },
      });
      expect(await call(alice, create(".hidden"))).toMatchObject({
        status: 400,
        json: { error: "invalid_name" },
      });
      expect(await call(alice, { ...create(), purpose: "" })).toMatchObject({
        status: 400,
        json: { error: "invalid_request" },
      });
      expect(await call(alice, { ...create(), extra: true })).toMatchObject({
        status: 400,
        json: { error: "invalid_request" },
      });
    });
  },
);
