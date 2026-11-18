import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { ConnectorError } from "../../errors";
import type {
  CreateRepositoryInput,
  CreatedRepository,
  GitHostWarning,
  GitRepositoryRef,
  NewRepository,
} from "../../git-host";
import { githubApi, segment, type GitHubApiResponse } from "./api";
import type { GitHubAppConfig } from "./config";
import {
  REPOSITORY_CREATION_PERMISSIONS,
  type GitHubAppIdentity,
  type GitHubPermissions,
  type InstallationTokenCache,
} from "./tokens";

/**
 * Installation permissions for creating a repository and checking its prerequisites (see
 * `GITHUB_OPERATION_PERMISSIONS`). All but `createRepository` are requested on a token restricted
 * to the new repository; `createRepository` lists what the installation must grant.
 */
export const GITHUB_REPOSITORY_PERMISSIONS = {
  /**
   * `POST /repos/{template}/generate` (GitHub accepts `administration: write` or
   * `repository_creation: write`, each with `contents: read` on the template). Checked on the
   * token, not requested: `generate` only succeeded with the installation-wide token (empty
   * mint request); every narrower token got 422 "Could not clone" and left an empty repository
   * (measured 17.11.2026). That token is minted per call, never cached and used for `generate`
   * only (`mintRepositoryCreationToken`).
   */
  createRepository: REPOSITORY_CREATION_PERMISSIONS,
  /** Default branch (`contents: read`) and the rules that apply to it (`metadata: read`). */
  inspectRepository: { contents: "read", metadata: "read" },
  /**
   * `GET /orgs/{org}/teams/{team}/repos/{owner}/{repo}` needs the organisation permission.
   * `metadata` makes GitHub confirm the repository restriction: for a token without any
   * repository permission it omits `repositories` (measured 18.11.2026).
   */
  checkReviewerTeam: { members: "read", metadata: "read" },
} as const satisfies Record<string, GitHubPermissions>;

/** GitHub answers `generate` before the content exists (about 3 s in the spike). */
export const REPOSITORY_READY_TIMEOUT_MS = 30_000;
export const REPOSITORY_READY_POLL_INTERVAL_MS = 750;

/** GitHub's limit for repository names. */
const MAX_REPOSITORY_NAME = 100;
const requestedName = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Normalises a requested app name to the repository name: surrounding whitespace is trimmed and
 * letters of the name and the configured prefix are lower-cased (GitHub names are case-insensitive, so this keeps the
 * registry key unique). Everything else is validated, never rewritten: GitHub would silently
 * replace other characters with `-`, which makes the resulting name unpredictable.
 */
export function repositoryNameFor(config: GitHubAppConfig, name: string): string {
  const value = name.trim().toLowerCase();
  // The prefix is lower-cased too, so a case-only change of the configured prefix keeps every
  // registry lookup pointing at the same repositories.
  const full = `${config.repositoryNamePrefix.toLowerCase()}${value}`;
  if (
    !requestedName.test(value) ||
    full.length > MAX_REPOSITORY_NAME ||
    full.startsWith(".") ||
    full.endsWith(".git")
  )
    throw new ConnectorError(
      "invalid_name",
      `Use an app name of letters, digits, ".", "-" or "_" that starts with a letter or digit, does not end in ".git" and has at most ${MAX_REPOSITORY_NAME - config.repositoryNamePrefix.length} characters.`,
    );
  return full;
}

/** Resolves a configured template; private templates must be in the App's installation. */
export function templateFor(config: GitHubAppConfig, name: string): GitRepositoryRef {
  const template = config.templates.find((candidate) => candidate.name === name);
  if (!template)
    throw new ConnectorError(
      "unknown_template",
      `Template "${name}" is not configured on this connector. Available: ${config.templates.map((candidate) => candidate.name).join(", ")}.`,
    );
  const [owner, repository] = template.repository.split("/") as [string, string];
  // Installation tokens reach only repositories of the account the App is installed on, so a
  // private template in another organisation cannot be read.
  if (owner.toLowerCase() !== config.organization.toLowerCase())
    throw new ConnectorError(
      "template_unavailable",
      `Template repository ${template.repository} is outside the organisation ${config.organization}. Move or copy the template into ${config.organization} and add it to the GitHub App's installation.`,
      409,
    );
  return { owner, name: repository };
}

const repositoryResponse = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
  private: z.boolean(),
  visibility: z.string().optional(),
  default_branch: z.string().min(1).max(255),
});
const branchResponse = z.object({
  commit: z.object({ sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) }),
});
const rulesResponse = z.array(
  z.object({
    type: z.string(),
    parameters: z.object({ required_approving_review_count: z.number().optional() }).optional(),
  }),
);
const teamRepositoryResponse = z.object({
  permissions: z.object({
    admin: z.boolean().optional(),
    maintain: z.boolean().optional(),
    push: z.boolean().optional(),
  }),
});

const protocolError = () =>
  new ConnectorError("upstream_protocol_error", "GitHub sent an invalid response.", 502);

/**
 * Primary limits answer 403 or 429 with `x-ratelimit-remaining: 0`; secondary limits answer 403
 * or 429 with `retry-after` and a message about the rate limit, without that header. Only a 403
 * that is none of these is a refused permission.
 */
export function rateLimited(response: GitHubApiResponse) {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  const message =
    response.json && typeof response.json === "object" && "message" in response.json
      ? String(response.json.message)
      : "";
  return (
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.has("retry-after") ||
    /rate limit/i.test(message)
  );
}

/** Status-only mapping for statuses an operation does not handle itself. */
export function unexpected(response: GitHubApiResponse): ConnectorError {
  if (rateLimited(response))
    return new ConnectorError("upstream_rate_limited", "GitHub is rate limiting the App.", 503);
  if (response.status === 401)
    return new ConnectorError("credential_rejected", "GitHub rejected the App's token.", 502);
  return new ConnectorError("upstream_unavailable", "GitHub is unavailable.", 503);
}

/** Branch names may contain `/`; each part is encoded on its own (an encoded `/` is refused). */
const branchPath = (branch: string) => branch.split("/").map(segment).join("/");

/** Rule types (and review count) that a default branch needs; names follow GitHub's rule types. */
function missingProtections(rules: z.infer<typeof rulesResponse>): string[] {
  const pullRequest = rules.filter(({ type }) => type === "pull_request");
  const missing: string[] = [];
  if (!pullRequest.length) missing.push("changes only through pull requests (no direct push)");
  if (!pullRequest.some(({ parameters }) => (parameters?.required_approving_review_count ?? 0) > 0))
    missing.push("at least one approving review");
  if (!rules.some(({ type }) => type === "non_fast_forward")) missing.push("no force-push");
  if (!rules.some(({ type }) => type === "deletion")) missing.push("no deletion");
  return missing;
}

/**
 * Creates a private repository from a configured template, waits for its default branch and
 * checks the customer-managed prerequisites (default-branch rule, reviewer team write access).
 */
export function createGitHubRepositories({
  config,
  app,
  webBaseUrl,
  loadPrivateKey,
  tokens,
  readyTimeoutMs = REPOSITORY_READY_TIMEOUT_MS,
  pollIntervalMs = REPOSITORY_READY_POLL_INTERVAL_MS,
}: {
  config: GitHubAppConfig;
  app: GitHubAppIdentity;
  /** Browser origin matching the API base, e.g. https://github.com. */
  webBaseUrl: string;
  loadPrivateKey: () => Promise<string>;
  tokens: InstallationTokenCache;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
}) {
  const organization = config.organization;
  const webUrl = (name: string) => `${webBaseUrl}/${segment(organization)}/${segment(name)}`;
  const label = (name: string) => `${organization}/${name}`;
  const mint = async (repository: string, permissions: GitHubPermissions, signal: AbortSignal) =>
    (await tokens.mint({ app, loadPrivateKey, repository, permissions, signal })).token;
  const repositoryPath = (name: string) => `/repos/${segment(organization)}/${segment(name)}`;

  /** Parses a repository GitHub returned and fails loudly unless it is the expected private one. */
  function confirmRepository(json: unknown, name: string, created: boolean) {
    const parsed = repositoryResponse.safeParse(json);
    if (!parsed.success) throw protocolError();
    const repository = parsed.data;
    if (
      repository.owner.login.toLowerCase() !== organization.toLowerCase() ||
      repository.name.toLowerCase() !== name.toLowerCase()
    )
      throw new ConnectorError(
        "repository_unexpected",
        `GitHub reported ${repository.owner.login}/${repository.name} instead of ${label(name)}. An administrator must check both repositories on GitHub.`,
        502,
      );
    if (!repository.private || (repository.visibility && repository.visibility !== "private"))
      throw new ConnectorError(
        "repository_not_private",
        `${created ? "GitHub created" : "GitHub reports"} ${label(repository.name)} without private visibility. The repository exists; an administrator must check its visibility on GitHub (and delete it if it was exposed) before anyone publishes to it.`,
        502,
      );
    return repository;
  }

  async function generate(
    input: { template: GitRepositoryRef; name: string; description: string },
    signal: AbortSignal,
  ) {
    const templateLabel = `${input.template.owner}/${input.template.name}`;
    let token: string;
    try {
      ({ token } = await tokens.mintRepositoryCreationToken({ app, loadPrivateKey, signal }));
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "token_refused")
        throw new ConnectorError(
          "repository_creation_not_permitted",
          `GitHub refused a token for creating repositories in ${organization}. Grant the GitHub App the permissions "Repository creation: write" and "Contents: read" and accept the updated permissions on the installation.`,
          502,
        );
      throw error;
    }
    const response = await githubApi({
      apiBaseUrl: config.apiBaseUrl,
      path: `/repos/${segment(input.template.owner)}/${segment(input.template.name)}/generate`,
      method: "POST",
      token,
      body: {
        owner: organization,
        name: input.name,
        description: input.description,
        // GitHub's default is a public repository; always ask for a private one explicitly.
        private: true,
        include_all_branches: false,
      },
      signal,
    });
    if (response.status === 201) return confirmRepository(response.json, input.name, true);
    if (response.status === 404)
      throw new ConnectorError(
        "template_unavailable",
        `GitHub did not find the template repository ${templateLabel} for the App. Add it to the GitHub App's installation and mark it as a template repository in its settings on GitHub.`,
        409,
      );
    if (response.status === 422) {
      // GitHub's text is inspected, never forwarded.
      const exists = /already exists/i.test(JSON.stringify(response.json ?? ""));
      throw exists
        ? new ConnectorError(
            "repository_exists",
            `A repository named ${label(input.name)} already exists on GitHub.`,
            409,
          )
        : new ConnectorError(
            "repository_refused",
            `GitHub refused to create ${label(input.name)} from ${templateLabel} (it could not copy the template). Known causes: the template repository is not in the GitHub App's installation or not marked as a template, or the token lacked the installation's full permissions. GitHub may still have left an empty repository of that name that the App cannot see: an administrator must look for ${label(input.name)} on GitHub and delete it if it is empty.`,
            502,
          );
    }
    if (response.status === 403 && !rateLimited(response))
      throw new ConnectorError(
        "repository_creation_not_permitted",
        `The GitHub App may not create repositories in ${organization}. Grant it the organisation permission "Repository creation: write" and accept the updated permissions on the installation.`,
        502,
      );
    throw unexpected(response);
  }

  /**
   * Polls the default branch until it exists. 404 and 409 mean "content not copied yet"; a refused
   * token for the new repository means the installation does not list it yet.
   */
  async function waitForDefaultBranch(name: string, branch: string, signal: AbortSignal) {
    const deadline = AbortSignal.timeout(readyTimeoutMs);
    const bounded = AbortSignal.any([signal, deadline]);
    try {
      for (;;) {
        let token: string | null = null;
        try {
          token = await mint(name, GITHUB_REPOSITORY_PERMISSIONS.inspectRepository, bounded);
        } catch (error) {
          if (!(error instanceof ConnectorError && error.code === "token_refused")) throw error;
        }
        if (token) {
          const response = await githubApi({
            apiBaseUrl: config.apiBaseUrl,
            path: `${repositoryPath(name)}/branches/${branchPath(branch)}`,
            method: "GET",
            token,
            signal: bounded,
          });
          if (response.status === 200) {
            const parsed = branchResponse.safeParse(response.json);
            if (!parsed.success) throw protocolError();
            return parsed.data.commit.sha;
          }
          if (response.status !== 404 && response.status !== 409) throw unexpected(response);
        }
        await sleep(pollIntervalMs, undefined, { signal: bounded });
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (deadline.aborted)
        throw new ConnectorError(
          "repository_not_ready",
          `GitHub created ${label(name)}, but its default branch "${branch}" did not appear within ${Math.round(readyTimeoutMs / 1000)} s. Retry later: Weldall continues with the same repository.`,
          504,
        );
      throw error;
    }
  }

  /** Re-reads a repository an earlier attempt created; it must still be private. */
  async function readExisting(name: string, signal: AbortSignal) {
    let token: string;
    try {
      token = await mint(name, GITHUB_REPOSITORY_PERMISSIONS.inspectRepository, signal);
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "token_refused")
        throw new ConnectorError(
          "repository_unavailable",
          `The GitHub App cannot access ${label(name)} any more. An administrator must check whether the repository still exists and is in the App's installation.`,
          409,
        );
      throw error;
    }
    const response = await githubApi({
      apiBaseUrl: config.apiBaseUrl,
      path: repositoryPath(name),
      method: "GET",
      token,
      signal,
    });
    if (response.status === 200) return confirmRepository(response.json, name, false);
    if (response.status === 404)
      throw new ConnectorError(
        "repository_unavailable",
        `${label(name)} no longer exists on GitHub or the App lost access to it. An administrator must check the repository.`,
        409,
      );
    throw unexpected(response);
  }

  /**
   * Warns unless rules make the default branch reviewed-only. Only rules (repository and
   * organisation rulesets) are visible: classic branch protection needs the Administration
   * permission, which the App does not have in customer-managed mode.
   */
  async function checkBranchRules(
    name: string,
    branch: string,
    signal: AbortSignal,
  ): Promise<GitHostWarning[]> {
    const token = await mint(name, GITHUB_REPOSITORY_PERMISSIONS.inspectRepository, signal);
    const response = await githubApi({
      apiBaseUrl: config.apiBaseUrl,
      path: `${repositoryPath(name)}/rules/branches/${branchPath(branch)}`,
      method: "GET",
      token,
      signal,
    });
    const classic =
      "Classic branch protection is not visible to the App (it would need the Administration permission); if you protect branches that way, check it on GitHub yourself.";
    const parsed = response.status === 200 ? rulesResponse.safeParse(response.json) : null;
    if (!parsed?.success)
      return [
        {
          code: "default_branch_rules_unchecked",
          message: `Weldall could not read the rules for the default branch "${branch}" of ${label(name)} (GitHub status ${response.status}). ${classic}`,
        },
      ];
    const missing = missingProtections(parsed.data);
    if (!missing.length) return [];
    return [
      {
        code: "default_branch_unprotected",
        message: `No ruleset gives the default branch "${branch}" of ${label(name)}: ${missing.join(", ")}. Weldall's git proxy never pushes to the default branch, but people with write access on GitHub can. Add an organisation ruleset for repositories named "${config.repositoryNamePrefix}*". ${classic}`,
      },
    ];
  }

  /** Fails unless the configured reviewer team can write to the repository, so its reviews count. */
  async function checkReviewerTeam(name: string, signal: AbortSignal) {
    const team = config.reviewerTeam;
    const unverifiable = () =>
      new ConnectorError(
        "reviewer_team_unverifiable",
        `Weldall cannot verify that the reviewer team "${team}" has write access to ${label(name)}: the GitHub App lacks the organisation permission "Members: read". Grant it to the App and accept the updated permissions on the installation, then publish again.`,
        409,
      );
    let token: string;
    try {
      token = await mint(name, GITHUB_REPOSITORY_PERMISSIONS.checkReviewerTeam, signal);
    } catch (error) {
      // The repository is already readable at this point, so a refusal names the permission.
      if (error instanceof ConnectorError && error.code === "token_refused") throw unverifiable();
      throw error;
    }
    const response = await githubApi({
      apiBaseUrl: config.apiBaseUrl,
      path: `/orgs/${segment(organization)}/teams/${segment(team)}/repos/${segment(organization)}/${segment(name)}`,
      method: "GET",
      token,
      // This media type returns the team's permissions instead of an empty 204.
      accept: "application/vnd.github.v3.repository+json",
      signal,
    });
    const noAccess = new ConnectorError(
      "reviewer_team_access_missing",
      `The reviewer team "${team}" has no write access to ${label(name)} (or the team does not exist in ${organization}), so its reviews would not count. An administrator must give the team write access, for example through an organisation-wide team role or a team on repositories named "${config.repositoryNamePrefix}*", then publish again.`,
      409,
    );
    if (response.status === 404) throw noAccess;
    if (response.status === 403 && !rateLimited(response)) throw unverifiable();
    if (response.status !== 200) throw unexpected(response);
    const parsed = teamRepositoryResponse.safeParse(response.json);
    if (!parsed.success) throw protocolError();
    const { admin, maintain, push } = parsed.data.permissions;
    if (!admin && !maintain && !push) throw noAccess;
  }

  return {
    /** The 3b checks on an existing repository, reused by the connect checklist. */
    checkBranchRules,
    checkReviewerTeam,
    resolveNewRepository(input: { template: string; name: string }): GitRepositoryRef {
      templateFor(config, input.template);
      return { owner: organization, name: repositoryNameFor(config, input.name) };
    },
    async createRepository(
      input: CreateRepositoryInput,
      signal: AbortSignal,
    ): Promise<CreatedRepository> {
      const template = templateFor(config, input.template);
      const name = repositoryNameFor(config, input.name);
      if (
        input.resume &&
        (input.resume.owner.toLowerCase() !== organization.toLowerCase() ||
          input.resume.name.toLowerCase() !== name.toLowerCase())
      )
        throw new ConnectorError("invalid_target", "The repository to resume does not match.");
      const repository = input.resume
        ? await readExisting(name, signal)
        : await generate({ template, name, description: input.description }, signal);
      const created: NewRepository = {
        repository: { owner: organization, name: repository.name, id: String(repository.id) },
        defaultBranch: repository.default_branch,
        webUrl: webUrl(repository.name),
      };
      if (!input.resume) await input.onCreated?.(created);
      const templateCommit = await waitForDefaultBranch(
        repository.name,
        created.defaultBranch,
        signal,
      );
      const warnings = await checkBranchRules(repository.name, created.defaultBranch, signal);
      await checkReviewerTeam(repository.name, signal);
      return { ...created, templateCommit, warnings };
    },
  };
}
