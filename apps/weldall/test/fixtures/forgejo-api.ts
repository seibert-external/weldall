import { vi } from "vitest";

/**
 * Mocked Forgejo REST API (instance `https://forgejo.example.com`, organisation `example-org`,
 * bot user `weldall-bot`, template `example-org/react-starter`, reviewer team `app-reviewers`).
 * Repositories and pull requests are kept in memory, so a created one is found by the next
 * lookup. Replaces the global fetch; no request leaves the process. Shapes follow what a real
 * Forgejo 17 answered (see `forgejo-integration.test.ts`).
 */
export const FORGEJO_BASE_URL = "https://forgejo.example.com";
export const BOT_TOKEN = "f".repeat(32) + "1234abcd";
export const templateCommit = "c".repeat(40);
export const headCommit = "a".repeat(40);
export const defaultBranchCommit = "b".repeat(40);

export const forgejoConfig = {
  baseUrl: FORGEJO_BASE_URL,
  organization: "example-org",
  botUser: "weldall-bot",
  templates: [{ name: "react", repository: "example-org/react-starter" }],
  repositoryNamePrefix: "app-",
  reviewerTeam: "app-reviewers",
  setupMode: "customer-managed",
} as const;

type Override = { status?: number; body?: unknown; headers?: Record<string, string> };
export interface ForgejoPull {
  number: number;
  ref: string;
  sha?: string;
  state?: "open" | "closed";
  merged?: boolean;
  /** Head repository; defaults to the pull request's own repository, null for a deleted fork. */
  headRepository?: string | null;
  requestedTeams?: string[];
}
export interface ForgejoScenario {
  /** `GET /user`. */
  user?: Override;
  /** Scopes of the bot user's token in `GET /users/weldall-bot/tokens`. */
  tokenScopes?: string[];
  /** The token is limited to these repositories. */
  tokenRepositories?: string[];
  /** `GET /users/weldall-bot/orgs/example-org/permissions`. */
  organizationPermissions?: Override;
  /** Overrides the `generate` response. */
  generate?: Override;
  /** Fields of repositories the mock returns (e.g. `private: false`). */
  repository?: Record<string, unknown>;
  /** The bot user keeps admin rights although it lowered them (it is an owner). */
  keepsAdmin?: boolean;
  /** Branch polls answered 404 before 200. */
  pendingPolls?: number;
  /** `GET /repos/example-org/<repo>/branches/main`, beyond the commit. */
  defaultBranch?: { protected?: boolean; required_approvals?: number; user_can_push?: boolean };
  /** `GET /repos/example-org/<repo>/teams/app-reviewers`. */
  teamAccess?: Override;
  /** `GET /orgs/example-org/teams`. */
  teams?: Override;
  template?: Override;
  /** Branches that exist besides the default branch; default every branch. */
  branches?: string[];
  pulls?: ForgejoPull[];
  /** The server ignores the `head` filter of the pull request list (and reports the total). */
  ignoreHeadFilter?: boolean;
  /** Forgejo Actions on for the template, and for app repositories. */
  templateActions?: boolean;
  repositoryActions?: boolean;
  createPull?: Override;
  reviewers?: Override;
  /** Number of commits each pull request lists (newest first, as Forgejo does). */
  commitCount?: number;
  reviews?: Override;
  /** Combined status of the head commit and of the default branch. */
  headStatuses?: Override;
  defaultBranchStatuses?: Override;
}

type Call = { method: string; path: string; headers: Headers; body: any };

export function mockForgejo(scenario: ForgejoScenario = {}) {
  const calls: Call[] = [];
  const pulls = [...(scenario.pulls ?? [])];
  const repositories = new Map<string, { admin: boolean }>([["app-expenses", { admin: false }]]);
  let polls = 0;
  const reply = (override: Override | undefined, body: unknown, status = 200) =>
    Response.json(override?.body ?? body, {
      status: override?.status ?? status,
      headers: override?.headers ?? {},
    });
  const repositoryJson = (name: string) => ({
    id: name === "app-expenses" ? 42 : 4242,
    name,
    full_name: `example-org/${name}`,
    owner: { login: "example-org" },
    private: true,
    has_actions: scenario.repositoryActions ?? false,
    default_branch: "main",
    permissions: { admin: repositories.get(name)?.admin ?? false, push: true, pull: true },
    ...scenario.repository,
  });
  const pullJson = (pull: ForgejoPull, repository: string) => ({
    number: pull.number,
    state: pull.state ?? "open",
    merged: pull.merged ?? false,
    head: {
      ref: pull.ref,
      sha: pull.sha ?? headCommit,
      repo:
        pull.headRepository === null
          ? null
          : { full_name: pull.headRepository ?? `example-org/${repository}` },
    },
    base: { ref: "main" },
    requested_reviewers: [],
    requested_reviewers_teams: (pull.requestedTeams ?? []).map((name) => ({ name })),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        method,
        path: `${url.pathname}${url.search}`,
        headers: new Headers(init?.headers),
        body,
      });
      if (url.origin !== FORGEJO_BASE_URL || !url.pathname.startsWith("/api/v1/"))
        return Response.json({ message: "unexpected origin" }, { status: 500 });
      if (new Headers(init?.headers).get("authorization") !== `token ${BOT_TOKEN}`)
        return Response.json({ message: "token is required" }, { status: 401 });
      const path = url.pathname.slice("/api/v1".length);
      const query = url.searchParams;
      if (path === "/user")
        return reply(scenario.user, {
          id: 2,
          login: "weldall-bot",
          email: "weldall-bot@example.com",
          is_admin: false,
        });
      if (path === "/users/weldall-bot/tokens")
        return Response.json([
          {
            id: 7,
            name: "weldall",
            scopes: scenario.tokenScopes ?? ["write:repository", "write:organization", "read:user"],
            token_last_eight: BOT_TOKEN.slice(-8),
            repositories: scenario.tokenRepositories
              ? scenario.tokenRepositories.map((name) => ({ name }))
              : null,
          },
          { id: 3, name: "old", scopes: ["all"], token_last_eight: "00000000", repositories: null },
        ]);
      if (path === "/users/weldall-bot/orgs/example-org/permissions")
        return reply(scenario.organizationPermissions, {
          is_owner: false,
          is_admin: false,
          can_write: true,
          can_read: true,
          can_create_repository: true,
        });
      if (path === "/orgs/example-org/teams")
        return reply(scenario.teams, [
          { id: 1, name: "Owners", permission: "owner", includes_all_repositories: true },
          {
            id: 2,
            name: "app-reviewers",
            permission: "write",
            includes_all_repositories: true,
            units_map: { "repo.code": "write", "repo.pulls": "write" },
          },
        ]);
      if (path === "/repos/example-org/react-starter/generate" && method === "POST") {
        if (scenario.generate)
          return Response.json(scenario.generate.body ?? {}, {
            status: scenario.generate.status ?? 201,
          });
        repositories.set(body.name, { admin: true });
        // Forgejo answers `generate` with an empty default branch.
        return Response.json({ ...repositoryJson(body.name), default_branch: "" }, { status: 201 });
      }
      if (path === "/repos/example-org/react-starter")
        return reply(scenario.template, {
          name: "react-starter",
          owner: { login: "example-org" },
          template: true,
          has_actions: scenario.templateActions ?? false,
          default_branch: "main",
        });
      const [, name, rest = ""] = /^\/repos\/example-org\/([^/]+)(\/.*)?$/.exec(path) ?? [];
      if (!name) return Response.json({ message: "unexpected" }, { status: 500 });
      if (!rest && method === "GET")
        return repositories.has(name) || name === "react-starter"
          ? Response.json(repositoryJson(name))
          : Response.json({ message: "not found" }, { status: 404 });
      if (rest === "/collaborators/weldall-bot" && method === "PUT") {
        if (!scenario.keepsAdmin) repositories.set(name, { admin: body.permission === "admin" });
        return new Response(null, { status: 204 });
      }
      if (rest === "/teams/app-reviewers")
        return reply(scenario.teamAccess, {
          name: "app-reviewers",
          permission: "write",
          units_map: { "repo.code": "write", "repo.pulls": "write" },
        });
      const branch = /^\/branches\/(.+)$/.exec(rest);
      if (branch) {
        const branchName = branch[1]!;
        if (branchName === "main") {
          polls += 1;
          if (polls <= (scenario.pendingPolls ?? 0))
            return Response.json({ message: "not found" }, { status: 404 });
          return Response.json({
            name: "main",
            commit: { id: name === "react-starter" ? templateCommit : templateCommit },
            protected: true,
            required_approvals: 1,
            user_can_push: false,
            ...scenario.defaultBranch,
          });
        }
        return !scenario.branches || scenario.branches.includes(branchName)
          ? Response.json({ name: branchName, commit: { id: headCommit }, protected: false })
          : Response.json({ message: "not found" }, { status: 404 });
      }
      if (rest === "/pulls" && method === "GET") {
        const head = query.get("head");
        const state = query.get("state") ?? "open";
        const all = pulls
          .filter((pull) => state === "all" || (pull.state ?? "open") === state)
          .filter((pull) => scenario.ignoreHeadFilter || !head || head === pull.ref)
          .sort((a, b) => b.number - a.number);
        const listed = all.slice(0, Math.min(50, Number(query.get("limit") ?? 30)));
        return Response.json(
          listed.map((pull) => pullJson(pull, name)),
          { headers: { "x-total-count": String(all.length) } },
        );
      }
      if (rest === "/pulls" && method === "POST") {
        if (scenario.createPull) return reply(scenario.createPull, {}, 201);
        const created: ForgejoPull = {
          number: Math.max(0, ...pulls.map(({ number }) => number)) + 1,
          ref: body.head,
        };
        pulls.push(created);
        return Response.json(pullJson(created, name), { status: 201 });
      }
      const pullPath = /^\/pulls\/(\d+)\/(requested_reviewers|commits|reviews)$/.exec(rest);
      if (pullPath) {
        const pull = pulls.find(({ number }) => number === Number(pullPath[1]));
        if (!pull) return Response.json({ message: "not found" }, { status: 404 });
        if (pullPath[2] === "requested_reviewers")
          return reply(
            scenario.reviewers,
            body.team_reviewers.map((team: string) => ({
              state: "REQUEST_REVIEW",
              team: { name: team },
            })),
            201,
          );
        if (pullPath[2] === "commits") {
          const total = scenario.commitCount ?? 2;
          // Newest first; commit n is `n` repeated to 40 hex digits.
          const all = Array.from({ length: total }, (_, index) =>
            (total - index).toString(16).padStart(40, "0"),
          );
          const limit = Math.min(50, Number(query.get("limit") ?? 30));
          const page = Number(query.get("page") ?? 1);
          return Response.json(
            all.slice((page - 1) * limit, page * limit).map((sha) => ({ sha })),
            { headers: { "x-total-count": String(total) } },
          );
        }
        return reply(scenario.reviews, []);
      }
      if (rest === `/commits/${headCommit}/status`)
        return reply(scenario.headStatuses, { state: "pending", statuses: [] });
      if (rest === "/commits/main/status")
        return reply(scenario.defaultBranchStatuses, { state: "pending", statuses: [] });
      return Response.json({ message: "unexpected" }, { status: 500 });
    }),
  );
  return { calls, pulls, repositories };
}
