import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorError } from "../src/server/connectors/errors";
import type { GitHostCheck, GitHostCheckRepository } from "../src/server/connectors/git-host";
import { parseGitHubAppConfiguration } from "../src/server/connectors/providers/github-app/config";
import { createGitHubAppHost } from "../src/server/connectors/providers/github-app/host";
import { parseGitHubAppPrivateKey } from "../src/server/connectors/providers/github-app/private-key";
import { createInstallationTokenCache } from "../src/server/connectors/providers/github-app/tokens";
import {
  fullInstallationPermissions,
  mockGitHubChecks,
  type ChecksScenario,
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
const existing: GitHostCheckRepository = {
  owner: "acme-apps",
  name: "app-expenses",
  defaultBranch: "main",
};
const rateLimit = { status: 403, headers: { "x-ratelimit-remaining": "0" }, body: {} };

async function check(
  scenario: ChecksScenario = {},
  {
    repository = null,
    config = {},
    loadPrivateKey = async () => pkcs8,
  }: {
    repository?: GitHostCheckRepository | null;
    config?: Record<string, unknown>;
    loadPrivateKey?: () => Promise<string>;
  } = {},
) {
  const github = mockGitHubChecks(scenario);
  const checks = await createGitHubAppHost({
    config: parseGitHubAppConfiguration({ ...baseConfig, ...config }),
    loadPrivateKey,
    tokens: createInstallationTokenCache(),
  }).checkSetup({ repository }, AbortSignal.timeout(5_000));
  const byId = Object.fromEntries(checks.map((line) => [line.id, line])) as Record<
    string,
    GitHostCheck
  >;
  return { checks, byId, github };
}
const states = (checks: GitHostCheck[]) =>
  Object.fromEntries(checks.map(({ id, state }) => [id, state]));

afterEach(() => vi.unstubAllGlobals());

describe("GitHub App connect checklist", () => {
  it("passes every check it can verify before a repository exists, without writing to GitHub", async () => {
    const { checks, byId, github } = await check();
    expect(states(checks)).toEqual({
      "app-authentication": "pass",
      installation: "pass",
      "permissions.create-repository": "pass",
      "permissions.git-proxy": "pass",
      "permissions.pull-requests": "pass",
      "permissions.status": "pass",
      "permissions.reviewer-team": "pass",
      "permissions.commit-identity": "pass",
      "template.react": "pass",
      "reviewer-team": "pass",
      "reviewer-team-access": "unverifiable",
      "branch-rule": "unverifiable",
      "commit-identity": "pass",
    });
    expect(byId["reviewer-team-access"]!.reason).toContain(
      "Cannot verify before a repository exists",
    );
    expect(byId["reviewer-team-access"]!.action).toContain('repository named "app-*"');
    expect(byId["branch-rule"]).toMatchObject({
      required: false,
      reason: expect.stringContaining("Cannot verify before a repository exists"),
      action: expect.stringContaining("Recommended"),
    });
    expect(byId["commit-identity"]!.reason).toContain(
      "weldall-app[bot] <41898282+weldall-app[bot]@users.noreply.github.com>",
    );
    expect(byId["template.react"]!.reason).toContain("marked as a template");
    expect(checks.filter(({ state }) => state === "pass").every(({ action }) => !action)).toBe(
      true,
    );
    // Only token requests are writes; nothing is created, changed or deleted.
    expect(
      github.calls.filter(
        ({ method, path }) => method !== "GET" && !path.endsWith("/access_tokens"),
      ),
    ).toEqual([]);
    // Organisation lookups use tokens without repositories and with one permission each.
    expect(github.tokenRequests()).toEqual(
      expect.arrayContaining([
        { permissions: { members: "read" } },
        { permissions: { metadata: "read" } },
        { repositories: ["react-starter"], permissions: { metadata: "read" } },
      ]),
    );
    expect(JSON.stringify(checks)).not.toMatch(/ghs_check_|BEGIN|eyJ/);
  });

  it("checks rule and team access on an existing repository", async () => {
    const passing = await check({}, { repository: existing });
    expect(passing.byId["reviewer-team-access"]).toMatchObject({
      state: "pass",
      reason: expect.stringContaining("acme-apps/app-expenses"),
    });
    expect(passing.byId["branch-rule"]).toMatchObject({ state: "pass", required: false });

    const failing = await check(
      { rules: { body: [] }, teamAccess: { status: 404, body: {} } },
      { repository: existing },
    );
    expect(failing.byId["branch-rule"]).toMatchObject({
      state: "fail",
      required: false,
      reason: expect.stringContaining("at least one approving review"),
    });
    expect(failing.byId["reviewer-team-access"]).toMatchObject({
      state: "fail",
      reason: expect.stringContaining("no write access"),
    });

    const readOnly = await check(
      { teamAccess: { body: { permissions: { admin: false, push: false, pull: true } } } },
      { repository: existing },
    );
    expect(readOnly.byId["reviewer-team-access"]!.state).toBe("fail");

    const unknown = await check(
      { rules: { status: 404, body: {} }, refusePermissions: ["members"] },
      { repository: existing },
    );
    expect(unknown.byId["branch-rule"]).toMatchObject({
      state: "unverifiable",
      reason: expect.stringContaining("could not read the rules"),
    });
    expect(unknown.byId["reviewer-team-access"]).toMatchObject({
      state: "unverifiable",
      reason: expect.stringContaining("Organization permissions > Members: Read-only"),
    });

    // A deleted repository is named as such, never blamed on the Members permission.
    const gone = await check({ outsideInstallation: ["app-expenses"] }, { repository: existing });
    expect(gone.byId["branch-rule"]!.state).toBe("unverifiable");
    expect(gone.byId["reviewer-team-access"]).toMatchObject({
      state: "unverifiable",
      reason: expect.stringContaining("deleted or removed from the installation"),
    });
    expect(gone.byId["reviewer-team-access"]!.reason).not.toContain("Members");
  });

  describe("App authentication", () => {
    it("fails without a provisioned key and keeps running every other check", async () => {
      const { checks, byId, github } = await check(
        {},
        {
          loadPrivateKey: () =>
            Promise.reject(new ConnectorError("credential_unavailable", "missing", 503)),
        },
      );
      expect(byId["app-authentication"]).toMatchObject({
        state: "fail",
        reason: "No private key is provisioned for this connector.",
        action: expect.stringContaining("private key (.pem)"),
      });
      expect(checks).toHaveLength(13);
      for (const line of checks.filter(({ id }) => id !== "app-authentication"))
        expect(line.state, line.id).toBe("unverifiable");
      expect(byId.installation!.reason).toContain("App authentication");
      expect(github.calls).toEqual([]);
    });

    it("names several enabled key connections instead of a missing key", async () => {
      const { byId } = await check(
        {},
        {
          loadPrivateKey: () =>
            Promise.reject(new ConnectorError("credential_ambiguous", "several", 503)),
        },
      );
      expect(byId["app-authentication"]).toMatchObject({
        state: "fail",
        reason: expect.stringContaining("More than one enabled shared connection"),
        action: expect.stringContaining("exactly one"),
      });
      expect(byId.installation!.state).toBe("unverifiable");
    });

    it("fails for a key of another App and for a rejected JWT", async () => {
      const mismatch = await check(
        {},
        {
          loadPrivateKey: () =>
            Promise.reject(new ConnectorError("grant_mismatch", "other app", 502)),
        },
      );
      expect(mismatch.byId["app-authentication"]).toMatchObject({
        state: "fail",
        action: expect.stringContaining("App 123456"),
      });

      const rejected = await check({ app: { status: 401, body: { message: "upstream detail" } } });
      expect(rejected.byId["app-authentication"]).toMatchObject({
        state: "fail",
        reason: expect.stringContaining("rejected the App's JWT"),
      });
      expect(rejected.byId["commit-identity"]!.state).toBe("unverifiable");
      expect(JSON.stringify(rejected.checks)).not.toContain("upstream detail");
    });

    it("reports rate limits as such", async () => {
      const { byId } = await check({ app: rateLimit });
      expect(byId["app-authentication"]).toMatchObject({
        state: "unverifiable",
        reason: "GitHub is rate limiting the App.",
      });
      expect(byId.installation!.state).toBe("pass");
    });
  });

  describe("installation", () => {
    it("fails when the App is not installed, without stopping the other checks", async () => {
      const { byId } = await check({ installation: { status: 404, body: {} } });
      expect(byId.installation).toMatchObject({
        state: "fail",
        reason: "The App is not installed on the organisation acme-apps.",
      });
      expect(byId["permissions.git-proxy"]).toMatchObject({
        state: "unverifiable",
        reason: expect.stringContaining("“Installation”"),
      });
      expect(byId["app-authentication"]!.state).toBe("pass");
      expect(byId["template.react"]!.state).toBe("pass");
    });

    it("fails for a suspended installation and for a different installation id", async () => {
      const suspended = await check({
        installation: {
          body: {
            id: 987654,
            suspended_at: "2026-11-01T00:00:00Z",
            permissions: fullInstallationPermissions,
          },
        },
      });
      expect(suspended.byId.installation).toMatchObject({
        state: "fail",
        reason: expect.stringContaining("suspended"),
      });
      const other = await check({
        installation: { body: { id: 111, permissions: fullInstallationPermissions } },
      });
      expect(other.byId.installation).toMatchObject({
        state: "fail",
        reason: expect.stringContaining("installation 987654"),
        action: expect.stringContaining("Set installationId to 111"),
      });
    });

    it("cannot verify under a rate limit or when GitHub is unavailable", async () => {
      const limited = await check({ installation: { status: 429, body: {} } });
      expect(limited.byId.installation!.reason).toBe("GitHub is rate limiting the App.");
      expect(limited.byId["permissions.status"]!.reason).toBe("GitHub is rate limiting the App.");
      const down = await check({ installation: { status: 502, body: {} } });
      expect(down.byId.installation).toMatchObject({
        state: "unverifiable",
        reason: "GitHub answered with HTTP 502.",
      });
    });
  });

  it("names each missing permission per operation as GitHub's settings page does", async () => {
    const { byId } = await check({
      permissions: { contents: "read", metadata: "read", pull_requests: "read" },
    });
    expect(byId["permissions.create-repository"]).toMatchObject({
      state: "fail",
      reason:
        "The installation lacks Organization permissions > Repository creation: Read and write.",
      action: expect.stringContaining("accepts the updated permissions"),
    });
    expect(byId["permissions.git-proxy"]!.reason).toBe(
      "The installation lacks Repository permissions > Contents: Read and write.",
    );
    expect(byId["permissions.pull-requests"]!.reason).toBe(
      "The installation lacks Repository permissions > Pull requests: Read and write.",
    );
    expect(byId["permissions.status"]!.reason).toBe(
      "The installation lacks Repository permissions > Checks: Read-only, Repository permissions > Commit statuses: Read-only, Repository permissions > Deployments: Read-only.",
    );
    expect(byId["permissions.reviewer-team"]!.reason).toBe(
      "The installation lacks Organization permissions > Members: Read-only.",
    );
    expect(byId["permissions.commit-identity"]!.state).toBe("pass");
  });

  describe("templates", () => {
    it("fails for a template outside the organisation without asking GitHub", async () => {
      const { byId, github } = await check(
        {},
        {
          config: {
            templates: [
              { name: "react", repository: "acme-apps/react-starter" },
              { name: "vue", repository: "other-org/vue-starter" },
            ],
          },
        },
      );
      expect(byId["template.react"]!.state).toBe("pass");
      expect(byId["template.vue"]).toMatchObject({
        state: "fail",
        reason: expect.stringContaining("outside the organisation acme-apps"),
      });
      expect(github.calls.some(({ path }) => path.includes("vue-starter"))).toBe(false);
    });

    it("fails when the template is not in the installation or not marked as a template", async () => {
      const outside = await check({ outsideInstallation: ["react-starter"] });
      expect(outside.byId["template.react"]).toMatchObject({
        state: "fail",
        reason: expect.stringContaining("not in the App installation's repository selection"),
      });
      const plain = await check({
        repositories: {
          "react-starter": { body: { owner: { login: "acme-apps" }, is_template: false } },
        },
      });
      expect(plain.byId["template.react"]).toMatchObject({
        state: "fail",
        reason: expect.stringContaining("not marked as a template"),
        action: expect.stringContaining("Template repository"),
      });
      const limited = await check({ repositories: { "react-starter": rateLimit } });
      expect(limited.byId["template.react"]).toMatchObject({
        state: "unverifiable",
        reason: "GitHub is rate limiting the App.",
      });
    });
  });

  describe("reviewer team", () => {
    it("fails for an unknown team", async () => {
      const { byId } = await check({ team: { status: 404, body: {} } });
      expect(byId["reviewer-team"]).toMatchObject({
        state: "fail",
        reason: 'There is no team "app-reviewers" in acme-apps.',
      });
    });

    it("cannot verify without Members permission or under a rate limit", async () => {
      const refused = await check({ refusePermissions: ["members"] });
      expect(refused.byId["reviewer-team"]).toMatchObject({
        state: "unverifiable",
        reason: expect.stringContaining("Organization permissions > Members: Read-only"),
      });
      const limited = await check({ team: { status: 429, body: {} } });
      expect(limited.byId["reviewer-team"]!.reason).toBe("GitHub is rate limiting the App.");
    });
  });

  describe("commit identity", () => {
    it("fails when GitHub does not confirm the bot account", async () => {
      const { byId } = await check({
        botUser: { body: { id: 5, login: "weldall-app", type: "User" } },
      });
      expect(byId["commit-identity"]).toMatchObject({
        state: "fail",
        reason: expect.stringContaining("bot account"),
      });
    });

    it("cannot verify under a rate limit", async () => {
      const { byId } = await check({ botUser: rateLimit });
      expect(byId["commit-identity"]).toMatchObject({
        state: "unverifiable",
        reason: "GitHub is rate limiting the App.",
      });
    });
  });
});
