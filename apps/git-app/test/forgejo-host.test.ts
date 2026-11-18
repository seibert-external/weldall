import { afterEach, describe, expect, it, vi } from "vitest";
import { GitAppError } from "../src/errors.js";
import type { GitHostCheck } from "../src/hosts/git-host.js";
import { forgejoBaseUrlProblem, parseForgejoConfiguration } from "../src/hosts/forgejo/config.js";
import { createForgejoHost, FORGEJO_PROTECTED_PATHS } from "../src/hosts/forgejo/host.js";
import { repositoryNameFor } from "../src/hosts/forgejo/repositories.js";
import { openConfiguredHost, parseHostConfiguration, parseHostSecret } from "../src/hosts/index.js";
import {
  BOT_TOKEN,
  defaultBranchCommit,
  FORGEJO_BASE_URL,
  forgejoConfig,
  headCommit,
  mockForgejo,
  templateCommit,
} from "./fixtures/forgejo-api.js";

const config = parseForgejoConfiguration(forgejoConfig);
const host = () =>
  createForgejoHost({
    config,
    loadToken: async () => BOT_TOKEN,
    timing: { readyTimeoutMs: 300, pollIntervalMs: 5 },
  });
const repository = { owner: "example-org", name: "app-expenses" };
const request = { template: "react", name: "Expenses", description: "Tracks team expenses" };
const signal = () => AbortSignal.timeout(5_000);
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (error: unknown) => error as GitAppError,
  );

afterEach(() => vi.unstubAllGlobals());

describe("configuration", () => {
  it.each([
    "https://forgejo.example.com",
    "https://git.example.com/forgejo",
    "https://forgejo.internal.example.com",
  ])("accepts %s", (value) => expect(forgejoBaseUrlProblem(value)).toBeNull());

  it.each([
    ["http://forgejo.example.com", "https"],
    ["https://bot:secret@forgejo.example.com", "credentials"],
    ["https://forgejo.example.com:3000", "port"],
    ["https://forgejo.example.com/", "canonical"],
    ["https://git.example.com/forgejo/", "canonical"],
    ["https://forgejo.example.com/?q=1", "query"],
    ["https://forgejo.example.com/#x", "query"],
    ["https://127.0.0.1", "IP address"],
    ["https://2130706433", "IP address"],
    ["https://[::1]", "IP address"],
    ["https://localhost", "local name"],
    ["https://forgejo.localhost", "local name"],
    ["https://forgejo.local", "local name"],
    ["https://forgejo", "local name"],
    ["https://metadata.google.internal", "local name"],
    ["https://localhost.", "local name"],
    ["https://forgejo.example.com.", "local name"],
    ["https://forgejo.example.com/a/../b", "canonical"],
  ])("rejects %s", (value, reason) => expect(forgejoBaseUrlProblem(value)).toContain(reason));

  it("rejects the reserved weldall-managed setup mode with the reason", () => {
    expect(() =>
      parseForgejoConfiguration({ ...forgejoConfig, setupMode: "weldall-managed" }),
    ).toThrow(/not available for Forgejo/);
  });

  it("defaults the status contexts that carry the links", () => {
    expect(config).toMatchObject({
      previewStatusContext: "weldall/preview",
      liveStatusContext: "weldall/live",
    });
  });
});

describe("host secret and configuration", () => {
  it("accepts the bot token as given and never echoes a malformed one", () => {
    expect(parseHostSecret("forgejo", ` ${BOT_TOKEN} `)).toBe(BOT_TOKEN);
    for (const token of ["short", `${BOT_TOKEN} with space`, "x".repeat(600)]) {
      const error = (() => {
        try {
          parseHostSecret("forgejo", token);
        } catch (caught) {
          return caught as Error;
        }
      })();
      expect(error).toBeInstanceOf(GitAppError);
      expect(error!.message).not.toContain(token);
    }
  });

  it("derives repository web URLs from configuration for both hosts", () => {
    const forgejo = openConfiguredHost({
      configuration: parseHostConfiguration("forgejo", forgejoConfig),
      secret: BOT_TOKEN,
    });
    expect(forgejo.repositoryWebUrl(repository)).toBe(
      `${FORGEJO_BASE_URL}/example-org/app-expenses`,
    );
    const github = openConfiguredHost({
      configuration: parseHostConfiguration("github", {
        appId: "1",
        organization: "acme",
        templates: [{ name: "r", repository: "acme/r" }],
        repositoryNamePrefix: "",
        reviewerTeam: "t",
        setupMode: "customer-managed",
      }),
      secret: "unused",
    });
    expect(github.repositoryWebUrl(repository)).toBe("https://github.com/example-org/app-expenses");
    expect(() =>
      parseHostConfiguration("forgejo", { ...forgejoConfig, baseUrl: "http://x" }),
    ).toThrow();
  });
});

describe("repository names", () => {
  it("lower-cases, applies the prefix and refuses Forgejo's reserved suffixes", () => {
    expect(repositoryNameFor(config, " Expenses ")).toBe("app-expenses");
    for (const name of ["", ".x", "a/b", "x.git", "x.wiki", "x.rss", "x.atom", "x".repeat(97)])
      expect(() => repositoryNameFor(config, name), name).toThrow(GitAppError);
  });
});

describe("createRepository", () => {
  it("creates a private repository with the template's protection and drops its own admin right", async () => {
    const mock = mockForgejo({ pendingPolls: 1 });
    const created: unknown[] = [];
    const result = await host().createRepository(
      { ...request, onCreated: async (value) => void created.push(value) },
      signal(),
    );
    expect(result).toEqual({
      repository: { owner: "example-org", name: "app-expenses", id: "42" },
      defaultBranch: "main",
      webUrl: `${FORGEJO_BASE_URL}/example-org/app-expenses`,
      templateCommit,
      warnings: [],
    });
    expect(created).toHaveLength(1);
    const generate = mock.calls.find(({ path }) => path.endsWith("/generate"))!;
    expect(generate.body).toEqual({
      owner: "example-org",
      name: "app-expenses",
      description: "Tracks team expenses",
      private: true,
      git_content: true,
      protected_branch: true,
    });
    const demote = mock.calls.find(({ method }) => method === "PUT")!;
    expect(demote.path).toBe("/api/v1/repos/example-org/app-expenses/collaborators/weldall-bot");
    expect(demote.body).toEqual({ permission: "write" });
    expect(mock.repositories.get("app-expenses")).toEqual({ admin: false });
    // The token only ever went to the configured instance.
    for (const call of mock.calls) expect(call.path.startsWith("/api/v1/")).toBe(true);
  });

  it("fails loudly when Forgejo created a public repository", async () => {
    mockForgejo({ repository: { private: false } });
    expect(await failure(host().createRepository(request, signal()))).toMatchObject({
      code: "repository_not_private",
    });
  });

  it("fails when the bot user keeps admin rights (owner of the organisation)", async () => {
    mockForgejo({ keepsAdmin: true });
    const error = await failure(host().createRepository(request, signal()));
    expect(error).toMatchObject({ code: "bot_user_too_privileged" });
    expect(error.message).toContain("owner of example-org");
  });

  it("fails when the reviewer team has no write access", async () => {
    mockForgejo({ teamAccess: { status: 404, body: {} } });
    expect(await failure(host().createRepository(request, signal()))).toMatchObject({
      code: "reviewer_team_access_missing",
    });
    mockForgejo({ teamAccess: { body: { name: "app-reviewers", permission: "read" } } });
    expect(await failure(host().createRepository(request, signal()))).toMatchObject({
      code: "reviewer_team_access_missing",
    });
  });

  it("warns when the default branch is not protected for the bot user", async () => {
    mockForgejo({ defaultBranch: { protected: true, required_approvals: 0, user_can_push: true } });
    const result = await host().createRepository(request, signal());
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "default_branch_unprotected" }),
    ]);
    expect(result.warnings[0]!.message).toContain("at least one required approval");
  });

  it.each([
    [404, "template_unavailable"],
    [409, "repository_exists"],
    [403, "repository_creation_not_permitted"],
    [422, "repository_refused"],
    [401, "credential_rejected"],
  ])("maps generate status %i to %s without forwarding Forgejo's text", async (status, code) => {
    mockForgejo({ generate: { status, body: { message: `secret ${BOT_TOKEN}` } } });
    const error = await failure(host().createRepository(request, signal()));
    expect(error).toMatchObject({ code });
    expect(error.message).not.toContain(BOT_TOKEN);
  });

  it("fails closed when Forgejo does not report the bot user's rights after lowering them", async () => {
    mockForgejo({ repository: { permissions: undefined } });
    expect(await failure(host().createRepository(request, signal()))).toMatchObject({
      code: "bot_rights_unverifiable",
    });
  });

  it("resumes an earlier attempt without creating again and drops a remaining admin right", async () => {
    const mock = mockForgejo();
    mock.repositories.set("app-expenses", { admin: true });
    const result = await host().createRepository(
      { ...request, resume: { owner: "example-org", name: "app-expenses" } },
      signal(),
    );
    expect(result.templateCommit).toBe(templateCommit);
    expect(mock.calls.some(({ path }) => path.endsWith("/generate"))).toBe(false);
    expect(mock.repositories.get("app-expenses")).toEqual({ admin: false });
  });

  it("refuses redirects instead of sending the token elsewhere", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("fetch failed: redirect mode is set to error");
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(host().createRepository(request, signal())).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({ origin: FORGEJO_BASE_URL }),
      expect.objectContaining({ redirect: "error" }),
    );
  });
});

describe("git proxy lookups", () => {
  it("forwards to the repository with the bot token as Basic password and no expiry", async () => {
    const target = await host().getForwardingTarget({ repository, access: "write" }, signal());
    expect(target.url.href).toBe(`${FORGEJO_BASE_URL}/example-org/app-expenses.git`);
    expect(target.expiresAt).toBeNull();
    expect(Buffer.from(target.authorization.replace(/^Basic /, ""), "base64").toString()).toBe(
      `weldall:${BOT_TOKEN}`,
    );
    await expect(
      host().getForwardingTarget(
        { repository: { owner: "other-org", name: "x" }, access: "read" },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "invalid_target" });
  });

  it("reports a branch's pull request state, open before merged before closed", async () => {
    const branch = "weldall/publish-1";
    mockForgejo({
      pulls: [
        { number: 1, ref: branch, state: "closed" },
        { number: 2, ref: branch, state: "closed", merged: true },
        { number: 3, ref: "weldall/publish-2", state: "closed" },
        { number: 4, ref: "weldall/publish-3", headRepository: "someone/fork" },
      ],
    });
    const state = (name: string) =>
      host().readBranchPullRequestState({ repository, branch: name }, signal());
    expect(await state(branch)).toBe("merged");
    expect(await state("weldall/publish-2")).toBe("closed");
    expect(await state("weldall/publish-3")).toBeNull();
    expect(await state("weldall/publish-9")).toBeNull();
  });

  it("fails closed when Forgejo ignores the head filter and more than a page exists", async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      number: index + 1,
      ref: `weldall/publish-${index < 5 ? "old" : `other-${index}`}`,
      state: "closed" as const,
    }));
    mockForgejo({ ignoreHeadFilter: true, pulls: many });
    await expect(
      host().readBranchPullRequestState({ repository, branch: "weldall/publish-old" }, signal()),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
    // Within one page an unfiltered answer is still complete.
    mockForgejo({ ignoreHeadFilter: true, pulls: many.slice(0, 10) });
    expect(
      await host().readBranchPullRequestState(
        { repository, branch: "weldall/publish-old" },
        signal(),
      ),
    ).toBe("closed");
  });
});

describe("pull requests", () => {
  const input = {
    repository,
    head: "weldall/publish-1",
    base: "main",
    title: "Expenses",
    body: "Published with Weldall",
  };

  it("opens a pull request, requests the reviewer team and lists commits oldest first", async () => {
    const mock = mockForgejo({ commitCount: 60 });
    const opened = await host().openPullRequest(input, signal());
    expect(opened).toMatchObject({
      created: true,
      number: 1,
      webUrl: `${FORGEJO_BASE_URL}/example-org/app-expenses/pulls/1`,
      headCommit,
      requestedReviewers: { users: [], teams: ["app-reviewers"] },
      warnings: [],
    });
    expect(opened.commits!.count).toBe(60);
    expect(opened.commits!.ids).toHaveLength(60);
    expect(opened.commits!.ids[0]).toBe("1".padStart(40, "0"));
    expect(opened.commits!.ids.at(-1)).toBe((60).toString(16).padStart(40, "0"));
    expect(mock.calls.find(({ path }) => path.endsWith("/requested_reviewers"))!.body).toEqual({
      team_reviewers: ["app-reviewers"],
    });
  });

  it("returns the open pull request of the branch instead of opening a second one", async () => {
    const mock = mockForgejo({
      pulls: [{ number: 5, ref: "weldall/publish-1", requestedTeams: ["app-reviewers"] }],
    });
    const opened = await host().openPullRequest(input, signal());
    expect(opened).toMatchObject({ created: false, number: 5 });
    expect(
      mock.calls.some(({ method, path }) => method === "POST" && path.endsWith("/pulls")),
    ).toBe(false);
  });

  it("turns a refused reviewer request into a warning", async () => {
    mockForgejo({
      reviewers: { status: 422, body: { message: "Reviewing team can't read repo" } },
    });
    const opened = await host().openPullRequest(input, signal());
    expect(opened.requestedReviewers.teams).toEqual([]);
    expect(opened.warnings).toEqual([
      expect.objectContaining({ code: "reviewer_request_refused" }),
    ]);
  });

  it("refuses a branch that does not exist", async () => {
    mockForgejo({ branches: [] });
    await expect(host().openPullRequest(input, signal())).rejects.toMatchObject({
      code: "branch_not_found",
    });
  });
});

describe("status", () => {
  it("reads reviews, statuses and the links from their status contexts", async () => {
    mockForgejo({
      pulls: [{ number: 1, ref: "weldall/publish-1" }],
      reviews: {
        body: [
          {
            user: { login: "reviewer" },
            state: "REQUEST_CHANGES",
            body: "Rename it",
            submitted_at: "2026-11-18T00:00:00Z",
          },
          { user: { login: "reviewer" }, state: "APPROVED", body: "", dismissed: true },
          { user: { login: "reviewer" }, state: "PENDING", body: "draft" },
          { user: null, state: "REQUEST_REVIEW", body: "" },
          { user: { login: "other" }, state: "COMMENT", body: "Note" },
        ],
      },
      headStatuses: {
        body: {
          state: "failure",
          statuses: [
            {
              context: "ci / build (push)",
              status: "pending",
              target_url: "/example-org/app-expenses/actions/runs/1/jobs/0",
            },
            { context: "ci/lint", status: "failure", target_url: "https://ci.example.com/2" },
            { context: "ci/warn", status: "warning", target_url: "javascript:alert(1)" },
            {
              context: "weldall/preview",
              status: "success",
              target_url: "https://preview.example.com/",
            },
          ],
        },
      },
      defaultBranchStatuses: {
        body: {
          statuses: [
            { context: "weldall/live", status: "success", target_url: "https://app.example.com/" },
          ],
        },
      },
    });
    const status = await host().readStatus(
      {
        repository,
        pullRequest: { publishBranch: (branch) => branch.startsWith("weldall/publish-") },
      },
      signal(),
    );
    expect(status.warnings).toEqual([]);
    expect(status.links).toEqual({
      preview: "https://preview.example.com/",
      live: "https://app.example.com/",
    });
    expect(status.pullRequest).toMatchObject({ number: 1, state: "open", headCommit });
    expect(status.pullRequest!.reviews.map(({ author, state }) => [author, state])).toEqual([
      ["reviewer", "changes_requested"],
      ["reviewer", "dismissed"],
      ["other", "commented"],
    ]);
    expect(status.pullRequest!.checks).toEqual([
      {
        name: "ci / build (push)",
        state: "pending",
        detailsUrl: `${FORGEJO_BASE_URL}/example-org/app-expenses/actions/runs/1/jobs/0`,
      },
      { name: "ci/lint", state: "failure", detailsUrl: "https://ci.example.com/2" },
      { name: "ci/warn", state: "neutral", detailsUrl: null },
      { name: "weldall/preview", state: "success", detailsUrl: "https://preview.example.com/" },
    ]);
  });

  it("ignores links of failed statuses or without https and reports unreadable parts as warnings", async () => {
    mockForgejo({
      pulls: [{ number: 1, ref: "weldall/publish-1", state: "closed", merged: true }],
      reviews: { status: 403, body: {} },
      headStatuses: {
        body: {
          statuses: [
            {
              context: "weldall/preview",
              status: "success",
              target_url: "http://insecure.example.com",
            },
          ],
        },
      },
      defaultBranchStatuses: {
        body: {
          statuses: [
            { context: "weldall/live", status: "failure", target_url: "https://app.example.com/" },
          ],
        },
      },
    });
    const status = await host().readStatus(
      { repository, pullRequest: { branch: "weldall/publish-1" } },
      signal(),
    );
    expect(status.pullRequest!.state).toBe("merged");
    expect(status.links).toEqual({ preview: null, live: null });
    expect(status.warnings).toEqual([
      expect.objectContaining({ code: "reviews_permission_missing" }),
    ]);
    expect(defaultBranchCommit).toHaveLength(40);
  });
});

describe("commit identity", () => {
  it("uses the bot user's login and primary email", async () => {
    mockForgejo();
    expect(await host().readCommitIdentity({ repository }, signal())).toEqual({
      name: "weldall-bot",
      email: "weldall-bot@example.com",
    });
  });

  it("refuses a token of another user", async () => {
    mockForgejo({ user: { body: { login: "a-person", email: "person@example.com" } } });
    await expect(host().readCommitIdentity({ repository }, signal())).rejects.toMatchObject({
      code: "commit_identity_unavailable",
    });
  });
});

describe("checkSetup", () => {
  const states = (checks: GitHostCheck[]) =>
    Object.fromEntries(checks.map(({ id, state }) => [id, state]));
  const existing = { owner: "example-org", name: "app-expenses", defaultBranch: "main" };

  it("passes every check for a correct set-up and reads only", async () => {
    const mock = mockForgejo();
    const checks = await host().checkSetup({ repository: existing }, signal());
    expect(states(checks)).toEqual({
      "bot-token": "pass",
      "token-scopes": "pass",
      "token-scopes-narrow": "pass",
      organization: "pass",
      "template.react": "pass",
      "template-protection.react": "pass",
      "reviewer-team": "pass",
      "reviewer-team-access": "pass",
      "bot-repository-access": "pass",
      "branch-rule": "pass",
      "actions-workflows": "pass",
      "commit-identity": "pass",
    });
    expect(mock.calls.every(({ method }) => method === "GET")).toBe(true);
    expect(JSON.stringify(checks)).not.toContain(BOT_TOKEN);
  });

  it.each([
    [{ templateActions: true }, "fail", "example-org/react-starter"],
    [{ repositoryActions: true }, "fail", "example-org/app-expenses"],
    [
      { template: { body: { owner: { login: "example-org" }, template: true } } },
      "unverifiable",
      "",
    ],
  ])(
    "never passes the Actions check while Actions may be on: %j",
    async (scenario, state, named) => {
      mockForgejo(scenario);
      const check = (await host().checkSetup({ repository: existing }, signal())).find(
        ({ id }) => id === "actions-workflows",
      )!;
      expect(check).toMatchObject({ state, required: false });
      expect(check.reason).toContain(named);
      expect(check.reason).toContain("before review");
      expect(check.action).toContain("Actions");
    },
  );

  it("states the workflow risk even when Actions is off", async () => {
    mockForgejo();
    const check = (await host().checkSetup({ repository: null }, signal())).find(
      ({ id }) => id === "actions-workflows",
    )!;
    expect(check.state).toBe("pass");
    expect(check.reason).toContain("If it is switched on later");
  });

  it("reports what needs a repository as unverifiable before one exists", async () => {
    mockForgejo();
    const checks = states(await host().checkSetup({ repository: null }, signal()));
    expect(checks["reviewer-team-access"]).toBe("unverifiable");
    expect(checks["bot-repository-access"]).toBe("unverifiable");
    expect(checks["branch-rule"]).toBe("unverifiable");
  });

  it.each([
    [{ user: { body: { login: "a-person", email: "p@example.com" } } }, "bot-token"],
    [
      { user: { body: { login: "weldall-bot", email: "b@example.com", is_admin: true } } },
      "bot-token",
    ],
    [{ tokenScopes: ["write:repository", "read:user"] }, "token-scopes"],
    [{ tokenRepositories: ["app-expenses"] }, "token-scopes"],
    [{ tokenScopes: ["all"] }, "token-scopes-narrow"],
    [
      { organizationPermissions: { body: { is_owner: true, can_create_repository: true } } },
      "organization",
    ],
    [
      { organizationPermissions: { body: { is_owner: false, can_create_repository: false } } },
      "organization",
    ],
    [
      { template: { body: { owner: { login: "example-org" }, template: false } } },
      "template.react",
    ],
    [{ defaultBranch: { protected: false } }, "template-protection.react"],
    [
      {
        teams: {
          body: [{ name: "app-reviewers", permission: "write", includes_all_repositories: false }],
        },
      },
      "reviewer-team",
    ],
    [{ teams: { body: [] } }, "reviewer-team"],
    [{ teamAccess: { status: 404, body: {} } }, "reviewer-team-access"],
    [{ repository: { permissions: { admin: true } } }, "bot-repository-access"],
    [{ defaultBranch: { user_can_push: true } }, "branch-rule"],
  ])("fails %j in %s", async (scenario, id) => {
    mockForgejo(scenario);
    const check = (await host().checkSetup({ repository: existing }, signal())).find(
      (candidate) => candidate.id === id,
    )!;
    expect(check.state).toBe("fail");
    expect(check.action).toBeTruthy();
  });

  it("stops after a rejected token and reports the rest as unverifiable", async () => {
    mockForgejo({ user: { status: 401, body: {} } });
    const checks = await host().checkSetup({ repository: existing }, signal());
    expect(checks[0]).toMatchObject({ id: "bot-token", state: "fail" });
    expect(checks.slice(1).every(({ state }) => state === "unverifiable")).toBe(true);
  });
});

it("keeps the workflow directories of Forgejo Actions out of a publish", () => {
  expect(FORGEJO_PROTECTED_PATHS).toEqual([
    ".forgejo/workflows",
    ".gitea/workflows",
    ".github/workflows",
  ]);
});
