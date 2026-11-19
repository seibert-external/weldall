import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WeldallAuthError, type AppHostApp } from "@weldall/sdk";
import {
  botIdentity,
  headCommit,
  mockGitHub,
  mockGitHubChecks,
  mockGitHubPullRequests,
  productionCommit,
  templateCommit,
} from "./fixtures/github-api.js";
import { createTestGitApp, GIT_APP_ORIGIN, PUBLISH_SCOPE } from "./fixtures/git-app.js";

let gitApp: Awaited<ReturnType<typeof createTestGitApp>>;
const create = (name = "Expenses") => ({
  template: "react",
  name,
  purpose: "Tracks team expenses",
});
const head = "weldall/publish-1";

beforeAll(async () => {
  gitApp = await createTestGitApp();
});
beforeEach(() => gitApp.reset());
afterEach(() => vi.unstubAllGlobals());

const methods = () => gitApp.weldall.calls.map(({ method }) => method);
const events = () => gitApp.weldall.events;
const hostCalls = (github: { calls: { method: string; path: string }[] }) =>
  github.calls.filter(({ path }) => !path.endsWith("/access_tokens"));

/** A ready app of `owner` in the fake registry, as a finished creation leaves it. */
function seedApp(owner: string, overrides: Partial<AppHostApp> = {}): AppHostApp {
  const app: AppHostApp = {
    id: `seed-${owner}`,
    name: "expenses",
    purpose: "Tracks team expenses",
    owner: { id: owner },
    resource: "git-app",
    repository: {
      owner: "acme-apps",
      name: "app-expenses",
      id: "4242",
      webUrl: "https://github.com/acme-apps/app-expenses",
    },
    defaultBranch: "main",
    template: { name: "react", commit: templateCommit },
    ready: true,
    links: { preview: null, live: null },
    createdAt: "2026-11-01T00:00:00.000Z",
    confirmedAt: null,
    expiresAt: "2027-05-01T00:00:00.000Z",
    state: "active",
    ...overrides,
  };
  gitApp.weldall.apps.set(app.id, app);
  return app;
}

describe("service", () => {
  it("answers health without authentication and refuses API calls without a token", async () => {
    const health = await gitApp.request(`${GIT_APP_ORIGIN}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    const metadata = await gitApp.request(
      `${GIT_APP_ORIGIN}/.well-known/oauth-authorization-server`,
    );
    expect(await metadata.json()).toMatchObject({ issuer: GIT_APP_ORIGIN });
    const anonymous = await gitApp.request(`${GIT_APP_ORIGIN}/api/apps`, { method: "POST" });
    expect(anonymous.status).toBe(401);
    expect(gitApp.weldall.calls).toEqual([]);
  });

  it("refuses a token without the route's scope before asking Weldall or the host", async () => {
    const github = mockGitHubChecks();
    const { status } = await gitApp.call("alice", "GET", "/api/admin/checklist");
    expect(status).toBe(403);
    expect(gitApp.weldall.calls).toEqual([]);
    expect(github.calls).toEqual([]);
  });
});

describe("POST /api/apps", () => {
  it("checks Weldall first, creates the repository, registers, audits and only then marks it ready", async () => {
    const github = mockGitHub();
    const { status, json } = await gitApp.call("alice", "POST", "/api/apps", { body: create() });

    expect(status).toBe(200);
    expect(json).toMatchObject({
      created: true,
      app: { name: "expenses", purpose: "Tracks team expenses", state: "active" },
      repository: {
        owner: "acme-apps",
        name: "app-expenses",
        id: "4242",
        webUrl: "https://github.com/acme-apps/app-expenses",
        defaultBranch: "main",
      },
      template: { name: "react", commit: templateCommit },
      warnings: [],
      git: {
        remotePath: "/git/acme-apps/app-expenses.git",
        remoteUrl: `${GIT_APP_ORIGIN}/git/acme-apps/app-expenses.git`,
      },
    });
    expect(methods()).toEqual([
      "checkSubjectScopes",
      "lookupApp",
      "createApp",
      "reportAuditEvent",
      "updateApp",
    ]);
    const [scopes, lookup, registered, , ready] = gitApp.weldall.calls.map(({ input }) => input);
    expect(scopes).toEqual({ subject: "alice", scopes: ["weldall:login", PUBLISH_SCOPE] });
    expect(lookup).toEqual({
      app: { repositoryOwner: "acme-apps", repositoryName: "app-expenses" },
      subject: "alice",
    });
    expect(registered).toMatchObject({
      owner: "alice",
      template: { name: "react", commit: null },
      repository: { owner: "acme-apps", name: "app-expenses", id: "4242" },
    });
    expect(ready).toMatchObject({ templateCommit });
    expect(events()).toEqual([
      expect.objectContaining({
        eventType: "git_repository.created",
        subject: "alice",
        appId: json.app.id,
        details: {
          repositoryId: "4242",
          template: "react",
          templateCommit,
          defaultBranch: "main",
          existingRepository: false,
          warnings: [],
        },
      }),
    ]);
    expect(gitApp.weldall.apps.get(json.app.id)?.ready).toBe(true);
    expect(hostCalls(github).filter(({ path }) => path.endsWith("/generate"))).toHaveLength(1);
  });

  it("resumes the same owner's repository instead of creating a second one", async () => {
    mockGitHub();
    const first = await gitApp.call("alice", "POST", "/api/apps", { body: create() });
    const github = mockGitHub();
    const again = await gitApp.call("alice", "POST", "/api/apps", { body: create() });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ created: false, app: { id: first.json.app.id } });
    expect(hostCalls(github).some(({ path }) => path.endsWith("/generate"))).toBe(false);
    expect(events().at(-1)).toMatchObject({
      eventType: "git_repository.created",
      details: { existingRepository: true },
    });
  });

  it("refuses another person's app name without touching the host", async () => {
    mockGitHub();
    await gitApp.call("alice", "POST", "/api/apps", { body: create() });
    const github = mockGitHub();
    const { status, json } = await gitApp.call("bob", "POST", "/api/apps", { body: create() });
    expect(status).toBe(409);
    expect(json.error).toBe("app_exists");
    expect(github.calls).toEqual([]);
    expect(events().at(-1)).toMatchObject({
      eventType: "git_repository.denied",
      subject: "bob",
      appId: null,
      repository: { owner: "acme-apps", name: "app-expenses" },
    });
  });

  it.each([
    ["eve", "You lack the permission git-app:publish"],
    ["mallory", "You may no longer use Weldall."],
  ] as const)("refuses %s, whose permission was removed after sign-in", async (person, message) => {
    const github = mockGitHub();
    const { status, json } = await gitApp.call(person, "POST", "/api/apps", { body: create() });
    expect(status).toBe(403);
    expect(json).toMatchObject({
      error: "access_denied",
      error_description: expect.stringContaining(message),
    });
    expect(github.calls).toEqual([]);
    expect(methods()).toEqual(["checkSubjectScopes", "reportAuditEvent"]);
    expect(events()).toEqual([
      expect.objectContaining({
        eventType: "git_repository.denied",
        subject: person,
        reasonCode: "scope_not_granted",
      }),
    ]);
  });

  it("reports a rejection of an unknown person without a subject", async () => {
    gitApp.weldall.fail(
      "checkSubjectScopes",
      new WeldallAuthError("unknown_subject", "unknown", 404),
    );
    gitApp.weldall.fail(
      "reportAuditEvent",
      new WeldallAuthError("unknown_subject", "unknown", 404),
    );
    const { status } = await gitApp.call("alice", "POST", "/api/apps", { body: create() });
    expect(status).toBe(403);
    expect(events()).toEqual([
      expect.objectContaining({ eventType: "git_repository.denied", subject: null }),
    ]);
  });

  it("refuses a person Weldall does not know with 403, as the real check-scopes answers", async () => {
    const github = mockGitHub();
    const { status, json } = await gitApp.call("stranger" as never, "POST", "/api/apps", {
      body: create(),
    });
    expect(status).toBe(403);
    expect(json).toMatchObject({
      error: "access_denied",
      error_description: "Weldall does not know your account.",
    });
    expect(github.calls).toEqual([]);
    // The rejection naming an unknown subject is reported again without one.
    expect(events()).toEqual([
      expect.objectContaining({ eventType: "git_repository.denied", subject: null }),
    ]);
  });

  it("fails closed when Weldall cannot be reached, before contacting the host", async () => {
    const github = mockGitHub();
    gitApp.weldall.fail("checkSubjectScopes", new TypeError("fetch failed"));
    const { status, json } = await gitApp.call("alice", "POST", "/api/apps", { body: create() });
    expect(status).toBe(503);
    expect(json.error).toBe("weldall_unavailable");
    expect(github.calls).toEqual([]);
  });

  it("leaves the app not ready when the audit entry is not stored, and a retry completes it", async () => {
    mockGitHub();
    gitApp.weldall.fail("reportAuditEvent", new TypeError("fetch failed"), new TypeError("again"));
    const failed = await gitApp.call("alice", "POST", "/api/apps", { body: create() });
    expect(failed.status).toBe(503);
    expect(failed.json.error).toBe("audit_unavailable");
    const [app] = gitApp.weldall.apps.values();
    expect(app).toMatchObject({ ready: false, template: { commit: null } });
    expect(events()).toEqual([]);
    // The same event id is sent twice (one retry), then no rejection report is attempted.
    const reports = gitApp.weldall.callsOf("reportAuditEvent") as { eventId: string }[];
    expect(reports).toHaveLength(2);
    expect(reports[0]!.eventId).toBe(reports[1]!.eventId);
    expect(methods()).not.toContain("updateApp");

    const github = mockGitHub();
    const retry = await gitApp.call("alice", "POST", "/api/apps", { body: create() });
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ created: false, app: { id: app!.id } });
    expect(hostCalls(github).some(({ path }) => path.endsWith("/generate"))).toBe(false);
    expect(events()).toEqual([
      expect.objectContaining({
        eventType: "git_repository.created",
        details: expect.objectContaining({ existingRepository: true }),
      }),
    ]);
    expect(gitApp.weldall.apps.get(app!.id)?.ready).toBe(true);
  });

  it("retries registering once after a transient failure and continues", async () => {
    const github = mockGitHub();
    gitApp.weldall.fail("createApp", new WeldallAuthError("server_error", "down", 503));
    const { status, json } = await gitApp.call("alice", "POST", "/api/apps", { body: create() });
    expect(status).toBe(200);
    expect(json).toMatchObject({ created: true });
    expect(methods()).toEqual([
      "checkSubjectScopes",
      "lookupApp",
      "createApp",
      "createApp",
      "reportAuditEvent",
      "updateApp",
    ]);
    expect(gitApp.weldall.apps.get(json.app.id)?.ready).toBe(true);
    expect(events()).toEqual([expect.objectContaining({ eventType: "git_repository.created" })]);
    expect(hostCalls(github).filter(({ path }) => path.endsWith("/generate"))).toHaveLength(1);
    expect(gitApp.logs).toEqual([]);
  });

  it("does not retry registering after Weldall refused it", async () => {
    mockGitHub();
    gitApp.weldall.fail("createApp", new WeldallAuthError("access_denied", "no", 403));
    const { status, json } = await gitApp.call("alice", "POST", "/api/apps", { body: create() });
    expect(status).toBe(503);
    expect(json.error).toBe("registry_unavailable");
    expect(gitApp.weldall.callsOf("createApp")).toHaveLength(1);
  });

  it("names and logs a repository the host created but Weldall did not register", async () => {
    mockGitHub();
    gitApp.weldall.fail("createApp", new TypeError("fetch failed"), new TypeError("again"));
    const { status, json } = await gitApp.call("alice", "POST", "/api/apps", { body: create() });
    expect(status).toBe(503);
    expect(json).toMatchObject({
      error: "registry_unavailable",
      error_description: expect.stringContaining("acme-apps/app-expenses"),
    });
    expect(gitApp.weldall.callsOf("createApp")).toHaveLength(2);
    expect(gitApp.weldall.apps.size).toBe(0);
    expect(gitApp.logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({ repository: "acme-apps/app-expenses", subject: "alice" }),
      }),
    );
    expect(events()).toEqual([
      expect.objectContaining({
        eventType: "git_repository.failed",
        subject: "alice",
        repository: { owner: "acme-apps", name: "app-expenses" },
      }),
    ]);

    // The repository now exists on the host but not in the registry.
    mockGitHub({ generate: { status: 422, body: { message: "name already exists" } } });
    const retry = await gitApp.call("alice", "POST", "/api/apps", { body: create() });
    expect(retry.status).toBe(409);
    expect(retry.json.error).toBe("repository_exists");
  });

  it("keeps the app not ready when the reviewer team cannot write, with an administrator-readable error", async () => {
    mockGitHub({ team: { status: 404, body: {} } });
    const { status, json } = await gitApp.call("alice", "POST", "/api/apps", { body: create() });
    expect(status).toBe(409);
    expect(json).toMatchObject({
      error: "reviewer_team_access_missing",
      error_description: expect.stringContaining('"app-reviewers"'),
    });
    const [app] = gitApp.weldall.apps.values();
    expect(app?.ready).toBe(false);
    expect(events()).toEqual([
      expect.objectContaining({
        eventType: "git_repository.denied",
        appId: app!.id,
        repository: null,
      }),
    ]);
  });

  it("validates the body without echoing it", async () => {
    const { status, json } = await gitApp.call("alice", "POST", "/api/apps", {
      body: { ...create(), extra: "ghs_secretish" },
    });
    expect(status).toBe(400);
    expect(JSON.stringify(json)).not.toContain("ghs_secretish");
  });
});

describe("GET /api/apps/:id", () => {
  it("returns the person's own app and the same 404 for another person's", async () => {
    const app = seedApp("alice");
    const own = await gitApp.call("alice", "GET", `/api/apps/${app.id}`);
    expect(own).toMatchObject({ status: 200, json: { app: { id: app.id, ready: true } } });
    const other = await gitApp.call("bob", "GET", `/api/apps/${app.id}`);
    const unknown = await gitApp.call("bob", "GET", "/api/apps/nope");
    expect(other).toEqual(unknown);
    expect(other.status).toBe(404);
  });
});

describe("POST /api/apps/:id/pull-requests", () => {
  it("writes the trigger line with the Weldall user id and audits the pull request's commits", async () => {
    const app = seedApp("alice");
    const github = mockGitHubPullRequests();
    const { status, json } = await gitApp.call(
      "alice",
      "POST",
      `/api/apps/${app.id}/pull-requests`,
      {
        body: { head, title: "Add receipts", body: "Published with Weldall (Weldall user bob)." },
      },
    );
    expect(status).toBe(200);
    expect(json).toMatchObject({
      created: true,
      app: { id: app.id },
      pullRequest: { number: 1, headBranch: head, baseBranch: "main", headCommit },
      requestedReviewers: { users: [], teams: ["app-reviewers"] },
    });
    const opened = hostCalls(github).find(
      ({ method, path }) => method === "POST" && path.endsWith("/pulls"),
    ) as { body: { body: string } } | undefined;
    expect(opened?.body.body).toBe(
      "<!-- weldall:published-by -->\nPublished with Weldall (Weldall user alice).",
    );
    expect(methods()).toEqual(["checkSubjectScopes", "lookupApp", "reportAuditEvent"]);
    expect(events()).toEqual([
      expect.objectContaining({
        eventType: "git_pull_request.opened",
        subject: "alice",
        appId: app.id,
        details: {
          number: 1,
          webUrl: "https://github.com/acme-apps/app-expenses/pull/1",
          headBranch: head,
          baseBranch: "main",
          headCommit,
          commits: [templateCommit, headCommit],
          commitCount: 2,
          existingPullRequest: false,
          warnings: [],
        },
      }),
    ]);
  });

  it("answers another person's app like an unknown one, without contacting the host", async () => {
    const app = seedApp("alice");
    const github = mockGitHubPullRequests();
    const { status } = await gitApp.call("bob", "POST", `/api/apps/${app.id}/pull-requests`, {
      body: { head, title: "Take over" },
    });
    expect(status).toBe(404);
    expect(github.calls).toEqual([]);
    expect(events()).toEqual([
      expect.objectContaining({
        eventType: "git_pull_request.denied",
        subject: "bob",
        appId: null,
      }),
    ]);
  });

  it.each([
    ["a branch other than a publish branch", {}, "main", 400, "invalid_request"],
    ["an app that is not ready", { ready: false }, head, 409, "repository_not_ready"],
  ] as const)("refuses %s", async (_, overrides, branch, expected, code) => {
    const app = seedApp("alice", overrides);
    const github = mockGitHubPullRequests();
    const { status, json } = await gitApp.call(
      "alice",
      "POST",
      `/api/apps/${app.id}/pull-requests`,
      {
        body: { head: branch, title: "Add receipts" },
      },
    );
    expect(status).toBe(expected);
    expect(json.error).toBe(code);
    expect(github.calls).toEqual([]);
    expect(events()).toEqual([
      expect.objectContaining({ eventType: "git_pull_request.denied", subject: "alice" }),
    ]);
  });

  it("answers 503 when the audit entry is not stored, and a retry reports the existing pull request", async () => {
    const app = seedApp("alice");
    mockGitHubPullRequests();
    gitApp.weldall.fail("reportAuditEvent", new TypeError("fetch failed"), new TypeError("again"));
    const body = { head, title: "Add receipts" };
    const failed = await gitApp.call("alice", "POST", `/api/apps/${app.id}/pull-requests`, {
      body,
    });
    expect(failed.status).toBe(503);
    const retry = await gitApp.call("alice", "POST", `/api/apps/${app.id}/pull-requests`, { body });
    expect(retry.json).toMatchObject({ created: false, pullRequest: { number: 1 } });
    expect(events()).toEqual([
      expect.objectContaining({
        eventType: "git_pull_request.opened",
        details: expect.objectContaining({ existingPullRequest: true }),
      }),
    ]);
  });
});

describe("GET /api/apps/:id/status", () => {
  const scenario = {
    pulls: [{ number: 3, ref: head }],
    reviews: {
      body: [
        {
          user: { login: "rita" },
          state: "CHANGES_REQUESTED",
          body: "Fix the total; token ghs_abcdefghijklmnop1234 leaked",
          submitted_at: "2026-11-17T09:00:00Z",
        },
      ],
    },
    deployments: [
      {
        id: 10,
        environment: "preview",
        sha: headCommit,
        statuses: [{ state: "success", environment_url: "https://preview.example.com/pr-3" }],
      },
      {
        id: 11,
        environment: "production",
        sha: productionCommit,
        statuses: [{ state: "success", environment_url: "https://app.example.com/" }],
      },
    ],
  };

  it("returns reviews as sanitised data and writes new links back to Weldall", async () => {
    const app = seedApp("alice");
    mockGitHubPullRequests(scenario);
    const { status, json } = await gitApp.call("alice", "GET", `/api/apps/${app.id}/status`);
    expect(status).toBe(200);
    expect(json).toMatchObject({
      app: { id: app.id },
      pullRequest: {
        number: 3,
        state: "open",
        reviews: [
          {
            author: "rita",
            state: "changes_requested",
            body: "Fix the total; token [***] leaked",
          },
        ],
      },
      links: { preview: "https://preview.example.com/pr-3", live: "https://app.example.com/" },
      publish: { protectedPaths: [".github/workflows"], commitIdentity: botIdentity },
    });
    expect(gitApp.weldall.callsOf("updateApp")).toEqual([
      {
        appId: app.id,
        links: { preview: "https://preview.example.com/pr-3", live: "https://app.example.com/" },
      },
    ]);
    // Status reads are not audited (the contract has no event for them).
    expect(events()).toEqual([]);
  });

  it("does not write unchanged links and refuses a branch that is not a publish branch", async () => {
    const app = seedApp("alice", {
      links: { preview: "https://preview.example.com/pr-3", live: "https://app.example.com/" },
    });
    mockGitHubPullRequests(scenario);
    expect((await gitApp.call("alice", "GET", `/api/apps/${app.id}/status`)).status).toBe(200);
    expect(gitApp.weldall.callsOf("updateApp")).toEqual([]);
    const refused = await gitApp.call("alice", "GET", `/api/apps/${app.id}/status?branch=main`);
    expect(refused).toMatchObject({ status: 400, json: { error: "invalid_request" } });
  });

  it("fails closed when Weldall does not take the links", async () => {
    const app = seedApp("alice");
    mockGitHubPullRequests(scenario);
    gitApp.weldall.fail("updateApp", new WeldallAuthError("server_error", "down", 503));
    const { status, json } = await gitApp.call("alice", "GET", `/api/apps/${app.id}/status`);
    expect(status).toBe(503);
    expect(json.error).toBe("weldall_unavailable");
  });
});

describe("GET /api/admin/checklist", () => {
  it("runs the host checks for an administrator and audits the run", async () => {
    const github = mockGitHubChecks();
    const { status, json } = await gitApp.call("admin", "GET", "/api/admin/checklist");
    expect(status).toBe(200);
    expect(json.host).toEqual({ kind: "github", organization: "acme-apps" });
    expect(json.repository).toBeNull();
    expect(json.summary.pass + json.summary.fail + json.summary.unverifiable).toBe(
      json.checks.length,
    );
    expect(
      github.calls.every(({ method, path }) => method === "GET" || path.endsWith("/access_tokens")),
    ).toBe(true);
    expect(methods()).toEqual(["checkSubjectScopes", "reportAuditEvent"]);
    expect(events()).toEqual([
      expect.objectContaining({
        eventType: "git_host.checked",
        subject: "admin",
        repository: null,
        details: expect.objectContaining({ passed: json.summary.pass, failed: json.summary.fail }),
      }),
    ]);
  });

  it("uses a named ready app's repository for the repository checks", async () => {
    const app = seedApp("alice");
    mockGitHubChecks();
    const { status, json } = await gitApp.call(
      "admin",
      "GET",
      `/api/admin/checklist?app=${app.id}`,
    );
    expect(status).toBe(200);
    expect(json.repository).toEqual({ owner: "acme-apps", name: "app-expenses" });
    expect(events()[0]).toMatchObject({ repository: { owner: "acme-apps", name: "app-expenses" } });
  });

  it("withholds the report when the audit entry is not stored", async () => {
    mockGitHubChecks();
    gitApp.weldall.fail(
      "reportAuditEvent",
      new WeldallAuthError("invalid_target", "not allowed", 403),
    );
    const { status, json } = await gitApp.call("admin", "GET", "/api/admin/checklist");
    expect(status).toBe(503);
    expect(json).toMatchObject({
      error: "audit_unavailable",
      error_description: expect.stringContaining("invalid_target"),
    });
  });
});
