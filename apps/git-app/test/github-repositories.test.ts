import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGitHubAppConfiguration } from "../src/hosts/github/config.js";
import { createGitHubAppHost, GITHUB_OPERATION_PERMISSIONS } from "../src/hosts/github/host.js";
import { parseGitHubAppPrivateKey } from "../src/hosts/github/private-key.js";
import { createInstallationTokenCache } from "../src/hosts/github/tokens.js";
import {
  GITHUB_REPOSITORY_PERMISSIONS,
  repositoryNameFor,
} from "../src/hosts/github/repositories.js";
import { mockGitHub, templateCommit as sha } from "./fixtures/github-api.js";

// Test keys are generated per run; no key material is committed.
const pkcs8 = parseGitHubAppPrivateKey(
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  }).privateKey,
);
const config = parseGitHubAppConfiguration({
  appId: "123456",
  organization: "acme-apps",
  installationId: "987654",
  templates: [
    { name: "react", repository: "acme-apps/react-starter" },
    { name: "elsewhere", repository: "acme-templates/react-starter" },
  ],
  repositoryNamePrefix: "app-",
  reviewerTeam: "app-reviewers",
  setupMode: "customer-managed",
});
const host = () =>
  createGitHubAppHost({
    config,
    loadPrivateKey: async () => pkcs8,
    tokens: createInstallationTokenCache(),
    timing: { readyTimeoutMs: 300, pollIntervalMs: 5 },
  });
const request = { template: "react", name: "Expenses", description: "Tracks team expenses" };
const signal = () => AbortSignal.timeout(5_000);

afterEach(() => vi.unstubAllGlobals());

describe("repository names", () => {
  it("lower-cases, applies the prefix and validates strictly instead of rewriting", () => {
    expect(repositoryNameFor(config, "  Expense-Tracker_2.0 ")).toBe("app-expense-tracker_2.0");
    for (const name of [
      "",
      ".hidden",
      "-dash",
      "with space",
      "ümlaut",
      "a/b",
      "repo.git",
      "repo.GIT",
      "x".repeat(97),
    ])
      expect(() => repositoryNameFor(config, name), name).toThrow(
        expect.objectContaining({ code: "invalid_name" }),
      );
    expect(repositoryNameFor(config, "x".repeat(96))).toHaveLength(100);
    expect(repositoryNameFor({ ...config, repositoryNamePrefix: "" }, "app")).toBe("app");
    // A case-only change of the configured prefix keeps the same repository name.
    expect(repositoryNameFor({ ...config, repositoryNamePrefix: "App-" }, "x")).toBe("app-x");
  });

  it("resolves the repository without contacting GitHub", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(host().resolveNewRepository({ template: "react", name: "Expenses" })).toEqual({
      owner: "acme-apps",
      name: "app-expenses",
    });
    expect(() => host().resolveNewRepository({ template: "vue", name: "x" })).toThrow(
      expect.objectContaining({ code: "unknown_template" }),
    );
    expect(() => host().resolveNewRepository({ template: "elsewhere", name: "x" })).toThrow(
      expect.objectContaining({ code: "template_unavailable" }),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("creating a repository from a template", () => {
  it("documents every permission the calls request", () => {
    expect(GITHUB_OPERATION_PERMISSIONS).toMatchObject({
      createRepository: { repository_creation: "write", contents: "read" },
      inspectRepository: { contents: "read", metadata: "read" },
      checkReviewerTeam: { members: "read", metadata: "read" },
    });
  });

  it("checks the reviewer team with a token GitHub confirms as restricted to the repository", async () => {
    // GitHub omits `repositories` for a token with only organisation permissions, which
    // Weldall rejects as broader than requested; `metadata` makes GitHub confirm it.
    const { calls, tokenRequests } = mockGitHub({ pendingPolls: 0 });
    await expect(host().createRepository(request, signal())).resolves.toMatchObject({
      warnings: [],
    });
    expect(tokenRequests()).toContainEqual({
      repositories: ["app-expenses"],
      permissions: { members: "read", metadata: "read" },
    });
    expect(calls.some(({ path }) => path.startsWith("/orgs/acme-apps/teams/"))).toBe(true);
  });

  it("creates a private repository, waits for the branch and checks the prerequisites", async () => {
    const { calls, tokenRequests } = mockGitHub({ pendingPolls: 2 });
    const onCreated = vi.fn(async () => undefined);
    const created = await host().createRepository({ ...request, onCreated }, signal());

    expect(created).toEqual({
      repository: { owner: "acme-apps", name: "app-expenses", id: "4242" },
      defaultBranch: "main",
      webUrl: "https://github.com/acme-apps/app-expenses",
      templateCommit: sha,
      warnings: [],
    });
    expect(onCreated).toHaveBeenCalledWith({
      repository: { owner: "acme-apps", name: "app-expenses", id: "4242" },
      defaultBranch: "main",
      webUrl: "https://github.com/acme-apps/app-expenses",
    });
    const generate = calls.find(({ path }) => path.endsWith("/generate"))!;
    expect(generate.body).toEqual({
      owner: "acme-apps",
      name: "app-expenses",
      description: "Tracks team expenses",
      private: true,
      include_all_branches: false,
    });
    expect(generate.headers.get("authorization")).toBe("Bearer ghs_test_1");
    // Only the creation token has no repository restriction; the others name the new repository.
    expect(tokenRequests()).toEqual([
      // Installation-wide: GitHub refuses `generate` with any narrower token.
      {},
      {
        repositories: ["app-expenses"],
        permissions: GITHUB_REPOSITORY_PERMISSIONS.inspectRepository,
      },
      {
        repositories: ["app-expenses"],
        permissions: GITHUB_REPOSITORY_PERMISSIONS.checkReviewerTeam,
      },
    ]);
    expect(
      calls.filter(({ path }) => path === "/repos/acme-apps/app-expenses/branches/main"),
    ).toHaveLength(3);
    const team = calls.find(({ path }) => path.startsWith("/orgs/"))!;
    expect(team.headers.get("accept")).toBe("application/vnd.github.v3.repository+json");
    expect(calls.every(({ path }) => !path.includes("/protection"))).toBe(true);
  });

  it("keeps polling while the installation does not list the new repository yet", async () => {
    mockGitHub({ refusedNewRepositoryTokens: 2 });
    await expect(host().createRepository(request, signal())).resolves.toMatchObject({
      templateCommit: sha,
    });
  });

  it("explains how to make a template reachable when GitHub answers 404", async () => {
    mockGitHub({ generate: { status: 404 } });
    const onCreated = vi.fn();
    const error = await host()
      .createRepository({ ...request, onCreated }, signal())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "template_unavailable", status: 409 });
    expect((error as Error).message).toMatch(/installation/);
    expect((error as Error).message).toMatch(/mark it as a template/);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("names the missing permission before calling generate", async () => {
    const { calls } = mockGitHub({ refusePermission: "repository_creation" });
    await expect(host().createRepository(request, signal())).rejects.toMatchObject({
      code: "repository_creation_not_permitted",
      message: expect.stringContaining("repository_creation: write"),
    });
    expect(calls.some(({ path }) => path.endsWith("/generate"))).toBe(false);
  });

  it("mints a fresh creation token for every attempt instead of caching it", async () => {
    const { tokenRequests } = mockGitHub({ generate: { status: 403 } });
    const shared = host();
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(shared.createRepository(request, signal())).rejects.toMatchObject({
        code: "repository_creation_not_permitted",
      });
    expect(tokenRequests()).toEqual([{}, {}]);
  });

  it("fails like GitHub when generate is called with a narrower token", async () => {
    const { calls } = mockGitHub();
    const tokens = createInstallationTokenCache();
    const narrowed = createGitHubAppHost({
      config,
      loadPrivateKey: async () => pkcs8,
      tokens: {
        ...tokens,
        // A regression that scopes the creation token again.
        mintRepositoryCreationToken: ({ app, loadPrivateKey, signal }) =>
          tokens.mint({
            app,
            loadPrivateKey,
            repository: "react-starter",
            permissions: GITHUB_REPOSITORY_PERMISSIONS.createRepository,
            signal,
          }),
      },
      timing: { readyTimeoutMs: 300, pollIntervalMs: 5 },
    });
    await expect(narrowed.createRepository(request, signal())).rejects.toMatchObject({
      code: "repository_refused",
    });
    expect(calls.filter(({ path }) => path.endsWith("/generate"))).toHaveLength(1);
  });

  it("reports a taken name without forwarding GitHub's text", async () => {
    mockGitHub({
      generate: {
        status: 422,
        body: {
          message: "Repository creation failed.",
          errors: [{ field: "name", message: "name already exists on this account" }],
        },
      },
    });
    await expect(host().createRepository(request, signal())).rejects.toMatchObject({
      code: "repository_exists",
      status: 409,
      message: "A repository named acme-apps/app-expenses already exists on GitHub.",
    });
    mockGitHub({
      generate: {
        status: 422,
        body: { message: "Could not clone: Cloning user does not have permission" },
      },
    });
    await expect(host().createRepository(request, signal())).rejects.toMatchObject({
      code: "repository_refused",
      message: expect.stringMatching(
        /not in the GitHub App's installation or not marked as a template, or the token lacked the installation's full permissions.*empty repository .* delete it if it is empty/,
      ),
    });
  });

  it("names the missing permission when GitHub forbids creating repositories", async () => {
    mockGitHub({ generate: { status: 403 } });
    await expect(host().createRepository(request, signal())).rejects.toMatchObject({
      code: "repository_creation_not_permitted",
      message: expect.stringContaining("Repository creation: write"),
    });
  });

  it("fails loudly when the new repository is not private and does not record it", async () => {
    for (const repository of [
      { private: false, visibility: "public" },
      { visibility: "internal" },
    ]) {
      mockGitHub({ repository });
      const onCreated = vi.fn();
      const error = await host()
        .createRepository({ ...request, onCreated }, signal())
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "repository_not_private", status: 502 });
      expect((error as Error).message).toMatch(/exists; an administrator must check/);
      expect(onCreated).not.toHaveBeenCalled();
    }
  });

  it("gives up after the configured wait with a message naming the repository", async () => {
    mockGitHub({ pendingPolls: Number.POSITIVE_INFINITY });
    const onCreated = vi.fn(async () => undefined);
    const error = await host()
      .createRepository({ ...request, onCreated }, signal())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "repository_not_ready", status: 504 });
    expect((error as Error).message).toContain("acme-apps/app-expenses");
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it("stops waiting as soon as the caller aborts", async () => {
    mockGitHub({ pendingPolls: Number.POSITIVE_INFINITY });
    const controller = new AbortController();
    const reason = new Error("caller left");
    const pending = host().createRepository(
      {
        ...request,
        onCreated: async () => {
          setTimeout(() => controller.abort(reason), 20);
        },
      },
      controller.signal,
    );
    await expect(pending).rejects.toBe(reason);
  });

  it("warns when no rule protects the default branch, without failing", async () => {
    mockGitHub({ rules: { status: 200, body: [{ type: "deletion" }] } });
    const created = await host().createRepository(request, signal());
    expect(created.warnings).toEqual([
      {
        code: "default_branch_unprotected",
        message: expect.stringContaining(
          "changes only through pull requests (no direct push), at least one approving review, no force-push",
        ),
      },
    ]);
    expect(created.warnings[0]!.message).toMatch(/Classic branch protection is not visible/);

    mockGitHub({ rules: { status: 200, body: [] } });
    expect((await host().createRepository(request, signal())).warnings).toHaveLength(1);

    mockGitHub({ rules: { status: 403 } });
    expect((await host().createRepository(request, signal())).warnings).toEqual([
      expect.objectContaining({ code: "default_branch_rules_unchecked" }),
    ]);
  });

  it("fails for the caller when the reviewer team cannot write to the repository", async () => {
    for (const team of [
      { status: 404 },
      { status: 200, body: { permissions: { admin: false, maintain: false, push: false } } },
    ]) {
      mockGitHub({ team });
      await expect(host().createRepository(request, signal())).rejects.toMatchObject({
        code: "reviewer_team_access_missing",
        status: 409,
        message: expect.stringContaining('reviewer team "app-reviewers" has no write access'),
      });
    }
  });

  it("separates a team check it may not run from a team without access", async () => {
    for (const scenario of [{ team: { status: 403 } }, { refusePermission: "members" }]) {
      mockGitHub(scenario);
      await expect(host().createRepository(request, signal())).rejects.toMatchObject({
        code: "reviewer_team_unverifiable",
        message: expect.stringContaining('"Members: read"'),
      });
    }
  });

  it("resumes with an existing repository without creating another", async () => {
    const { calls } = mockGitHub({ pendingPolls: 0 });
    const onCreated = vi.fn();
    const created = await host().createRepository(
      { ...request, onCreated, resume: { owner: "acme-apps", name: "app-expenses" } },
      signal(),
    );
    expect(created).toMatchObject({ templateCommit: sha, defaultBranch: "main", warnings: [] });
    expect(calls.some(({ path }) => path.endsWith("/generate"))).toBe(false);
    expect(onCreated).not.toHaveBeenCalled();

    mockGitHub({ repository: { private: false } });
    await expect(
      host().createRepository(
        { ...request, resume: { owner: "acme-apps", name: "app-expenses" } },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "repository_not_private" });
  });
});
