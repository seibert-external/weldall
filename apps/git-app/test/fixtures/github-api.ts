import { vi } from "vitest";

/**
 * Mocked GitHub REST API for repository creation (organisation `acme-apps`, template
 * `acme-apps/react-starter`, new repository `app-expenses`, reviewer team `app-reviewers`,
 * installation 987654). Replaces the global fetch; no request reaches GitHub.
 */
export const templateCommit = "c".repeat(40);
export const fullRules = [
  { type: "pull_request", parameters: { required_approving_review_count: 1 } },
  { type: "non_fast_forward" },
  { type: "deletion" },
];

export interface GitHubScenario {
  /** Overrides the `generate` response. */
  generate?: { status: number; body?: unknown };
  repository?: Record<string, unknown>;
  /** Branch polls answered 404/409 before 200; Infinity never succeeds. */
  pendingPolls?: number;
  /** Token requests answered 422 for the new repository before one is issued. */
  refusedNewRepositoryTokens?: number;
  /**
   * A permission the installation lacks: requesting it gives 422 ("not granted to this
   * installation"), and an installation-wide token comes without it.
   */
  refusePermission?: string;
  rules?: { status: number; body?: unknown };
  team?: { status: number; body?: unknown };
}

type Call = { method: string; path: string; headers: Headers; body: any };

/** Organisation permissions, as `PERMISSION_LABELS` in `github-app/checks.ts` classifies them. */
const organizationPermissions = new Set(["members", "repository_creation"]);

/**
 * What GitHub confirms for a token request with `permissions`: a token without any repository
 * permission carries neither `metadata` nor `repositories`, even when it was restricted to
 * repositories (measured 18.11.2026).
 */
function grantedScope(permissions: Record<string, string>, repositories: string[] | undefined) {
  const names = Object.keys(permissions);
  if (names.length && names.every((name) => organizationPermissions.has(name)))
    return { permissions };
  return {
    permissions: { metadata: "read", ...permissions },
    ...(repositories ? { repositories: repositories.map((name) => ({ name })) } : {}),
  };
}

export function mockGitHub(scenario: GitHubScenario = {}) {
  const calls: Call[] = [];
  let polls = 0;
  let refusedTokens = 0;
  let issued = 0;
  /** Tokens minted with an empty body carry every installation permission on every repository. */
  const installationWide = new Set<string>();
  const installationPermissions = Object.fromEntries(
    Object.entries({
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      repository_creation: "write",
      members: "read",
    }).filter(([name]) => name !== scenario.refusePermission),
  );
  const repository = (name: string) => ({
    id:
      name === "app-expenses"
        ? 4242
        : 10_000 + [...name].reduce((sum, c) => sum + c.charCodeAt(0), 0),
    name,
    owner: { login: "acme-apps" },
    private: true,
    visibility: "private",
    default_branch: "main",
    ...scenario.repository,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        method: init?.method ?? "GET",
        path,
        headers: new Headers(init?.headers),
        body,
      });
      if (path === "/app/installations/987654/access_tokens") {
        const [name] = (body.repositories ?? []) as string[];
        if (!body.repositories && !body.permissions) {
          issued += 1;
          installationWide.add(`ghs_test_${issued}`);
          return Response.json(
            {
              token: `ghs_test_${issued}`,
              expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
              permissions: installationPermissions,
              repository_selection: "selected",
            },
            { status: 201 },
          );
        }
        if (scenario.refusePermission && scenario.refusePermission in body.permissions)
          return Response.json({ message: "not granted" }, { status: 422 });
        if (name && refusedTokens < (scenario.refusedNewRepositoryTokens ?? 0)) {
          refusedTokens += 1;
          return Response.json({ message: "not accessible" }, { status: 422 });
        }
        issued += 1;
        return Response.json(
          {
            token: `ghs_test_${issued}`,
            expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
            repository_selection: "selected",
            ...grantedScope(body.permissions, name ? [name] : undefined),
          },
          { status: 201 },
        );
      }
      if (path === "/repos/acme-apps/react-starter/generate") {
        // Measured on GitHub (17.11.2026): only an installation-wide token can copy the template.
        const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
        if (!installationWide.has(token ?? ""))
          return Response.json(
            {
              message:
                "Could not clone: Cloning user does not have permission to view the clone repository",
            },
            { status: 422 },
          );
        return scenario.generate
          ? Response.json(scenario.generate.body ?? {}, { status: scenario.generate.status })
          : Response.json(repository(body.name), { status: 201 });
      }
      const team = /^\/orgs\/acme-apps\/teams\/app-reviewers\/repos\/acme-apps\/[^/]+$/.test(path);
      if (team)
        return Response.json(
          scenario.team?.body ?? { permissions: { admin: false, push: true, pull: true } },
          { status: scenario.team?.status ?? 200 },
        );
      const [, name, rest] = /^\/repos\/acme-apps\/([^/]+)(\/.*)?$/.exec(path) ?? [];
      if (name && !rest) return Response.json(repository(name));
      if (name && rest === "/branches/main") {
        polls += 1;
        if (polls <= (scenario.pendingPolls ?? 1))
          return Response.json({ message: "pending" }, { status: polls % 2 ? 404 : 409 });
        return Response.json({ name: "main", commit: { sha: templateCommit } });
      }
      if (name && rest === "/rules/branches/main")
        return Response.json(scenario.rules?.body ?? fullRules, {
          status: scenario.rules?.status ?? 200,
        });
      return Response.json({ message: "unexpected" }, { status: 500 });
    }),
  );
  const tokenRequests = () =>
    calls.filter(({ path }) => path.endsWith("/access_tokens")).map(({ body }) => body);
  return { calls, tokenRequests };
}

export const headCommit = "a".repeat(40);
export const productionCommit = "b".repeat(40);

export interface PullFixture {
  number: number;
  ref: string;
  sha?: string;
  state?: "open" | "closed";
  merged?: boolean;
  /** Head repository; defaults to the pull request's own repository, null for a deleted fork. */
  headRepository?: string | null;
  requestedTeams?: string[];
}
export interface DeploymentFixture {
  id: number;
  environment: string;
  sha: string;
  /** Newest first, as GitHub lists them. */
  statuses: { state: string; environment_url?: string | null }[];
}
type Override = { status?: number; body?: unknown; headers?: Record<string, string> };
export interface PullRequestScenario {
  /** Repository name in `acme-apps`; default `app-expenses`. */
  repository?: string;
  /** Branches that exist; default every branch. */
  branches?: string[];
  pulls?: PullFixture[];
  /** Overrides the create response. */
  create?: { status: number; body?: unknown };
  reviewers?: { status: number; body?: unknown; headers?: Record<string, string> };
  commits?: { status: number; body?: unknown };
  reviews?: Override;
  checkRuns?: Override;
  statuses?: Override;
  deployments?: DeploymentFixture[];
  deploymentsStatus?: number;
  /** Permission names GitHub refuses to put in a token (422 "not granted to this installation"). */
  refusePermissions?: string[];
  /** Overrides `GET /app` and `GET /users/weldall-app[bot]` (the commit identity lookup). */
  app?: Override;
  botUser?: Override;
}

/** The App's bot user in the mocked API: slug `weldall-app`, bot user id 41898282. */
export const botIdentity = {
  name: "weldall-app[bot]",
  email: "41898282+weldall-app[bot]@users.noreply.github.com",
};

/**
 * Mocked GitHub REST API for pull requests and their status in `acme-apps/<repository>`
 * (installation 987654). Pull requests are kept in memory, so a created one is found by the
 * next lookup. Replaces the global fetch; no request reaches GitHub.
 */
export function mockGitHubPullRequests(scenario: PullRequestScenario = {}) {
  const repositoryName = scenario.repository ?? "app-expenses";
  const fullName = `acme-apps/${repositoryName}`;
  const calls: Call[] = [];
  const pulls = [...(scenario.pulls ?? [])];
  let issued = 0;
  const pullJson = (pull: PullFixture) => ({
    number: pull.number,
    state: pull.state ?? "open",
    merged_at: pull.merged ? "2026-11-17T10:00:00Z" : null,
    created_at: `2026-11-${String(pull.number).padStart(2, "0")}T10:00:00Z`,
    head: {
      ref: pull.ref,
      sha: pull.sha ?? headCommit,
      repo: pull.headRepository === null ? null : { full_name: pull.headRepository ?? fullName },
    },
    base: { ref: "main", repo: { full_name: fullName } },
    requested_reviewers: [],
    requested_teams: (pull.requestedTeams ?? []).map((slug) => ({ slug })),
    user: { login: "weldall-app[bot]" },
  });
  const reply = (override: Override | undefined, body: unknown) =>
    Response.json(override?.body ?? body, {
      status: override?.status ?? 200,
      headers: override?.headers ?? {},
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const query = url.searchParams;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        method,
        path: `${path}${url.search}`,
        headers: new Headers(init?.headers),
        body,
      });
      if (path === "/app/installations/987654/access_tokens") {
        const refused = Object.keys(body.permissions).filter((name) =>
          scenario.refusePermissions?.includes(name),
        );
        if (refused.length) return Response.json({ message: "not granted" }, { status: 422 });
        issued += 1;
        return Response.json(
          {
            token: `ghs_pr_${issued}`,
            expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
            ...grantedScope(body.permissions, body.repositories),
          },
          { status: 201 },
        );
      }
      if (path === "/app") return reply(scenario.app, { id: 123456, slug: "weldall-app" });
      if (path === "/users/weldall-app%5Bbot%5D")
        return reply(scenario.botUser, { id: 41898282, login: "weldall-app[bot]", type: "Bot" });
      const prefix = `/repos/${fullName}`;
      if (!path.startsWith(`${prefix}/`)) return Response.json({}, { status: 500 });
      const rest = path.slice(prefix.length);
      const branch = /^\/branches\/(.+)$/.exec(rest);
      if (branch) {
        const name = decodeURIComponent(branch[1]!);
        return !scenario.branches || scenario.branches.includes(name)
          ? Response.json({ name, commit: { sha: headCommit } })
          : Response.json({ message: "Branch not found" }, { status: 404 });
      }
      if (rest === "/pulls" && method === "GET") {
        const head = query.get("head");
        const state = query.get("state") ?? "open";
        const listed = pulls
          .filter((pull) => state === "all" || (pull.state ?? "open") === state)
          .filter((pull) => !head || head === `acme-apps:${pull.ref}`)
          .sort((a, b) => b.number - a.number)
          .slice(0, Number(query.get("per_page") ?? 30));
        return Response.json(listed.map(pullJson));
      }
      if (rest === "/pulls" && method === "POST") {
        if (scenario.create)
          return Response.json(scenario.create.body ?? {}, { status: scenario.create.status });
        const created: PullFixture = {
          number: Math.max(0, ...pulls.map(({ number }) => number)) + 1,
          ref: body.head,
        };
        pulls.push(created);
        return Response.json({ ...pullJson(created), commits: 2 }, { status: 201 });
      }
      const pullPath = /^\/pulls\/(\d+)\/(requested_reviewers|commits|reviews)$/.exec(rest);
      if (pullPath) {
        const pull = pulls.find(({ number }) => number === Number(pullPath[1]));
        if (!pull) return Response.json({ message: "Not Found" }, { status: 404 });
        if (pullPath[2] === "requested_reviewers")
          return scenario.reviewers
            ? reply(scenario.reviewers, {})
            : Response.json(
                { ...pullJson({ ...pull, requestedTeams: body.team_reviewers }) },
                { status: 201 },
              );
        if (pullPath[2] === "commits")
          return reply(scenario.commits, [
            { sha: templateCommit },
            { sha: pull.sha ?? headCommit },
          ]);
        return reply(scenario.reviews, []);
      }
      if (rest === `/commits/${headCommit}/check-runs`)
        return reply(scenario.checkRuns, { total_count: 0, check_runs: [] });
      if (rest === `/commits/${headCommit}/status`)
        return reply(scenario.statuses, { state: "pending", statuses: [] });
      if (rest === "/deployments") {
        if (scenario.deploymentsStatus)
          return Response.json({ message: "Forbidden" }, { status: scenario.deploymentsStatus });
        const sha = query.get("sha");
        const environment = query.get("environment");
        return Response.json(
          (scenario.deployments ?? [])
            .filter((deployment) => !sha || deployment.sha === sha)
            .filter((deployment) => !environment || deployment.environment === environment)
            .sort((a, b) => b.id - a.id)
            .map(({ id, environment: name, sha: commit }) => ({
              id,
              environment: name,
              sha: commit,
            })),
        );
      }
      const deploymentStatuses = /^\/deployments\/(\d+)\/statuses$/.exec(rest);
      if (deploymentStatuses) {
        const deployment = scenario.deployments?.find(
          ({ id }) => id === Number(deploymentStatuses[1]),
        );
        return Response.json(
          deployment?.statuses.slice(0, Number(query.get("per_page") ?? 30)) ?? [],
        );
      }
      return Response.json({ message: "unexpected" }, { status: 500 });
    }),
  );
  const tokenRequests = () =>
    calls.filter(({ path }) => path.endsWith("/access_tokens")).map(({ body }) => body);
  return { calls, pulls, tokenRequests };
}

/** Every permission the product needs, as the installation of the checklist mock grants it. */
export const fullInstallationPermissions = {
  contents: "write",
  metadata: "read",
  pull_requests: "write",
  checks: "read",
  statuses: "read",
  deployments: "read",
  members: "read",
  repository_creation: "write",
};

export interface ChecksScenario {
  /** `GET /app` (App JWT). */
  app?: Override;
  /** `GET /orgs/acme-apps/installation` (App JWT); `permissions` replaces the granted set. */
  installation?: Override;
  permissions?: Record<string, string>;
  /** Permission names GitHub refuses to put in a token (422 "not granted to this installation"). */
  refusePermissions?: string[];
  /** Repositories outside the installation's selection: restricted tokens for them get 422. */
  outsideInstallation?: string[];
  /** Token requests asking for one of these permissions get a token for more repositories. */
  broaderTokenFor?: string[];
  /** `GET /repos/acme-apps/<name>` per repository name. */
  repositories?: Record<string, Override>;
  /** `GET /orgs/acme-apps/teams/app-reviewers`. */
  team?: Override;
  /** `GET /orgs/acme-apps/teams/app-reviewers/repos/acme-apps/<repository>`. */
  teamAccess?: Override;
  /** `GET /repos/acme-apps/<repository>/rules/branches/main`. */
  rules?: Override;
  botUser?: Override;
}

/**
 * Mocked GitHub REST API for the connect checklist (organisation `acme-apps`, installation
 * 987654, template `acme-apps/react-starter`, reviewer team `app-reviewers`, App `weldall-app`).
 * Answers only reads and token requests; any other write fails the test with 500.
 */
export function mockGitHubChecks(scenario: ChecksScenario = {}) {
  const calls: Call[] = [];
  let issued = 0;
  const reply = (override: Override | undefined, body: unknown) =>
    Response.json(override?.body ?? body, {
      status: override?.status ?? 200,
      headers: override?.headers ?? {},
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, headers: new Headers(init?.headers), body });
      if (path === "/app/installations/987654/access_tokens" && method === "POST") {
        const requested = Object.keys(body.permissions ?? {});
        if (requested.some((name) => scenario.refusePermissions?.includes(name)))
          return Response.json({ message: "not granted" }, { status: 422 });
        const repositories = (body.repositories ?? null) as string[] | null;
        if (repositories?.some((name) => scenario.outsideInstallation?.includes(name)))
          return Response.json({ message: "not accessible" }, { status: 422 });
        issued += 1;
        const broader =
          repositories && requested.some((name) => scenario.broaderTokenFor?.includes(name));
        return Response.json(
          {
            token: `ghs_check_${issued}`,
            expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
            repository_selection: "selected",
            ...grantedScope(
              body.permissions ?? {},
              broader ? [...repositories, "other-repository"] : (repositories ?? undefined),
            ),
          },
          { status: 201 },
        );
      }
      if (method !== "GET") return Response.json({ message: "unexpected" }, { status: 500 });
      if (path === "/app") return reply(scenario.app, { id: 123456, slug: "weldall-app" });
      if (path === "/orgs/acme-apps/installation")
        return reply(scenario.installation, {
          id: 987654,
          account: { login: "acme-apps" },
          suspended_at: null,
          repository_selection: "selected",
          permissions: scenario.permissions ?? fullInstallationPermissions,
        });
      if (path === "/orgs/acme-apps/teams/app-reviewers")
        return reply(scenario.team, { slug: "app-reviewers" });
      if (/^\/orgs\/acme-apps\/teams\/app-reviewers\/repos\/acme-apps\/[^/]+$/.test(path))
        return reply(scenario.teamAccess, {
          permissions: { admin: false, push: true, pull: true },
        });
      if (path === "/users/weldall-app%5Bbot%5D")
        return reply(scenario.botUser, { id: 41898282, login: "weldall-app[bot]", type: "Bot" });
      const [, name, rest] = /^\/repos\/acme-apps\/([^/]+)(\/.*)?$/.exec(path) ?? [];
      if (name && !rest)
        return reply(scenario.repositories?.[name], {
          name,
          owner: { login: "acme-apps" },
          private: true,
          is_template: true,
        });
      if (name && rest === "/rules/branches/main") return reply(scenario.rules, fullRules);
      return Response.json({ message: "unexpected" }, { status: 500 });
    }),
  );
  const tokenRequests = () =>
    calls.filter(({ path }) => path.endsWith("/access_tokens")).map(({ body }) => body);
  return { calls, tokenRequests };
}
