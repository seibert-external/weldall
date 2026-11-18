import { z } from "zod";
import { ConnectorError } from "../../errors";
import type { GitHostCheck, GitHostCheckRepository, GitHostCheckState } from "../../git-host";
import { githubApi, segment, type GitHubApiResponse } from "./api";
import type { GitHubAppConfig } from "./config";
import type { GITHUB_OPERATION_PERMISSIONS } from "./host";
import { readGitHubCommitIdentity } from "./identity";
import { createAppJwt } from "./jwt";
import {
  rateLimited,
  templateFor,
  unexpected,
  type createGitHubRepositories,
} from "./repositories";
import type {
  GitHubAppIdentity,
  GitHubPermissionLevel,
  GitHubPermissions,
  InstallationTokenCache,
} from "./tokens";

/**
 * Permission names and levels as GitHub's App settings page ("Permissions & events") shows
 * them, so an administrator can find each missing one there.
 */
const PERMISSION_LABELS: Record<string, { section: string; name: string }> = {
  contents: { section: "Repository permissions", name: "Contents" },
  metadata: { section: "Repository permissions", name: "Metadata" },
  pull_requests: { section: "Repository permissions", name: "Pull requests" },
  checks: { section: "Repository permissions", name: "Checks" },
  statuses: { section: "Repository permissions", name: "Commit statuses" },
  deployments: { section: "Repository permissions", name: "Deployments" },
  members: { section: "Organization permissions", name: "Members" },
  repository_creation: { section: "Organization permissions", name: "Repository creation" },
};
const LEVEL_LABELS: Record<GitHubPermissionLevel, string> = {
  read: "Read-only",
  write: "Read and write",
};
export function permissionLabel(name: string, level: GitHubPermissionLevel): string {
  const label = PERMISSION_LABELS[name] ?? { section: "Permissions", name };
  return `${label.section} > ${label.name}: ${LEVEL_LABELS[level]}`;
}

/** Union of permission sets; the higher level wins. */
function union(...sets: GitHubPermissions[]): Record<string, GitHubPermissionLevel> {
  const result: Record<string, GitHubPermissionLevel> = {};
  for (const set of sets)
    for (const [name, level] of Object.entries(set))
      if (result[name] !== "write") result[name] = level;
  return result;
}

const satisfied = (granted: string | undefined, level: GitHubPermissionLevel) =>
  granted === level || (level === "read" && granted === "write");

const installationResponse = z.object({
  id: z.number().int().positive(),
  suspended_at: z.string().nullable().optional(),
  permissions: z.record(z.string(), z.string()).default({}),
  repository_selection: z.enum(["all", "selected"]).optional(),
});
type Installation = z.infer<typeof installationResponse>;
const appResponse = z.object({
  id: z.number().int().positive(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
});
const templateRepositoryResponse = z.object({
  owner: z.object({ login: z.string() }),
  is_template: z.boolean().optional(),
});
const tokenResponse = z.object({
  token: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/),
  permissions: z.record(z.string(), z.string()).optional(),
});

type Outcome = { state: GitHostCheckState; reason: string; action: string | null };
const pass = (reason: string): Outcome => ({ state: "pass", reason, action: null });
const fail = (reason: string, action: string): Outcome => ({ state: "fail", reason, action });
const unverifiable = (reason: string, action: string | null): Outcome => ({
  state: "unverifiable",
  reason,
  action,
});

const AUTHENTICATION = "“App authentication”";
const RETRY = "Run the check again later.";

/**
 * Turns an error of a dependent step into "cannot verify" with a fixed text. Host response text
 * is never used; only Weldall's own error codes are named.
 */
function cannotVerify(error: unknown, organization: string): Outcome {
  if (error instanceof ConnectorError) {
    if (
      [
        "credential_unavailable",
        "credential_ambiguous",
        "grant_mismatch",
        "credential_rejected",
      ].includes(error.code)
    )
      return unverifiable(
        `Needs a working App credential (see ${AUTHENTICATION}).`,
        `Fix ${AUTHENTICATION} first.`,
      );
    if (error.code === "installation_not_found")
      return unverifiable(
        `Needs the App's installation on ${organization} (see “Installation”).`,
        "Fix “Installation” first.",
      );
    if (error.code === "upstream_rate_limited")
      return unverifiable("GitHub is rate limiting the App.", RETRY);
    const code = /^[a-z_]{1,64}$/.test(error.code) ? error.code : "error";
    return unverifiable(`GitHub could not be asked (${code}).`, RETRY);
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return unverifiable("GitHub did not answer in time.", RETRY);
  return unverifiable("GitHub could not be reached.", RETRY);
}

/** Maps a status the caller does not handle itself to "cannot verify", naming rate limits. */
function unexpectedStatus(response: GitHubApiResponse): Outcome {
  if (rateLimited(response)) return unverifiable("GitHub is rate limiting the App.", RETRY);
  return unverifiable(`GitHub answered with HTTP ${response.status}.`, RETRY);
}

/**
 * The connect checklist for a GitHub App connector, for one run: upstream answers are shared
 * between its checks, so create one per run. Every request is a read, except minting short-lived
 * installation tokens (restricted to the permissions a check needs), which creates nothing
 * visible in the organisation.
 */
export function createGitHubChecks({
  config,
  app,
  webBaseUrl,
  loadPrivateKey,
  tokens,
  repositories,
  operationPermissions,
}: {
  config: GitHubAppConfig;
  app: GitHubAppIdentity;
  /** Browser origin matching the API base, e.g. https://github.com. */
  webBaseUrl: string;
  loadPrivateKey: () => Promise<string>;
  tokens: InstallationTokenCache;
  repositories: ReturnType<typeof createGitHubRepositories>;
  operationPermissions: typeof GITHUB_OPERATION_PERMISSIONS;
}) {
  const organization = config.organization;
  const prefix = config.repositoryNamePrefix;
  const ownersAccept = `then an owner of ${organization} accepts the updated permissions on the installation (organisation settings > GitHub Apps).`;

  /** The permission sets each part of the product needs, in GitHub's spelling. */
  const operations: { id: string; title: string; permissions: GitHubPermissions }[] = [
    {
      id: "create-repository",
      title: "Permissions: create repositories from templates",
      permissions: union(
        operationPermissions.createRepository,
        operationPermissions.inspectRepository,
      ),
    },
    {
      id: "git-proxy",
      title: "Permissions: push and fetch through the git proxy",
      permissions: union(operationPermissions.forwardRead, operationPermissions.forwardWrite),
    },
    {
      id: "pull-requests",
      title: "Permissions: open pull requests",
      permissions: union(
        operationPermissions.openPullRequest,
        operationPermissions.readBranchPullRequestState,
      ),
    },
    {
      id: "status",
      title: "Permissions: read reviews, checks and links",
      permissions: union(
        operationPermissions.readPullRequest,
        operationPermissions.readChecks,
        operationPermissions.readCommitStatuses,
        operationPermissions.readDeployments,
      ),
    },
    {
      id: "reviewer-team",
      title: "Permissions: check the reviewer team",
      permissions: operationPermissions.checkReviewerTeam,
    },
    {
      id: "commit-identity",
      title: "Permissions: read the commit identity",
      permissions: operationPermissions.readCommitIdentity,
    },
  ];

  // Shared by all checks of one run, so each upstream answer is fetched once.
  let jwtPromise: Promise<string> | undefined;
  const jwt = () =>
    (jwtPromise ??= loadPrivateKey().then((privateKey) =>
      createAppJwt({ appId: config.appId, privateKey }),
    ));
  let installationPromise: Promise<GitHubApiResponse> | undefined;
  const installationAnswer = (signal: AbortSignal) =>
    (installationPromise ??= jwt().then((token) =>
      githubApi({
        apiBaseUrl: config.apiBaseUrl,
        path: `/orgs/${segment(organization)}/installation`,
        method: "GET",
        token,
        signal,
      }),
    ));
  /** The installation for dependent checks; throws when it is unavailable. */
  async function installation(signal: AbortSignal): Promise<Installation> {
    const response = await installationAnswer(signal);
    if (response.status === 404)
      throw new ConnectorError("installation_not_found", "Not installed.", 502);
    if (response.status !== 200) throw unexpected(response);
    const parsed = installationResponse.safeParse(response.json);
    if (!parsed.success)
      throw new ConnectorError("upstream_protocol_error", "GitHub sent an invalid response.", 502);
    return parsed.data;
  }

  /**
   * An installation token without a repository restriction and with only `permissions`, for
   * organisation lookups. Never cached; it is checked to carry nothing else.
   */
  async function organizationToken(
    permissions: GitHubPermissions,
    signal: AbortSignal,
  ): Promise<string> {
    const installationId = config.installationId ?? String((await installation(signal)).id);
    const response = await githubApi({
      apiBaseUrl: config.apiBaseUrl,
      path: `/app/installations/${segment(installationId)}/access_tokens`,
      method: "POST",
      token: await jwt(),
      body: { permissions },
      signal,
    });
    if (response.status === 422)
      throw new ConnectorError("token_refused", "Permission not granted.", 502);
    if (response.status === 404)
      throw new ConnectorError("installation_not_found", "Not installed.", 502);
    if (response.status !== 201) throw unexpected(response);
    const parsed = tokenResponse.safeParse(response.json);
    if (
      !parsed.success ||
      !parsed.data.permissions ||
      Object.entries(parsed.data.permissions).some(
        ([name, level]) =>
          !(name === "metadata" && level === "read") &&
          !(permissions[name] === level || (permissions[name] === "write" && level === "read")),
      )
    )
      throw new ConnectorError(
        "upstream_protocol_error",
        "GitHub issued a broader token than requested.",
        502,
      );
    return parsed.data.token;
  }

  const grantInstructions = (missing: string[]) =>
    `In the App's settings on GitHub (Permissions & events), grant ${missing.join(", ")}; ${ownersAccept}`;

  let authenticationPromise: Promise<Outcome> | undefined;
  const authentication = (signal: AbortSignal) =>
    (authenticationPromise ??= appAuthentication(signal).catch((error: unknown) =>
      cannotVerify(error, organization),
    ));
  async function appAuthentication(signal: AbortSignal): Promise<Outcome> {
    let token: string;
    try {
      token = await jwt();
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "credential_unavailable")
        return fail(
          "No private key is provisioned for this connector.",
          "Upload the GitHub App's private key (.pem) on the connector's shared connection in the admin UI (Connections).",
        );
      if (error instanceof ConnectorError && error.code === "credential_ambiguous")
        return fail(
          "More than one enabled shared connection holds a private key for this connector, so Weldall uses none of them.",
          "Keep exactly one of them enabled and disable or delete the others.",
        );
      if (error instanceof ConnectorError && error.code === "grant_mismatch")
        return fail(
          "The provisioned private key was uploaded for a different App ID or GitHub API.",
          `Upload the private key of App ${config.appId} on the shared connection again.`,
        );
      return cannotVerify(error, organization);
    }
    const response = await githubApi({
      apiBaseUrl: config.apiBaseUrl,
      path: "/app",
      method: "GET",
      token,
      signal,
    });
    if (response.status === 401)
      return fail(
        "GitHub rejected the App's JWT: the App ID is wrong, or the private key does not belong to the App or was revoked.",
        `Check appId (${config.appId}) in the connector configuration. If it is right, generate a new private key in the App's settings on GitHub and upload it on the shared connection.`,
      );
    if (response.status !== 200) return unexpectedStatus(response);
    const parsed = appResponse.safeParse(response.json);
    if (!parsed.success || String(parsed.data.id) !== config.appId)
      return unverifiable("GitHub sent an unexpected answer for the App.", RETRY);
    return pass(`GitHub accepted the App's JWT (App "${parsed.data.slug}", ID ${config.appId}).`);
  }

  async function installationCheck(signal: AbortSignal): Promise<Outcome> {
    const response = await installationAnswer(signal);
    if (response.status === 404)
      return fail(
        `The App is not installed on the organisation ${organization}.`,
        `An owner of ${organization} installs the App (App settings on GitHub > Install App) and selects the template repositories.`,
      );
    if (response.status === 401)
      return cannotVerify(new ConnectorError("credential_rejected", "", 502), organization);
    if (response.status !== 200) return unexpectedStatus(response);
    const parsed = installationResponse.safeParse(response.json);
    if (!parsed.success) return unverifiable("GitHub sent an unexpected answer.", RETRY);
    const found = String(parsed.data.id);
    if (config.installationId && config.installationId !== found)
      return fail(
        `The connector is configured with installation ${config.installationId}, but the App's installation on ${organization} is ${found}.`,
        `Set installationId to ${found} in the connector configuration (or remove it to look it up), then apply.`,
      );
    if (parsed.data.suspended_at)
      return fail(
        `The App's installation on ${organization} is suspended.`,
        `An owner of ${organization} unsuspends the installation (organisation settings > GitHub Apps).`,
      );
    const access =
      parsed.data.repository_selection === "all" ? "all repositories" : "selected repositories";
    return pass(`Installed on ${organization} (installation ${found}, access to ${access}).`);
  }

  async function permissionsCheck(
    permissions: GitHubPermissions,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const granted = (await installation(signal)).permissions;
    const required = Object.entries(permissions).map(([name, level]) =>
      permissionLabel(name, level),
    );
    const missing = Object.entries(permissions)
      .filter(([name, level]) => !satisfied(granted[name], level))
      .map(([name, level]) => permissionLabel(name, level));
    if (missing.length)
      return fail(`The installation lacks ${missing.join(", ")}.`, grantInstructions(missing));
    return pass(`Granted: ${required.join(", ")}.`);
  }

  async function templateCheck(name: string, signal: AbortSignal): Promise<Outcome> {
    const configured = config.templates.find((template) => template.name === name)!;
    let template: { owner: string; name: string };
    try {
      template = templateFor(config, name);
    } catch {
      return fail(
        `The template repository ${configured.repository} is outside the organisation ${organization}; the App cannot read it.`,
        `Move or copy the template into ${organization}, add it to the App's installation and update the connector configuration.`,
      );
    }
    const notInInstallation = fail(
      `${configured.repository} is not in the App installation's repository selection, or it does not exist.`,
      `An owner of ${organization} adds ${configured.repository} to the App's installation (organisation settings > GitHub Apps > Configure > Repository access).`,
    );
    let token: string;
    try {
      ({ token } = await tokens.mint({
        app,
        loadPrivateKey,
        repository: template.name,
        permissions: { metadata: "read" },
        signal,
      }));
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "token_refused")
        return notInInstallation;
      throw error;
    }
    const response = await githubApi({
      apiBaseUrl: config.apiBaseUrl,
      path: `/repos/${segment(template.owner)}/${segment(template.name)}`,
      method: "GET",
      token,
      signal,
    });
    if (response.status === 404) return notInInstallation;
    if (response.status !== 200) return unexpectedStatus(response);
    const parsed = templateRepositoryResponse.safeParse(response.json);
    if (!parsed.success) return unverifiable("GitHub sent an unexpected answer.", RETRY);
    if (parsed.data.owner.login.toLowerCase() !== organization.toLowerCase())
      return fail(
        `${configured.repository} now belongs to another account (it was transferred or renamed).`,
        `Move the template back into ${organization} or update the connector configuration.`,
      );
    if (!parsed.data.is_template)
      return fail(
        `${configured.repository} is not marked as a template repository.`,
        `Tick "Template repository" in the repository's settings on GitHub (Settings > General).`,
      );
    return pass(
      `${configured.repository} is in the App's installation, in ${organization} and marked as a template.`,
    );
  }

  const teamPermission = permissionLabel("members", "read");
  async function reviewerTeamCheck(signal: AbortSignal): Promise<Outcome> {
    const team = config.reviewerTeam;
    let token: string;
    try {
      // Only `members`: on a token without a repository restriction, `metadata` would reach
      // every repository of the installation.
      token = await organizationToken({ members: "read" }, signal);
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "token_refused")
        return unverifiable(
          `The App lacks ${teamPermission}, so it cannot look up teams.`,
          grantInstructions([teamPermission]),
        );
      throw error;
    }
    const response = await githubApi({
      apiBaseUrl: config.apiBaseUrl,
      path: `/orgs/${segment(organization)}/teams/${segment(team)}`,
      method: "GET",
      token,
      signal,
    });
    if (response.status === 404)
      return fail(
        `There is no team "${team}" in ${organization}.`,
        `Create the team in ${organization} with the reviewers who have a GitHub account, or set reviewerTeam to the slug of an existing team.`,
      );
    if (response.status === 403 && !rateLimited(response))
      return unverifiable(
        `GitHub did not let the App read teams (it needs ${teamPermission}).`,
        grantInstructions([teamPermission]),
      );
    if (response.status !== 200) return unexpectedStatus(response);
    return pass(`The team "${team}" exists in ${organization}.`);
  }

  async function reviewerTeamAccessCheck(
    repository: GitHostCheckRepository | null,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const team = config.reviewerTeam;
    const howTo = `Give the team "${team}" write access to every new repository named "${prefix}*", for example through an organisation role for the team. Weldall checks it on each new repository when it is created.`;
    if (!repository)
      return unverifiable(
        "Cannot verify before a repository exists: GitHub shows a team's access only per repository.",
        howTo,
      );
    // `checkReviewerTeam` reads a refused token as a missing "Members" permission, which holds
    // while publishing (the repository was just read). Here the repository may be gone, so its
    // reachability is checked first and a later refusal really is the permission.
    try {
      await tokens.mint({
        app,
        loadPrivateKey,
        repository: repository.name,
        permissions: { metadata: "read" },
        signal,
      });
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "token_refused")
        return unverifiable(
          `The App cannot access ${organization}/${repository.name} any more (it was deleted or removed from the installation).`,
          "Run the check again after the next publish.",
        );
      throw error;
    }
    try {
      await repositories.checkReviewerTeam(repository.name, signal);
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "reviewer_team_access_missing")
        return fail(
          `The team "${team}" has no write access to ${organization}/${repository.name}, an existing app's repository.`,
          howTo,
        );
      if (error instanceof ConnectorError && error.code === "reviewer_team_unverifiable")
        return unverifiable(
          `The App lacks ${teamPermission}, so it cannot read the team's access.`,
          grantInstructions([teamPermission]),
        );
      throw error;
    }
    return pass(
      `The team "${team}" has write access to ${organization}/${repository.name}, an existing app's repository.`,
    );
  }

  async function branchRuleCheck(
    repository: GitHostCheckRepository | null,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const rule = `Recommended: an organisation ruleset for the default branch of repositories named "${prefix}*" that allows changes only through pull requests with at least one approving review, and blocks force-pushes and deletion. Weldall's git proxy never pushes to the default branch either way.`;
    if (!repository)
      return unverifiable(
        "Cannot verify before a repository exists: the App cannot read organisation rulesets, only the rules that apply to an existing repository.",
        rule,
      );
    let warnings;
    try {
      warnings = await repositories.checkBranchRules(
        repository.name,
        repository.defaultBranch,
        signal,
      );
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "token_refused")
        return unverifiable(
          `The App cannot access ${organization}/${repository.name} any more (it was deleted or removed from the installation).`,
          "Run the check again after the next publish.",
        );
      throw error;
    }
    const [warning] = warnings;
    if (!warning)
      return pass(
        `The default branch "${repository.defaultBranch}" of ${organization}/${repository.name} (an existing app's repository) is protected by rules.`,
      );
    if (warning.code === "default_branch_unprotected") return fail(warning.message, rule);
    return unverifiable(warning.message, RETRY);
  }

  async function commitIdentityCheck(signal: AbortSignal): Promise<Outcome> {
    // The lookup starts with the App itself; its failure is reported there, not twice.
    if ((await authentication(signal)).state !== "pass")
      return cannotVerify(new ConnectorError("credential_rejected", "", 502), organization);
    try {
      const identity = await readGitHubCommitIdentity({
        apiBaseUrl: config.apiBaseUrl,
        webBaseUrl,
        appId: config.appId,
        loadPrivateKey,
        mintToken: (tokenSignal) =>
          organizationToken(operationPermissions.readCommitIdentity, tokenSignal),
        signal,
      });
      return pass(`Published commits are attributed to ${identity.name} <${identity.email}>.`);
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "commit_identity_unavailable")
        return fail(
          "GitHub did not return the App's bot account, so published commits cannot be attributed to the App.",
          webBaseUrl === "https://github.com"
            ? "Check that the App still exists and is installed; run the check again later."
            : "Commit attribution is only supported on github.com so far.",
        );
      throw error;
    }
  }

  return async function checkSetup(
    { repository }: { repository: GitHostCheckRepository | null },
    signal: AbortSignal,
  ): Promise<GitHostCheck[]> {
    const run = async (
      check: { id: string; title: string; required?: boolean },
      body: () => Promise<Outcome>,
    ): Promise<GitHostCheck> => {
      let outcome: Outcome;
      try {
        outcome = await body();
      } catch (error) {
        outcome = cannotVerify(error, organization);
      }
      return { id: check.id, title: check.title, required: check.required ?? true, ...outcome };
    };
    return Promise.all([
      run({ id: "app-authentication", title: "App authentication" }, () => authentication(signal)),
      run({ id: "installation", title: "Installation" }, () => installationCheck(signal)),
      ...operations.map((operation) =>
        run({ id: `permissions.${operation.id}`, title: operation.title }, () =>
          permissionsCheck(operation.permissions, signal),
        ),
      ),
      ...config.templates.map((template) =>
        run({ id: `template.${template.name}`, title: `Template "${template.name}"` }, () =>
          templateCheck(template.name, signal),
        ),
      ),
      run({ id: "reviewer-team", title: "Reviewer team exists" }, () => reviewerTeamCheck(signal)),
      run({ id: "reviewer-team-access", title: "Reviewer team write access" }, () =>
        reviewerTeamAccessCheck(repository, signal),
      ),
      run({ id: "branch-rule", title: "Default-branch rule", required: false }, () =>
        branchRuleCheck(repository, signal),
      ),
      run({ id: "commit-identity", title: "Commit identity" }, () => commitIdentityCheck(signal)),
    ]);
  };
}
