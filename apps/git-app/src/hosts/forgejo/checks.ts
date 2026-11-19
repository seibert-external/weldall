import { z } from "zod";
import { GitAppError } from "../../errors.js";
import {
  cannotVerifyOutcomes,
  fail,
  pass,
  RETRY,
  unverifiable,
  type Outcome,
} from "../check-outcomes.js";
import type { GitHostCheck, GitHostCheckRepository } from "../git-host.js";
import {
  branchPath,
  FORGEJO_PAGE_SIZE,
  forgejoApi,
  LIST_RESPONSE_LIMIT,
  segment,
  type ForgejoApiResponse,
} from "./api.js";
import type { ForgejoConfig } from "./config.js";
import { readForgejoCommitIdentity } from "./identity.js";
import {
  missingProtections,
  teamCanWrite,
  teamResponse,
  templateFor,
  type createForgejoRepositories,
} from "./repositories.js";

/**
 * Token scopes Weldall needs, as Forgejo names them when an access token is created:
 * `write:organization` only for creating repositories in the organisation (Forgejo refuses
 * `generate` without it), `write:repository` for git, pull requests, reviews and statuses,
 * `read:user` for the commit identity and this checklist. Team lookups need `read:organization`,
 * which `write:organization` includes.
 */
export const FORGEJO_TOKEN_SCOPES = ["write:repository", "write:organization", "read:user"];
/** Scopes a token may have without being broader than needed (read scopes the write ones include). */
const ACCEPTED_SCOPES = new Set([...FORGEJO_TOKEN_SCOPES, "read:repository", "read:organization"]);

const userResponse = z.object({
  login: z.string(),
  is_admin: z.boolean().optional(),
});
const tokensResponse = z.array(
  z.object({
    scopes: z.array(z.string()).nullable().optional(),
    token_last_eight: z.string(),
    repositories: z.array(z.unknown()).nullable().optional(),
  }),
);
const organizationPermissionsResponse = z.object({
  is_owner: z.boolean(),
  is_admin: z.boolean().optional(),
  can_create_repository: z.boolean(),
});
const actionsResponse = z.object({ has_actions: z.boolean() });
const templateRepositoryResponse = z.object({
  owner: z.object({ login: z.string() }),
  template: z.boolean().optional(),
  default_branch: z.string().optional(),
});
const repositoryResponse = z.object({
  permissions: z.object({ admin: z.boolean().optional() }).optional(),
});
const teamListItem = teamResponse.extend({ includes_all_repositories: z.boolean().optional() });
const branchResponse = z.object({
  protected: z.boolean().optional(),
  required_approvals: z.number().int().optional(),
  user_can_push: z.boolean().optional(),
});

const { cannotVerify, unexpectedStatus } = cannotVerifyOutcomes<ForgejoApiResponse>({
  host: "Forgejo",
  credential: "a working bot user token",
  credentialCheck: "“Bot user token”",
  rateLimitedReason: "Forgejo is rate limiting Weldall.",
});

/**
 * The set-up checklist for a Forgejo-hosted Git app, for one run. Every request is a read. The bot
 * user's identity, token scopes and organisation rights are checked from the token itself.
 */
export function createForgejoChecks({
  config,
  loadToken,
  repositories,
}: {
  config: ForgejoConfig;
  loadToken: () => Promise<string>;
  repositories: ReturnType<typeof createForgejoRepositories>;
}) {
  const organization = config.organization;
  const bot = config.botUser;
  const prefix = config.repositoryNamePrefix;
  const get = async (path: string, signal: AbortSignal) =>
    forgejoApi({
      baseUrl: config.baseUrl,
      path,
      method: "GET",
      token: await loadToken(),
      responseLimit: LIST_RESPONSE_LIMIT,
      signal,
    });
  let userPromise: Promise<ForgejoApiResponse> | undefined;
  const userAnswer = (signal: AbortSignal) => (userPromise ??= get("/user", signal));

  let tokenPromise: Promise<Outcome> | undefined;
  const tokenCheck = (signal: AbortSignal) =>
    (tokenPromise ??= botToken(signal).catch((error: unknown) => cannotVerify(error)));
  async function botToken(signal: AbortSignal): Promise<Outcome> {
    try {
      await loadToken();
    } catch (error) {
      return cannotVerify(error);
    }
    const response = await userAnswer(signal);
    if (response.status === 401)
      return fail(
        "Forgejo rejected the token: it was revoked or deleted, or the bot user is disabled.",
        `Create a new access token for ${bot} and give it to the Git app as its host secret, then restart it.`,
      );
    if (response.status === 403)
      return fail(
        "Forgejo refused to name the token's user: the token lacks the scope read:user.",
        `Create a token for ${bot} with the scopes ${FORGEJO_TOKEN_SCOPES.join(", ")}.`,
      );
    if (response.status !== 200) return unexpectedStatus(response);
    const parsed = userResponse.safeParse(response.json);
    if (!parsed.success) return unverifiable("Forgejo sent an unexpected answer.", RETRY);
    if (parsed.data.login.toLowerCase() !== bot.toLowerCase())
      return fail(
        `The token belongs to the Forgejo user ${parsed.data.login}, not to the configured bot user ${bot}.`,
        `Paste an access token of ${bot} (a dedicated user, never a person's token), or correct botUser in the Git app's host configuration.`,
      );
    if (parsed.data.is_admin)
      return fail(
        `${bot} is a site administrator of the Forgejo instance, so a leaked token could change the whole instance.`,
        `Remove the administrator flag from ${bot} (Site administration > User accounts).`,
      );
    return pass(`Forgejo accepted the token of the bot user ${bot}.`);
  }

  async function scopesCheck(signal: AbortSignal): Promise<Outcome> {
    const token = await loadToken();
    const response = await get(`/users/${segment(bot)}/tokens?limit=${FORGEJO_PAGE_SIZE}`, signal);
    if (response.status === 403 || response.status === 401)
      return unverifiable(
        "Forgejo did not list the bot user's tokens (it needs the scope read:user).",
        `Create a token for ${bot} with the scopes ${FORGEJO_TOKEN_SCOPES.join(", ")}.`,
      );
    if (response.status !== 200) return unexpectedStatus(response);
    const parsed = tokensResponse.safeParse(response.json);
    if (!parsed.success) return unverifiable("Forgejo sent an unexpected answer.", RETRY);
    const matches = parsed.data.filter(({ token_last_eight }) => token.endsWith(token_last_eight));
    if (matches.length !== 1)
      return unverifiable(
        "Forgejo lists several or none of the bot user's tokens with the same last characters, so Weldall cannot tell which one it holds.",
        "Delete unused tokens of the bot user in Forgejo.",
      );
    const [entry] = matches as [z.infer<typeof tokensResponse>[number]];
    const scopes = entry.scopes ?? [];
    if (entry.repositories?.length)
      return fail(
        "The token is limited to specific repositories, so it cannot create repositories in the organisation.",
        `Create a token for ${bot} without a repository limit, with the scopes ${FORGEJO_TOKEN_SCOPES.join(", ")}.`,
      );
    const all = scopes.includes("all");
    const missing = FORGEJO_TOKEN_SCOPES.filter((scope) => {
      if (all || scopes.includes(scope)) return false;
      const [, area] = scope.split(":");
      return !(scope.startsWith("read:") && scopes.includes(`write:${area}`));
    });
    if (missing.length)
      return fail(
        `The token lacks the scopes ${missing.join(", ")}.`,
        `Create a token for ${bot} with the scopes ${FORGEJO_TOKEN_SCOPES.join(", ")} and give it to the Git app as its host secret.`,
      );
    return pass(`The token has the scopes ${FORGEJO_TOKEN_SCOPES.join(", ")}.`);
  }

  async function narrowScopesCheck(signal: AbortSignal): Promise<Outcome> {
    const token = await loadToken();
    const response = await get(`/users/${segment(bot)}/tokens?limit=${FORGEJO_PAGE_SIZE}`, signal);
    if (response.status !== 200) return unexpectedStatus(response);
    const parsed = tokensResponse.safeParse(response.json);
    const entry = parsed.success
      ? parsed.data.filter(({ token_last_eight }) => token.endsWith(token_last_eight))
      : [];
    if (entry.length !== 1) return unverifiable("See “Token scopes”.", null);
    const broader = (entry[0]!.scopes ?? []).filter((scope) => !ACCEPTED_SCOPES.has(scope));
    if (broader.length)
      return fail(
        `The token also has ${broader.join(", ")}, which Weldall does not need.`,
        `Replace it with a token that has only ${FORGEJO_TOKEN_SCOPES.join(", ")}.`,
      );
    return pass("The token has no scopes beyond what Weldall needs.");
  }

  async function organizationCheck(signal: AbortSignal): Promise<Outcome> {
    const response = await get(
      `/users/${segment(bot)}/orgs/${segment(organization)}/permissions`,
      signal,
    );
    if (response.status === 404)
      return fail(
        `The organisation ${organization} does not exist, or ${bot} is not a member of it.`,
        `An owner of ${organization} adds ${bot} to a team of ${organization} that may create repositories.`,
      );
    if (response.status === 403)
      return unverifiable(
        "Forgejo refused to show the bot user's rights in the organisation (the token needs read:organization or write:organization).",
        `Create a token for ${bot} with the scopes ${FORGEJO_TOKEN_SCOPES.join(", ")}.`,
      );
    if (response.status !== 200) return unexpectedStatus(response);
    const parsed = organizationPermissionsResponse.safeParse(response.json);
    if (!parsed.success) return unverifiable("Forgejo sent an unexpected answer.", RETRY);
    if (parsed.data.is_owner || parsed.data.is_admin)
      return fail(
        `${bot} is an owner or administrator of ${organization}. It would keep admin rights on every new repository and could change the organisation.`,
        `Remove ${bot} from the Owners team and from teams with admin access; put it into a team that may create repositories, without access to other repositories.`,
      );
    if (!parsed.data.can_create_repository)
      return fail(
        `${bot} may not create repositories in ${organization}.`,
        `An owner of ${organization} puts ${bot} into a team with "Create repositories" allowed.`,
      );
    return pass(`${bot} is a member of ${organization}, may create repositories and is no owner.`);
  }

  async function templateCheck(name: string, signal: AbortSignal): Promise<Outcome> {
    const configured = config.templates.find((template) => template.name === name)!;
    const template = templateFor(config, name);
    const response = await get(
      `/repos/${segment(template.owner)}/${segment(template.name)}`,
      signal,
    );
    if (response.status === 404)
      return fail(
        `${configured.repository} does not exist, or ${bot} cannot read it.`,
        `Give a team of ${bot} read access to ${configured.repository}.`,
      );
    if (response.status !== 200) return unexpectedStatus(response);
    const parsed = templateRepositoryResponse.safeParse(response.json);
    if (!parsed.success) return unverifiable("Forgejo sent an unexpected answer.", RETRY);
    if (!parsed.data.template)
      return fail(
        `${configured.repository} is not marked as a template repository.`,
        `Tick "Template" in the repository's settings in Forgejo.`,
      );
    return pass(`${configured.repository} is readable for ${bot} and marked as a template.`);
  }

  /** The template's default branch must carry the protection that `generate` copies. */
  async function templateProtectionCheck(name: string, signal: AbortSignal): Promise<Outcome> {
    const configured = config.templates.find((template) => template.name === name)!;
    const template = templateFor(config, name);
    const repository = await get(
      `/repos/${segment(template.owner)}/${segment(template.name)}`,
      signal,
    );
    const parsedRepository =
      repository.status === 200 ? templateRepositoryResponse.safeParse(repository.json) : null;
    if (!parsedRepository?.success || !parsedRepository.data.default_branch)
      return unverifiable(`See “Template "${name}"”.`, null);
    const branch = parsedRepository.data.default_branch;
    const response = await get(
      `/repos/${segment(template.owner)}/${segment(template.name)}/branches/${branchPath(branch)}`,
      signal,
    );
    if (response.status !== 200) return unexpectedStatus(response);
    const parsed = branchResponse.safeParse(response.json);
    if (!parsed.success) return unverifiable("Forgejo sent an unexpected answer.", RETRY);
    const missing = parsed.data.protected
      ? (parsed.data.required_approvals ?? 0) < 1
        ? ["at least one required approval"]
        : []
      : ["a branch protection rule"];
    if (missing.length)
      return fail(
        `The default branch "${branch}" of ${configured.repository} lacks ${missing.join(", ")}. Forgejo copies the template's rules into each new repository, so new repositories would lack it too.`,
        `Add a branch protection rule for "${branch}" to ${configured.repository}: push disabled, at least one required approval, "apply to administrators" on.`,
      );
    return pass(
      `The default branch "${branch}" of ${configured.repository} is protected with a required approval; new repositories get a copy.`,
    );
  }

  async function reviewerTeamCheck(signal: AbortSignal): Promise<Outcome> {
    const team = config.reviewerTeam;
    const teams: z.infer<typeof teamListItem>[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await get(
        `/orgs/${segment(organization)}/teams?limit=${FORGEJO_PAGE_SIZE}&page=${page}`,
        signal,
      );
      if (response.status === 403 || response.status === 404)
        return unverifiable(
          `Forgejo did not list the teams of ${organization} for ${bot} (it must be a member, and the token needs read:organization or write:organization).`,
          `Check the organisation membership of ${bot} and the token's scopes.`,
        );
      if (response.status !== 200) return unexpectedStatus(response);
      const parsed = z.array(teamListItem).safeParse(response.json);
      if (!parsed.success) return unverifiable("Forgejo sent an unexpected answer.", RETRY);
      teams.push(...parsed.data);
      if (parsed.data.length < FORGEJO_PAGE_SIZE) break;
    }
    const found = teams.find((candidate) => candidate.name.toLowerCase() === team.toLowerCase());
    if (!found)
      return fail(
        `There is no team "${team}" in ${organization}.`,
        `Create the team in ${organization} with the reviewers, or set reviewerTeam to the name of an existing team.`,
      );
    if (!teamCanWrite(found))
      return fail(
        `The team "${team}" has no write access to code, so its approvals would not count.`,
        `Give the team "${team}" write access to code and pull requests.`,
      );
    if (!found.includes_all_repositories)
      return fail(
        `The team "${team}" does not have access to all repositories of ${organization}. Forgejo adds only the Owners team to a new repository, and Weldall's bot user may not add teams.`,
        `Turn on "Access to all repositories" for the team "${team}" (team settings in ${organization}); a dedicated organisation keeps that access limited to apps.`,
      );
    return pass(
      `The team "${team}" exists in ${organization}, can write and has access to all repositories.`,
    );
  }

  async function reviewerTeamAccessCheck(
    repository: GitHostCheckRepository | null,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const team = config.reviewerTeam;
    if (!repository)
      return unverifiable(
        "Cannot verify before a repository exists; see “Reviewer team” for the organisation setting.",
        null,
      );
    try {
      await repositories.checkReviewerTeam(repository.name, signal);
    } catch (error) {
      if (error instanceof GitAppError && error.code === "reviewer_team_access_missing")
        return fail(
          `The team "${team}" has no write access to ${organization}/${repository.name}, an existing app's repository.`,
          `Turn on "Access to all repositories" for the team "${team}", or give it write access to that repository.`,
        );
      if (error instanceof GitAppError && error.code === "reviewer_team_unverifiable")
        return unverifiable(error.message, null);
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
    const rule = `Recommended: a branch protection rule for the default branch in every template (push disabled, at least one required approval, "apply to administrators"). Forgejo copies it into each new repository named "${prefix}*". Weldall's git proxy never pushes to the default branch either way.`;
    if (!repository)
      return unverifiable(
        "Cannot verify before a repository exists; see the template checks for the rule new repositories get.",
        rule,
      );
    const response = await get(
      `/repos/${segment(organization)}/${segment(repository.name)}/branches/${branchPath(repository.defaultBranch)}`,
      signal,
    );
    if (response.status === 404)
      return unverifiable(
        `${organization}/${repository.name} or its default branch no longer exists, or ${bot} lost access to it.`,
        "Run the check again after the next publish.",
      );
    if (response.status !== 200) return unexpectedStatus(response);
    const parsed = branchResponse.safeParse(response.json);
    if (!parsed.success) return unverifiable("Forgejo sent an unexpected answer.", RETRY);
    const missing = missingProtections(parsed.data);
    if (missing.length)
      return fail(
        `The default branch "${repository.defaultBranch}" of ${organization}/${repository.name} (an existing app's repository) lacks: ${missing.join(", ")}.`,
        rule,
      );
    return pass(
      `The default branch "${repository.defaultBranch}" of ${organization}/${repository.name} (an existing app's repository) is protected and ${bot} cannot push to it.`,
    );
  }

  async function botAccessCheck(
    repository: GitHostCheckRepository | null,
    signal: AbortSignal,
  ): Promise<Outcome> {
    if (!repository)
      return unverifiable(
        "Cannot verify before a repository exists. Weldall lowers its own access to write right after creating each repository.",
        null,
      );
    const response = await get(
      `/repos/${segment(organization)}/${segment(repository.name)}`,
      signal,
    );
    if (response.status === 404)
      return unverifiable(
        `${organization}/${repository.name} no longer exists, or ${bot} lost access to it.`,
        "Run the check again after the next publish.",
      );
    if (response.status !== 200) return unexpectedStatus(response);
    const parsed = repositoryResponse.safeParse(response.json);
    if (!parsed.success) return unverifiable("Forgejo sent an unexpected answer.", RETRY);
    if (typeof parsed.data.permissions?.admin !== "boolean")
      return unverifiable("Forgejo did not report the bot user's rights on the repository.", RETRY);
    if (parsed.data.permissions.admin)
      return fail(
        `${bot} has admin rights on ${organization}/${repository.name}, so it could change the branch protection and the visibility.`,
        `Remove ${bot}'s admin rights: take it out of the Owners team and of teams with admin access, and set its collaborator access on the repository to write.`,
      );
    return pass(
      `${bot} has write access, not admin rights, on ${organization}/${repository.name}.`,
    );
  }

  /**
   * Forgejo accepts pushes that change workflow files and runs them, so a workflow pushed by hand
   * onto a publish branch runs before review with the repository's Actions secrets (including
   * organisation secrets), on its runners and with a token that writes outside the proxy's rules.
   * Passes only while Actions is off on every template and on the latest app repository; never
   * passes while it is on, and states the risk in every outcome.
   */
  async function actionsCheck(
    repository: GitHostCheckRepository | null,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const risk =
      "With Forgejo Actions on, anyone who may publish can push a workflow of their own onto a weldall/publish-* branch through the git proxy; it runs before review with every Actions secret the repository can reach (including organisation secrets), on the repository's runners, and with an automatic token that can write to the repository outside the git proxy's rules. GitHub refuses such a push; Forgejo does not.";
    const action =
      "Switch the Actions unit off on every template and app repository and deploy from outside Forgejo Actions, or keep deployment credentials out of Actions secrets that app repositories can reach (separate runner and organisation).";
    const targets = [
      ...config.templates.map((template) => template.repository),
      ...(repository ? [`${repository.owner}/${repository.name}`] : []),
    ];
    const on: string[] = [];
    const unknown: string[] = [];
    for (const target of targets) {
      const [owner, name] = target.split("/") as [string, string];
      const response = await get(`/repos/${segment(owner)}/${segment(name)}`, signal);
      const parsed = response.status === 200 ? actionsResponse.safeParse(response.json) : null;
      if (!parsed?.success) unknown.push(target);
      else if (parsed.data.has_actions) on.push(target);
    }
    if (on.length) return fail(`Forgejo Actions is on for ${on.join(", ")}. ${risk}`, action);
    if (unknown.length)
      return unverifiable(
        `Weldall could not read whether Forgejo Actions is on for ${unknown.join(", ")}. ${risk}`,
        action,
      );
    return {
      state: "pass",
      reason: `Forgejo Actions is off for ${targets.join(", ")}${repository ? "" : " (no app repository exists yet; check new repositories too)"}. If it is switched on later: ${risk}`,
      action: null,
    };
  }

  async function commitIdentityCheck(signal: AbortSignal): Promise<Outcome> {
    if ((await tokenCheck(signal)).state !== "pass")
      return cannotVerify(new GitAppError("credential_rejected", "", 502));
    try {
      const identity = await readForgejoCommitIdentity({
        config,
        token: await loadToken(),
        signal,
      });
      return pass(`Published commits are attributed to ${identity.name} <${identity.email}>.`);
    } catch (error) {
      if (error instanceof GitAppError && error.code === "commit_identity_unavailable")
        return fail(
          error.message,
          `Give ${bot} a primary email address in Forgejo (Settings > Account).`,
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
        outcome = cannotVerify(error);
      }
      return { id: check.id, title: check.title, required: check.required ?? true, ...outcome };
    };
    // Every other check needs a working token; they run after it, so they share its answer.
    const token = await run({ id: "bot-token", title: "Bot user token" }, () => tokenCheck(signal));
    const usable = token.state === "pass";
    const dependent = (body: () => Promise<Outcome>) => () =>
      usable
        ? body()
        : Promise.resolve(cannotVerify(new GitAppError("credential_rejected", "", 502)));
    return [
      token,
      ...(await Promise.all([
        run(
          { id: "token-scopes", title: "Token scopes" },
          dependent(() => scopesCheck(signal)),
        ),
        run(
          { id: "token-scopes-narrow", title: "Token has no extra scopes", required: false },
          dependent(() => narrowScopesCheck(signal)),
        ),
        run(
          { id: "organization", title: "Organisation membership" },
          dependent(() => organizationCheck(signal)),
        ),
        ...config.templates.flatMap((template) => [
          run(
            { id: `template.${template.name}`, title: `Template "${template.name}"` },
            dependent(() => templateCheck(template.name, signal)),
          ),
          run(
            {
              id: `template-protection.${template.name}`,
              title: `Template "${template.name}" protects its default branch`,
              required: false,
            },
            dependent(() => templateProtectionCheck(template.name, signal)),
          ),
        ]),
        run(
          { id: "reviewer-team", title: "Reviewer team" },
          dependent(() => reviewerTeamCheck(signal)),
        ),
        run(
          { id: "reviewer-team-access", title: "Reviewer team write access" },
          dependent(() => reviewerTeamAccessCheck(repository, signal)),
        ),
        run(
          {
            id: "bot-repository-access",
            title: "Bot user has no admin rights on app repositories",
          },
          dependent(() => botAccessCheck(repository, signal)),
        ),
        run(
          { id: "branch-rule", title: "Default-branch rule", required: false },
          dependent(() => branchRuleCheck(repository, signal)),
        ),
        run(
          {
            id: "actions-workflows",
            title: "Forgejo Actions off (pushed workflows run before review)",
            required: false,
          },
          dependent(() => actionsCheck(repository, signal)),
        ),
        run(
          { id: "commit-identity", title: "Commit identity" },
          dependent(() => commitIdentityCheck(signal)),
        ),
      ])),
    ];
  };
}
