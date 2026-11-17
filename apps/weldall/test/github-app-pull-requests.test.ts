import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGitHubAppConfiguration } from "../src/server/connectors/providers/github-app/config";
import {
  createGitHubAppHost,
  GITHUB_OPERATION_PERMISSIONS,
} from "../src/server/connectors/providers/github-app/host";
import { parseGitHubAppPrivateKey } from "../src/server/connectors/providers/github-app/private-key";
import { createInstallationTokenCache } from "../src/server/connectors/providers/github-app/tokens";
import { createCommitIdentityCache } from "../src/server/connectors/providers/github-app/identity";
import {
  botIdentity,
  headCommit,
  mockGitHubPullRequests,
  productionCommit,
  templateCommit,
  type PullRequestScenario,
} from "./fixtures/github-api";

const pkcs8 = parseGitHubAppPrivateKey(
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  }).privateKey,
);
const baseConfig = {
  appId: "123456",
  organization: "acme-apps",
  installationId: "987654",
  templates: [{ name: "react", repository: "acme-apps/react-starter" }],
  repositoryNamePrefix: "app-",
  reviewerTeam: "app-reviewers",
  setupMode: "customer-managed",
};
const host = (config: object = baseConfig) =>
  createGitHubAppHost({
    config: parseGitHubAppConfiguration(config),
    loadPrivateKey: async () => pkcs8,
    tokens: createInstallationTokenCache(),
  });
const repository = { owner: "acme-apps", name: "app-expenses" };
const head = "weldall/publish-1";
const open = { repository, head, base: "main", title: "Add receipts", body: "Body" };
const signal = () => AbortSignal.timeout(5_000);
const current = {
  repository,
  pullRequest: {
    publishBranch: (branch: string) =>
      branch.startsWith("weldall/publish-") && !branch.includes(".."),
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("GitHub pull request permissions", () => {
  it("requests one repository-restricted token per operation and status part", () => {
    expect(GITHUB_OPERATION_PERMISSIONS).toMatchObject({
      openPullRequest: { contents: "read", pull_requests: "write" },
      readPullRequest: { pull_requests: "read" },
      readChecks: { checks: "read" },
      readCommitStatuses: { statuses: "read" },
      readDeployments: { deployments: "read" },
    });
  });

  it("defaults the live deployment environment to production", () => {
    expect(parseGitHubAppConfiguration(baseConfig).liveEnvironments).toEqual(["production"]);
    expect(() =>
      parseGitHubAppConfiguration({ ...baseConfig, liveEnvironments: ["prod\nuction"] }),
    ).toThrow();
  });
});

describe("commit identity for published commits", () => {
  const identityHost = (identities = createCommitIdentityCache()) =>
    createGitHubAppHost({
      config: parseGitHubAppConfiguration(baseConfig),
      loadPrivateKey: async () => pkcs8,
      tokens: createInstallationTokenCache(),
      identities,
    });

  it("reads the bot account's id from GitHub and caches it per App", async () => {
    const github = mockGitHubPullRequests();
    const identities = createCommitIdentityCache();
    const host = identityHost(identities);
    expect(host.protectedPaths).toEqual([".github/workflows"]);
    await expect(host.readCommitIdentity({ repository }, signal())).resolves.toEqual(botIdentity);
    await expect(
      identityHost(identities).readCommitIdentity({ repository }, signal()),
    ).resolves.toEqual(botIdentity);

    const requests = github.calls.filter(({ path }) => !path.endsWith("/access_tokens"));
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /app",
      "GET /users/weldall-app%5Bbot%5D",
    ]);
    // The App endpoint takes the App JWT, the user lookup an installation token.
    expect(requests[0]!.headers.get("authorization")).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(requests[1]!.headers.get("authorization")).toMatch(/^Bearer ghs_pr_/);
    expect(github.tokenRequests()).toEqual([
      { repositories: ["app-expenses"], permissions: { metadata: "read" } },
    ]);
  });

  it("never derives an identity GitHub did not confirm", async () => {
    mockGitHubPullRequests({ botUser: { body: { id: 5, login: "weldall-app", type: "User" } } });
    await expect(identityHost().readCommitIdentity({ repository }, signal())).rejects.toMatchObject(
      { code: "commit_identity_unavailable" },
    );
    mockGitHubPullRequests({ app: { status: 401, body: {} } });
    await expect(identityHost().readCommitIdentity({ repository }, signal())).rejects.toMatchObject(
      { code: "commit_identity_unavailable" },
    );
    await expect(
      identityHost().readCommitIdentity(
        { repository: { owner: "other", name: "app-expenses" } },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "invalid_target" });
  });
});

describe("opening a pull request on GitHub", () => {
  it("checks the branch, opens the pull request, requests the team and reads its commits", async () => {
    const github = mockGitHubPullRequests();
    const opened = await host().openPullRequest(open, signal());

    expect(opened).toEqual({
      created: true,
      number: 1,
      webUrl: "https://github.com/acme-apps/app-expenses/pull/1",
      headBranch: head,
      baseBranch: "main",
      headCommit,
      commits: { ids: [templateCommit, headCommit], count: 2 },
      requestedReviewers: { users: [], teams: ["app-reviewers"] },
      warnings: [],
    });
    const requests = github.calls.filter(({ path }) => !path.endsWith("/access_tokens"));
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /repos/acme-apps/app-expenses/branches/weldall/publish-1",
      "GET /repos/acme-apps/app-expenses/pulls?state=open&head=acme-apps%3Aweldall%2Fpublish-1&per_page=10",
      "POST /repos/acme-apps/app-expenses/pulls",
      "POST /repos/acme-apps/app-expenses/pulls/1/requested_reviewers",
      "GET /repos/acme-apps/app-expenses/pulls/1/commits?per_page=100",
    ]);
    expect(requests[2]!.body).toEqual({
      title: "Add receipts",
      head,
      base: "main",
      body: "Body",
    });
    expect(requests[3]!.body).toEqual({ team_reviewers: ["app-reviewers"] });
    expect(github.tokenRequests()).toEqual([
      {
        repositories: ["app-expenses"],
        permissions: { contents: "read", pull_requests: "write" },
      },
    ]);
  });

  it("returns the open pull request of the branch instead of opening a second one", async () => {
    const github = mockGitHubPullRequests({
      pulls: [
        { number: 3, ref: head, state: "closed" },
        { number: 4, ref: head, requestedTeams: ["app-reviewers"] },
      ],
    });
    const opened = await host().openPullRequest(open, signal());

    expect(opened).toMatchObject({
      created: false,
      number: 4,
      requestedReviewers: { users: [], teams: ["app-reviewers"] },
      warnings: [],
    });
    expect(
      github.calls.filter(({ method, path }) => method === "POST" && path.includes("/pulls")),
    ).toEqual([]);
  });

  it("returns the pull request a concurrent call opened first", async () => {
    const github = mockGitHubPullRequests({
      create: { status: 422, body: { message: "A pull request already exists" } },
    });
    // The concurrent call's pull request appears between the lookup and the create.
    const fetcher = globalThis.fetch;
    let lookups = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/pulls?") && (lookups += 1) === 2)
        github.pulls.push({ number: 9, ref: head });
      return fetcher(input, init);
    });
    await expect(host().openPullRequest(open, signal())).resolves.toMatchObject({
      created: false,
      number: 9,
    });
  });

  it("requests the team again on an open pull request nobody was requested for or reviewed", async () => {
    const github = mockGitHubPullRequests({ pulls: [{ number: 4, ref: head }] });
    await expect(host().openPullRequest(open, signal())).resolves.toMatchObject({
      created: false,
      number: 4,
      requestedReviewers: { users: [], teams: ["app-reviewers"] },
      warnings: [],
    });
    expect(
      github.calls.filter(({ path }) => path.endsWith("/pulls/4/requested_reviewers")),
    ).toHaveLength(1);
  });

  it("does not ask again once someone reviewed, and repeats a refused request as a warning", async () => {
    const reviewed = mockGitHubPullRequests({
      pulls: [{ number: 4, ref: head }],
      reviews: { body: [{ user: { login: "rita" }, state: "APPROVED", body: "" }] },
    });
    await expect(host().openPullRequest(open, signal())).resolves.toMatchObject({
      requestedReviewers: { teams: [] },
      warnings: [],
    });
    expect(reviewed.calls.some(({ path }) => path.endsWith("/requested_reviewers"))).toBe(false);

    vi.unstubAllGlobals();
    mockGitHubPullRequests({
      pulls: [{ number: 4, ref: head }],
      reviewers: {
        status: 422,
        body: { message: "Reviews may only be requested from collaborators." },
      },
    });
    const retried = await host().openPullRequest(open, signal());
    expect(retried.warnings.map(({ code }) => code)).toEqual(["reviewer_request_refused"]);
  });

  it("reads a secondary rate limit on the reviewer request as a failure, not a missing permission", async () => {
    mockGitHubPullRequests({
      reviewers: {
        status: 403,
        body: { message: "You have exceeded a secondary rate limit." },
        headers: { "retry-after": "60" },
      },
    });
    const opened = await host().openPullRequest(open, signal());
    expect(opened.warnings.map(({ code }) => code)).toEqual(["reviewer_request_failed"]);
  });

  it("refuses a head branch that does not exist", async () => {
    mockGitHubPullRequests({ branches: [] });
    await expect(host().openPullRequest(open, signal())).rejects.toMatchObject({
      code: "branch_not_found",
      status: 409,
    });
  });

  it("reports a branch without new commits", async () => {
    mockGitHubPullRequests({
      create: { status: 422, body: { message: "No commits between main and weldall/publish-1" } },
    });
    await expect(host().openPullRequest(open, signal())).rejects.toMatchObject({
      code: "nothing_to_publish",
    });
  });

  it("names the missing permission when GitHub refuses the token", async () => {
    mockGitHubPullRequests({ refusePermissions: ["pull_requests"] });
    await expect(host().openPullRequest(open, signal())).rejects.toMatchObject({
      code: "pull_requests_not_permitted",
      message: expect.stringContaining('"Pull requests: write"'),
    });
  });

  it.each<[string, NonNullable<PullRequestScenario["reviewers"]>, string]>([
    [
      "refused",
      { status: 422, body: { message: "Reviews may only be requested from collaborators." } },
      "reviewer_request_refused",
    ],
    [
      "not permitted",
      { status: 403, body: { message: "Resource not accessible by integration" } },
      "reviewer_request_not_permitted",
    ],
    [
      "silently ignored",
      {
        status: 201,
        body: {
          number: 1,
          state: "open",
          head: { ref: head, sha: headCommit },
          base: { ref: "main" },
          requested_teams: [],
        },
      },
      "reviewer_request_ignored",
    ],
    ["failing", { status: 500 }, "reviewer_request_failed"],
  ])("keeps the pull request open when the reviewer request is %s", async (_, reviewers, code) => {
    mockGitHubPullRequests({ reviewers });
    const opened = await host().openPullRequest(open, signal());
    expect(opened).toMatchObject({
      created: true,
      number: 1,
      requestedReviewers: { users: [], teams: [] },
      commits: { ids: [templateCommit, headCommit] },
    });
    expect(opened.warnings).toEqual([{ code, message: expect.stringContaining("app-reviewers") }]);
    expect(opened.warnings[0]!.message).toContain("#1");
  });

  it("keeps the pull request when its commits cannot be read", async () => {
    mockGitHubPullRequests({ commits: { status: 500 } });
    const opened = await host().openPullRequest(open, signal());
    expect(opened).toMatchObject({ created: true, commits: null });
    expect(opened.warnings.map(({ code }) => code)).toEqual(["commits_unreadable"]);
  });

  it("refuses repositories outside the organisation", async () => {
    mockGitHubPullRequests();
    await expect(
      host().openPullRequest({ ...open, repository: { owner: "other", name: "x" } }, signal()),
    ).rejects.toMatchObject({ code: "invalid_target" });
  });
});

describe("reading the status from GitHub", () => {
  const deployments = [
    {
      id: 10,
      environment: "preview",
      sha: headCommit,
      statuses: [{ state: "success", environment_url: "https://preview.example.com/pr-1" }],
    },
    {
      id: 11,
      environment: "production",
      sha: productionCommit,
      statuses: [{ state: "success", environment_url: "https://app.example.com/" }],
    },
  ];
  const full: PullRequestScenario = {
    pulls: [
      { number: 1, ref: "weldall/publish-old", state: "closed", merged: true },
      { number: 2, ref: "feature/by-reviewer" },
      { number: 3, ref: head },
    ],
    reviews: {
      body: [
        {
          user: { login: "rita" },
          state: "CHANGES_REQUESTED",
          body: "Fix the total",
          submitted_at: "2026-11-17T09:00:00Z",
        },
        { user: { login: "rita" }, state: "PENDING", body: "draft" },
        { user: null, state: "APPROVED", body: null, submitted_at: "2026-11-17T11:00:00Z" },
      ],
    },
    checkRuns: {
      body: {
        total_count: 3,
        check_runs: [
          {
            name: "build",
            status: "completed",
            conclusion: "success",
            details_url: "https://ci.example.com/1",
          },
          {
            name: "test",
            status: "completed",
            conclusion: "timed_out",
            details_url: null,
            html_url: "https://github.com/acme-apps/app-expenses/runs/2",
          },
          { name: "lint", status: "in_progress", conclusion: null },
        ],
      },
    },
    statuses: {
      body: {
        statuses: [{ context: "vercel", state: "error", target_url: "https://vercel.com/x" }],
      },
    },
    deployments,
  };

  it("reads the current publish pull request with reviews, checks and links", async () => {
    const github = mockGitHubPullRequests(full);
    const status = await host({ ...baseConfig, liveEnvironments: ["production"] }).readStatus(
      current,
      signal(),
    );

    expect(status).toEqual({
      pullRequest: {
        number: 3,
        webUrl: "https://github.com/acme-apps/app-expenses/pull/3",
        state: "open",
        headBranch: head,
        headCommit,
        reviews: [
          {
            author: "rita",
            state: "changes_requested",
            body: "Fix the total",
            submittedAt: new Date("2026-11-17T09:00:00Z"),
          },
          {
            author: "ghost",
            state: "approved",
            body: "",
            submittedAt: new Date("2026-11-17T11:00:00Z"),
          },
        ],
        checks: [
          { name: "build", state: "success", detailsUrl: "https://ci.example.com/1" },
          {
            name: "test",
            state: "failure",
            detailsUrl: "https://github.com/acme-apps/app-expenses/runs/2",
          },
          { name: "lint", state: "pending", detailsUrl: null },
          { name: "vercel", state: "failure", detailsUrl: "https://vercel.com/x" },
        ],
      },
      links: { preview: "https://preview.example.com/pr-1", live: "https://app.example.com/" },
      warnings: [],
    });
    // One token per part, each restricted to the repository.
    expect(github.tokenRequests()).toEqual(
      expect.arrayContaining(
        ["pull_requests", "checks", "statuses", "deployments"].map((name) => ({
          repositories: ["app-expenses"],
          permissions: { [name]: "read" },
        })),
      ),
    );
    expect(github.tokenRequests()).toHaveLength(4);
  });

  it("falls back to the most recent closed or merged publish pull request", async () => {
    mockGitHubPullRequests({
      pulls: [
        { number: 1, ref: "weldall/publish-1", state: "closed", merged: true },
        { number: 2, ref: "feature/by-reviewer" },
      ],
    });
    const status = await host().readStatus(current, signal());
    expect(status.pullRequest).toMatchObject({ number: 1, state: "merged" });
  });

  it("reads the pull request of a named branch and ignores pull requests from forks", async () => {
    mockGitHubPullRequests({
      pulls: [
        { number: 1, ref: head, state: "closed" },
        { number: 2, ref: head, headRepository: "someone/fork" },
      ],
    });
    const status = await host().readStatus({ repository, pullRequest: { branch: head } }, signal());
    expect(status.pullRequest).toMatchObject({ number: 1, state: "closed" });
  });

  it("returns only the live link when no publish pull request exists", async () => {
    mockGitHubPullRequests({ deployments });
    await expect(host().readStatus(current, signal())).resolves.toEqual({
      pullRequest: null,
      links: { preview: null, live: "https://app.example.com/" },
      warnings: [],
    });
  });

  it("ignores links of failed or newer unsuccessful deployments and non-https links", async () => {
    mockGitHubPullRequests({
      pulls: [{ number: 3, ref: head }],
      deployments: [
        {
          id: 20,
          environment: "preview",
          sha: headCommit,
          statuses: [
            { state: "failure", environment_url: "https://broken.example.com" },
            { state: "success", environment_url: "https://old.example.com" },
          ],
        },
        {
          id: 19,
          environment: "preview",
          sha: headCommit,
          statuses: [{ state: "success", environment_url: "http://insecure.example.com" }],
        },
        {
          id: 18,
          environment: "preview",
          sha: headCommit,
          statuses: [{ state: "success", environment_url: "https://good.example.com" }],
        },
      ],
    });
    const status = await host().readStatus(current, signal());
    expect(status.links).toEqual({ preview: "https://good.example.com/", live: null });
  });

  it.each([
    ["checks", "checks_permission_missing", '"Checks: read"'],
    ["statuses", "statuses_permission_missing", '"Commit statuses: read"'],
    ["deployments", "deployments_permission_missing", '"Deployments: read"'],
  ])("degrades when the installation lacks %s", async (permission, code, label) => {
    mockGitHubPullRequests({ ...full, refusePermissions: [permission] });
    const status = await host().readStatus(current, signal());
    expect(status.pullRequest).toMatchObject({ number: 3, state: "open" });
    expect(status.warnings).toEqual([{ code, message: expect.stringContaining(label) }]);
    if (permission === "deployments") expect(status.links).toEqual({ preview: null, live: null });
    else expect(status.links.live).toBe("https://app.example.com/");
  });

  it.each([
    ["a retry-after header", { "retry-after": "30" }, { message: "Forbidden" }],
    ["a rate limit message", {}, { message: "You have exceeded a secondary rate limit" }],
    ["no remaining requests", { "x-ratelimit-remaining": "0" }, { message: "Forbidden" }],
  ])(
    "treats a 403 with %s as rate limited, not as a missing permission",
    async (_, headers, body) => {
      mockGitHubPullRequests({ ...full, checkRuns: { status: 403, headers, body } });
      const status = await host().readStatus(current, signal());
      expect(status.warnings).toEqual([
        { code: "checks_unavailable", message: expect.stringContaining("rate limiting") },
      ]);
    },
  );

  it("treats 429 as rate limited", async () => {
    mockGitHubPullRequests({ ...full, statuses: { status: 429, body: { message: "Too many" } } });
    const status = await host().readStatus(current, signal());
    expect(status.warnings.map(({ code }) => code)).toEqual(["statuses_unavailable"]);
  });

  it("ignores pull requests from deleted forks and branches the publish rule refuses", async () => {
    mockGitHubPullRequests({
      pulls: [
        { number: 1, ref: "weldall/publish-1", state: "closed" },
        { number: 2, ref: "weldall/publish-2", headRepository: null },
        { number: 3, ref: "weldall/publish-a..b" },
      ],
    });
    const status = await host().readStatus(current, signal());
    expect(status.pullRequest).toMatchObject({ number: 1 });
  });

  it("degrades on a 403 when reading checks, statuses and deployments", async () => {
    mockGitHubPullRequests({
      ...full,
      checkRuns: { status: 403, body: { message: "Resource not accessible by integration" } },
      statuses: { status: 403, body: { message: "Resource not accessible by integration" } },
      deploymentsStatus: 403,
    });
    const status = await host().readStatus(current, signal());
    expect(status.pullRequest?.checks).toEqual([]);
    expect(status.pullRequest?.reviews).toHaveLength(2);
    expect(status.warnings.map(({ code }) => code).sort()).toEqual([
      "checks_permission_missing",
      "deployments_permission_missing",
      "statuses_permission_missing",
    ]);
  });

  it("degrades without the pull request permission and still reads the live link", async () => {
    mockGitHubPullRequests({ ...full, refusePermissions: ["pull_requests"] });
    const status = await host().readStatus(current, signal());
    expect(status).toMatchObject({
      pullRequest: null,
      links: { preview: null, live: "https://app.example.com/" },
      warnings: [
        {
          code: "pull_requests_permission_missing",
          message: expect.stringContaining('"Pull requests: read"'),
        },
      ],
    });
  });

  it("keeps the pull request when its reviews cannot be read", async () => {
    mockGitHubPullRequests({ ...full, reviews: { status: 500 } });
    const status = await host().readStatus(current, signal());
    expect(status.pullRequest).toMatchObject({ number: 3, reviews: [] });
    expect(status.warnings.map(({ code }) => code)).toEqual(["reviews_unavailable"]);
  });

  it("warns when GitHub has more check runs than it listed", async () => {
    mockGitHubPullRequests({
      ...full,
      checkRuns: { body: { total_count: 80, check_runs: [] } },
    });
    const status = await host().readStatus(current, signal());
    expect(status.warnings.map(({ code }) => code)).toEqual(["checks_truncated"]);
  });

  it("fails when GitHub cannot list the pull requests at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/access_tokens")) {
          const body = JSON.parse(String(init?.body));
          return Response.json(
            {
              token: "ghs_x_token",
              expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
              permissions: body.permissions,
              repositories: [{ name: "app-expenses" }],
            },
            { status: 201 },
          );
        }
        return Response.json({ message: "Server Error" }, { status: 500 });
      }),
    );
    await expect(host().readStatus(current, signal())).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
  });
});
