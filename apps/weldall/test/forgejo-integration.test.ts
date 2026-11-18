import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GitHost } from "../src/server/connectors/git-host";
import { parseForgejoConfiguration } from "../src/server/connectors/providers/forgejo/config";
import { createForgejoHost } from "../src/server/connectors/providers/forgejo/host";
import { gitUnavailableReason, runGit } from "./fixtures/git-http";

/**
 * Optional test against a real, disposable Forgejo (never a shared instance): it creates its own
 * organisation, bot user, reviewer, teams and template with the site administrator token, runs
 * every Git host operation, and deletes all of it again. Set
 *
 *   WELDALL_TEST_FORGEJO_URL=http://127.0.0.1:3300
 *   WELDALL_TEST_FORGEJO_ADMIN_TOKEN=<token of a site administrator, scope "all">
 *
 * The provider only talks https to a DNS name, so requests to `https://forgejo.integration.test`
 * are rewritten to that URL inside this test process.
 */
const localUrl = process.env.WELDALL_TEST_FORGEJO_URL?.replace(/\/$/, "");
const adminToken = process.env.WELDALL_TEST_FORGEJO_ADMIN_TOKEN;
const gitMissing = gitUnavailableReason();
const skipReason =
  !localUrl || !adminToken
    ? "WELDALL_TEST_FORGEJO_URL and WELDALL_TEST_FORGEJO_ADMIN_TOKEN are not set"
    : !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(localUrl)
      ? "WELDALL_TEST_FORGEJO_URL must be a local Forgejo (http://127.0.0.1:<port>)"
      : gitMissing
        ? `real git unavailable: ${gitMissing}`
        : null;

const PUBLIC_URL = "https://forgejo.integration.test";
const suffix = randomBytes(4).toString("hex");
const org = `wtest-${suffix}`;
const bot = `wbot-${suffix}`;
const reviewer = `wrev-${suffix}`;
const signal = () => AbortSignal.timeout(30_000);
const realFetch = globalThis.fetch;

async function admin(method: string, apiPath: string, body?: object, token = adminToken!) {
  const response = await realFetch(`${localUrl}/api/v1${apiPath}`, {
    method,
    headers: { authorization: `token ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (response.status >= 400 && !(method === "DELETE" && response.status === 404))
    throw new Error(`${method} ${apiPath}: HTTP ${response.status}`);
  return text ? JSON.parse(text) : null;
}
const file = (content: string) => ({ content: Buffer.from(content).toString("base64") });

let host: GitHost;
let work: string;
let botToken: string;
let reviewerToken: string;

describe.skipIf(skipReason !== null)(
  `Forgejo provider against a real local Forgejo${skipReason ? ` (skipped: ${skipReason})` : ""}`,
  () => {
    beforeAll(async () => {
      for (const [username, email] of [
        [bot, `${bot}@example.com`],
        [reviewer, `${reviewer}@example.com`],
      ] as const)
        await admin("POST", "/admin/users", {
          username,
          email,
          password: randomBytes(24).toString("hex"),
          must_change_password: false,
        });
      await admin("POST", "/orgs", { username: org, visibility: "private" });
      const publishers = await admin("POST", `/orgs/${org}/teams`, {
        name: "weldall-publishers",
        permission: "write",
        units: ["repo.code", "repo.pulls"],
        can_create_org_repo: true,
        includes_all_repositories: false,
      });
      const reviewers = await admin("POST", `/orgs/${org}/teams`, {
        name: "app-reviewers",
        permission: "write",
        units: ["repo.code", "repo.pulls", "repo.issues"],
        includes_all_repositories: true,
      });
      await admin("PUT", `/teams/${publishers.id}/members/${bot}`);
      await admin("PUT", `/teams/${reviewers.id}/members/${reviewer}`);
      await admin("POST", `/orgs/${org}/repos`, {
        name: "react-starter",
        private: true,
        auto_init: true,
        default_branch: "main",
      });
      for (const [name, content] of [
        [".forgejo/workflows/ci.yml", "on: [push]\njobs: {}\n"],
        [".github/workflows/ci.yml", "on: [push]\njobs: {}\n"],
        ["src/app.ts", "export const app = 1;\n"],
      ] as const)
        await admin("POST", `/repos/${org}/react-starter/contents/${name}`, {
          ...file(content),
          message: `Add ${name}`,
          branch: "main",
        });
      await admin("PATCH", `/repos/${org}/react-starter`, { template: true, has_actions: false });
      await admin("PUT", `/teams/${publishers.id}/repos/${org}/react-starter`);
      await admin("POST", `/repos/${org}/react-starter/branch_protections`, {
        rule_name: "main",
        enable_push: false,
        required_approvals: 1,
        apply_to_admins: true,
      });
      botToken = (
        await admin("POST", `/admin/users/${bot}/tokens`, {
          name: "weldall",
          scopes: ["write:repository", "write:organization", "read:user"],
        })
      ).sha1;
      reviewerToken = (
        await admin("POST", `/admin/users/${reviewer}/tokens`, {
          name: "review",
          scopes: ["write:repository"],
        })
      ).sha1;
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.origin !== PUBLIC_URL) throw new Error(`unexpected request to ${url.origin}`);
        return realFetch(`${localUrl}${url.pathname}${url.search}`, init);
      });
      host = createForgejoHost({
        config: parseForgejoConfiguration({
          baseUrl: PUBLIC_URL,
          organization: org,
          botUser: bot,
          templates: [{ name: "react", repository: `${org}/react-starter` }],
          repositoryNamePrefix: "app-",
          reviewerTeam: "app-reviewers",
          setupMode: "customer-managed",
        }),
        loadToken: async () => botToken,
      });
      work = await mkdtemp(path.join(tmpdir(), "weldall-forgejo-"));
    }, 60_000);

    afterAll(async () => {
      vi.unstubAllGlobals();
      if (skipReason) return;
      const repos = ((await admin("GET", `/orgs/${org}/repos?limit=50`)) ?? []) as {
        name: string;
      }[];
      for (const { name } of repos) await admin("DELETE", `/repos/${org}/${name}`);
      await admin("DELETE", `/orgs/${org}`);
      for (const username of [bot, reviewer])
        await admin("DELETE", `/admin/users/${username}?purge=true`);
      if (work) await rm(work, { recursive: true, force: true });
    }, 60_000);

    let defaultBranch: string;
    let templateCommit: string;

    it("passes the connect checklist before a repository exists, except what needs one", async () => {
      const checks = await host.checkSetup({ repository: null }, signal());
      const byState = (state: string) =>
        checks.filter((check) => check.state === state).map(({ id }) => id);
      expect(byState("fail")).toEqual([]);
      expect(byState("unverifiable").sort()).toEqual([
        "bot-repository-access",
        "branch-rule",
        "reviewer-team-access",
      ]);
    });

    it("creates a private repository with the template's protection and keeps only write access", async () => {
      const created = await host.createRepository(
        { template: "react", name: "Expenses", description: "Integration test" },
        signal(),
      );
      ({ defaultBranch, templateCommit } = created);
      // Whether a new repository inherits the template's Actions setting is not verified, so the
      // test switches it off as the docs tell administrators to.
      await admin("PATCH", `/repos/${org}/app-expenses`, { has_actions: false });
      expect(created).toMatchObject({
        repository: { owner: org, name: "app-expenses" },
        defaultBranch: "main",
        webUrl: `${PUBLIC_URL}/${org}/app-expenses`,
        warnings: [],
      });
      const repository = await admin("GET", `/repos/${org}/app-expenses`);
      expect(repository.private).toBe(true);
      const permission = await admin(
        "GET",
        `/repos/${org}/app-expenses/collaborators/${bot}/permission`,
      );
      expect(permission.permission).toBe("write");
      await expect(
        host.createRepository(
          { template: "react", name: "expenses", description: "Again" },
          signal(),
        ),
      ).rejects.toMatchObject({ code: "repository_exists" });
    });

    it("passes every check with the new repository", async () => {
      const checks = await host.checkSetup(
        { repository: { owner: org, name: "app-expenses", defaultBranch } },
        signal(),
      );
      expect(checks.filter(({ state }) => state !== "pass")).toEqual([]);
    });

    it("pushes a publish branch with the forwarding target, opens a pull request and reads its status", async () => {
      const repository = { owner: org, name: "app-expenses" };
      const target = await host.getForwardingTarget({ repository, access: "write" }, signal());
      expect(target.expiresAt).toBeNull();
      const local = `${localUrl}${target.url.pathname}`;
      const home = path.join(work, "home");
      const dir = path.join(work, "clone");
      const git = (args: string[], cwd = work) =>
        runGit(["-c", `http.extraheader=Authorization: ${target.authorization}`, ...args], {
          cwd,
          home,
        });
      await runGit(["init", "-q", home], { cwd: work, home: work });
      expect((await git(["clone", "-q", local, dir])).code).toBe(0);
      expect((await runGit(["rev-parse", "HEAD"], { cwd: dir, home })).stdout.trim()).toBe(
        templateCommit,
      );
      const identity = await host.readCommitIdentity({ repository }, signal());
      expect(identity).toEqual({ name: bot, email: `${bot}@example.com` });
      await writeFile(path.join(dir, "feature.ts"), "export const feature = 2;\n");
      await runGit(["add", "feature.ts"], { cwd: dir, home });
      await runGit(
        [
          "-c",
          `user.name=${identity.name}`,
          "-c",
          `user.email=${identity.email}`,
          "commit",
          "-q",
          "-m",
          "Publish",
        ],
        { cwd: dir, home },
      );
      const head = (await runGit(["rev-parse", "HEAD"], { cwd: dir, home })).stdout.trim();
      const branch = "weldall/publish-1";
      expect((await git(["push", "-q", "origin", `HEAD:refs/heads/${branch}`], dir)).code).toBe(0);
      // The default branch stays protected for the bot user itself.
      const direct = await git(["push", "origin", "HEAD:refs/heads/main"], dir);
      expect(direct.code).not.toBe(0);
      expect(await host.readBranchPullRequestState({ repository, branch }, signal())).toBeNull();

      const opened = await host.openPullRequest(
        { repository, head: branch, base: defaultBranch, title: "Publish", body: "Test" },
        signal(),
      );
      expect(opened).toMatchObject({
        created: true,
        headCommit: head,
        requestedReviewers: { teams: ["app-reviewers"] },
        commits: { ids: [head], count: 1 },
        warnings: [],
      });
      const again = await host.openPullRequest(
        { repository, head: branch, base: defaultBranch, title: "Publish", body: "Test" },
        signal(),
      );
      expect(again).toMatchObject({ created: false, number: opened.number });
      expect(await host.readBranchPullRequestState({ repository, branch }, signal())).toBe("open");

      await admin(
        "POST",
        `/repos/${org}/app-expenses/pulls/${opened.number}/reviews`,
        { event: "REQUEST_CHANGES", body: "Please rename the feature." },
        reviewerToken,
      );
      await admin("POST", `/repos/${org}/app-expenses/statuses/${head}`, {
        state: "success",
        context: "weldall/preview",
        target_url: "https://preview.example.com/expenses",
      });
      await admin("POST", `/repos/${org}/app-expenses/statuses/${head}`, {
        state: "failure",
        context: "ci/lint",
        target_url: "https://ci.example.com/1",
      });
      const status = await host.readStatus(
        {
          repository,
          pullRequest: { publishBranch: (name) => name.startsWith("weldall/publish-") },
        },
        signal(),
      );
      expect(status.warnings).toEqual([]);
      expect(status.links).toEqual({ preview: "https://preview.example.com/expenses", live: null });
      expect(status.pullRequest).toMatchObject({ number: opened.number, state: "open" });
      expect(status.pullRequest!.reviews).toEqual([
        expect.objectContaining({
          author: reviewer,
          state: "changes_requested",
          body: "Please rename the feature.",
        }),
      ]);
      expect(status.pullRequest!.checks).toEqual(
        expect.arrayContaining([
          { name: "ci/lint", state: "failure", detailsUrl: "https://ci.example.com/1" },
        ]),
      );
    }, 60_000);
  },
);
