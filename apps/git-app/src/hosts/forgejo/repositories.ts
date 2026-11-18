import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { GitAppError } from "../../errors.js";
import type {
  CreateRepositoryInput,
  CreatedRepository,
  GitHostWarning,
  GitRepositoryRef,
  NewRepository,
} from "../git-host.js";
import { branchPath, forgejoApi, protocolError, segment, unexpected } from "./api.js";
import { forgejoRepositoryWebUrl, type ForgejoConfig } from "./config.js";

/** Forgejo answered `generate` with the content in place (1.4 s locally); polling covers slower instances. */
export const REPOSITORY_READY_TIMEOUT_MS = 30_000;
export const REPOSITORY_READY_POLL_INTERVAL_MS = 750;

/** Forgejo's limit for repository names. */
const MAX_REPOSITORY_NAME = 100;
const requestedName = /^[a-z0-9][a-z0-9._-]*$/;
/** Suffixes Forgejo reserves for its own routes. */
const reservedSuffixes = [".git", ".wiki", ".rss", ".atom"];

/**
 * Normalises a requested app name to the repository name: trimmed and lower-cased with the
 * configured prefix (Forgejo names are case-insensitive, so this keeps the registry key unique).
 * Everything else is validated, never rewritten.
 */
export function repositoryNameFor(config: ForgejoConfig, name: string): string {
  const value = name.trim().toLowerCase();
  const full = `${config.repositoryNamePrefix.toLowerCase()}${value}`;
  if (
    !requestedName.test(value) ||
    full.length > MAX_REPOSITORY_NAME ||
    full.startsWith(".") ||
    reservedSuffixes.some((suffix) => full.endsWith(suffix))
  )
    throw new GitAppError(
      "invalid_name",
      `Use an app name of letters, digits, ".", "-" or "_" that starts with a letter or digit, does not end in ${reservedSuffixes.map((suffix) => `"${suffix}"`).join(", ")} and has at most ${MAX_REPOSITORY_NAME - config.repositoryNamePrefix.length} characters.`,
    );
  return full;
}

/** Resolves a configured template repository. */
export function templateFor(config: ForgejoConfig, name: string): GitRepositoryRef {
  const template = config.templates.find((candidate) => candidate.name === name);
  if (!template)
    throw new GitAppError(
      "unknown_template",
      `Template "${name}" is not configured on this Git app. Available: ${config.templates.map((candidate) => candidate.name).join(", ")}.`,
    );
  const [owner, repository] = template.repository.split("/") as [string, string];
  return { owner, name: repository };
}

const repositoryResponse = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
  private: z.boolean(),
  /** Empty in Forgejo's answer to `generate`; read the repository again for it. */
  default_branch: z.string().max(255).optional(),
  permissions: z.object({ admin: z.boolean().optional(), push: z.boolean().optional() }).optional(),
});
type ForgejoRepository = z.infer<typeof repositoryResponse>;
const branchResponse = z.object({
  commit: z.object({ id: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) }),
  protected: z.boolean().optional(),
  required_approvals: z.number().int().optional(),
  user_can_push: z.boolean().optional(),
});
const teamResponse = z.object({
  name: z.string(),
  permission: z.string().optional(),
  units_map: z.record(z.string(), z.string()).optional(),
});

/** Write access to code, so the team's approvals count. */
export function teamCanWrite(team: z.infer<typeof teamResponse>): boolean {
  if (["write", "admin", "owner"].includes(team.permission ?? "")) return true;
  return ["write", "admin"].includes(team.units_map?.["repo.code"] ?? "");
}
export { teamResponse };

/** What the default branch lacks for reviewed-only changes, read with the bot's (write) access. */
export function missingProtections(branch: {
  protected?: boolean | undefined;
  required_approvals?: number | undefined;
  user_can_push?: boolean | undefined;
}): string[] {
  if (!branch.protected) return ["branch protection (changes only through pull requests)"];
  const missing: string[] = [];
  if ((branch.required_approvals ?? 0) < 1) missing.push("at least one required approval");
  if (branch.user_can_push) missing.push("no direct push (Weldall's bot user may still push)");
  return missing;
}

/**
 * Creates a private repository from a configured template, drops the bot user's admin right on it,
 * waits for its default branch and checks the customer-managed prerequisites (default-branch
 * protection copied from the template, reviewer team write access).
 */
export function createForgejoRepositories({
  config,
  loadToken,
  readyTimeoutMs = REPOSITORY_READY_TIMEOUT_MS,
  pollIntervalMs = REPOSITORY_READY_POLL_INTERVAL_MS,
}: {
  config: ForgejoConfig;
  loadToken: () => Promise<string>;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
}) {
  const organization = config.organization;
  const label = (name: string) => `${organization}/${name}`;
  const repositoryPath = (name: string) => `/repos/${segment(organization)}/${segment(name)}`;
  const api = async (
    input: Omit<Parameters<typeof forgejoApi>[0], "baseUrl" | "token">,
  ): ReturnType<typeof forgejoApi> =>
    forgejoApi({ ...input, baseUrl: config.baseUrl, token: await loadToken() });

  /** Parses a repository Forgejo returned and fails loudly unless it is the expected private one. */
  function confirmRepository(json: unknown, name: string, created: boolean): ForgejoRepository {
    const parsed = repositoryResponse.safeParse(json);
    if (!parsed.success) throw protocolError();
    const repository = parsed.data;
    if (
      repository.owner.login.toLowerCase() !== organization.toLowerCase() ||
      repository.name.toLowerCase() !== name.toLowerCase()
    )
      throw new GitAppError(
        "repository_unexpected",
        `Forgejo reported ${repository.owner.login}/${repository.name} instead of ${label(name)}. An administrator must check both repositories in Forgejo.`,
        502,
      );
    if (!repository.private)
      throw new GitAppError(
        "repository_not_private",
        `${created ? "Forgejo created" : "Forgejo reports"} ${label(repository.name)} without private visibility. The repository exists; an administrator must check its visibility in Forgejo (and delete it if it was exposed) before anyone publishes to it.`,
        502,
      );
    return repository;
  }

  async function generate(
    input: { template: GitRepositoryRef; name: string; description: string },
    signal: AbortSignal,
  ) {
    const templateLabel = `${input.template.owner}/${input.template.name}`;
    const response = await api({
      path: `/repos/${segment(input.template.owner)}/${segment(input.template.name)}/generate`,
      method: "POST",
      body: {
        owner: organization,
        name: input.name,
        description: input.description,
        // Forgejo's default is a public repository; always ask for a private one explicitly.
        private: true,
        git_content: true,
        // Copies the template's branch protection rules: the customer-managed default-branch rule.
        protected_branch: true,
      },
      signal,
    });
    if (response.status === 201) return confirmRepository(response.json, input.name, true);
    if (response.status === 404)
      throw new GitAppError(
        "template_unavailable",
        `Forgejo did not find the template repository ${templateLabel} for the bot user ${config.botUser}. Give a team of the bot user read access to it and mark it as a template repository in its settings in Forgejo.`,
        409,
      );
    if (response.status === 409)
      throw new GitAppError(
        "repository_exists",
        `A repository named ${label(input.name)} already exists in Forgejo.`,
        409,
      );
    if (response.status === 403)
      throw new GitAppError(
        "repository_creation_not_permitted",
        `Forgejo refused to let the bot user ${config.botUser} create repositories in ${organization}. Put the bot user into a team of ${organization} that may create repositories, and give its access token the scopes write:repository, write:organization and read:user.`,
        502,
      );
    if (response.status === 422)
      throw new GitAppError(
        "repository_refused",
        `Forgejo refused to create ${label(input.name)} from ${templateLabel}. Check that the template repository is marked as a template and not empty.`,
        502,
      );
    throw unexpected(response);
  }

  async function readRepository(name: string, signal: AbortSignal) {
    const response = await api({ path: repositoryPath(name), method: "GET", signal });
    if (response.status === 200) return confirmRepository(response.json, name, false);
    if (response.status === 404)
      throw new GitAppError(
        "repository_unavailable",
        `${label(name)} no longer exists in Forgejo or the bot user ${config.botUser} lost access to it. An administrator must check the repository.`,
        409,
      );
    throw unexpected(response);
  }

  /**
   * Forgejo makes a member who creates an organisation repository its administrator. Weldall
   * needs only write access, so it lowers its own right right after creating the repository:
   * then the bot user can neither change the branch protection nor the visibility, and the
   * default-branch protection binds it like everyone else. Fails when an admin right remains
   * (the bot user is an owner of the organisation or in a team with admin access).
   */
  async function dropAdminRight(repository: ForgejoRepository, signal: AbortSignal) {
    // Lowered whenever the answer does not prove the bot user is no admin.
    if (repository.permissions?.admin !== false) {
      const response = await api({
        path: `${repositoryPath(repository.name)}/collaborators/${segment(config.botUser)}`,
        method: "PUT",
        body: { permission: "write" },
        signal,
      });
      if (response.status !== 204 && response.status !== 200) throw unexpected(response);
    }
    const after = await readRepository(repository.name, signal);
    // Fail closed: an answer without the bot user's permissions cannot prove the drop.
    if (typeof after.permissions?.admin !== "boolean")
      throw new GitAppError(
        "bot_rights_unverifiable",
        `Forgejo did not report the bot user's rights on ${label(repository.name)}, so Weldall cannot confirm that it no longer has admin rights. Retry later; an administrator should check the bot user's access to the repository in Forgejo.`,
        502,
      );
    if (after.permissions.admin)
      throw new GitAppError(
        "bot_user_too_privileged",
        `The bot user ${config.botUser} still has admin rights on ${label(repository.name)} after Weldall lowered its own access to write. It is probably an owner of ${organization} or in a team with admin access. Make it a plain member of a team that may create repositories, then publish again.`,
        409,
      );
    return after;
  }

  /** Polls the default branch until it exists; 404 means "content not copied yet". */
  async function waitForDefaultBranch(name: string, branch: string, signal: AbortSignal) {
    const deadline = AbortSignal.timeout(readyTimeoutMs);
    const bounded = AbortSignal.any([signal, deadline]);
    try {
      for (;;) {
        const response = await api({
          path: `${repositoryPath(name)}/branches/${branchPath(branch)}`,
          method: "GET",
          signal: bounded,
        });
        if (response.status === 200) {
          const parsed = branchResponse.safeParse(response.json);
          if (!parsed.success) throw protocolError();
          return parsed.data.commit.id;
        }
        if (response.status !== 404 && response.status !== 409) throw unexpected(response);
        await sleep(pollIntervalMs, undefined, { signal: bounded });
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (deadline.aborted)
        throw new GitAppError(
          "repository_not_ready",
          `Forgejo created ${label(name)}, but its default branch "${branch}" did not appear within ${Math.round(readyTimeoutMs / 1000)} s. Retry later: Weldall continues with the same repository.`,
          504,
        );
      throw error;
    }
  }

  /**
   * Warns unless the default branch is protected with a required approval and without direct push
   * for the bot user. Forgejo has no organisation-wide rules; the protection comes from the
   * template, whose rules `generate` copies.
   */
  async function checkBranchRules(
    name: string,
    branch: string,
    signal: AbortSignal,
  ): Promise<GitHostWarning[]> {
    const response = await api({
      path: `${repositoryPath(name)}/branches/${branchPath(branch)}`,
      method: "GET",
      signal,
    });
    const parsed = response.status === 200 ? branchResponse.safeParse(response.json) : null;
    if (!parsed?.success)
      return [
        {
          code: "default_branch_rules_unchecked",
          message: `Weldall could not read the protection of the default branch "${branch}" of ${label(name)} (Forgejo status ${response.status}).`,
        },
      ];
    const missing = missingProtections(parsed.data);
    if (!missing.length) return [];
    return [
      {
        code: "default_branch_unprotected",
        message: `The default branch "${branch}" of ${label(name)} lacks: ${missing.join(", ")}. Weldall's git proxy never pushes to the default branch, but people with write access in Forgejo can. Add a branch protection rule for the default branch to every template repository (with "apply to administrators"); Forgejo copies it into each new repository.`,
      },
    ];
  }

  /** Fails unless the configured reviewer team can write to the repository, so its reviews count. */
  async function checkReviewerTeam(name: string, signal: AbortSignal) {
    const team = config.reviewerTeam;
    const noAccess = new GitAppError(
      "reviewer_team_access_missing",
      `The reviewer team "${team}" has no write access to ${label(name)} (or the team does not exist in ${organization}), so its reviews would not count. An owner of ${organization} must give the team write access to all repositories of the organisation (team setting "access to all repositories"), then publish again.`,
      409,
    );
    const response = await api({
      path: `${repositoryPath(name)}/teams/${segment(team)}`,
      method: "GET",
      signal,
    });
    if (response.status === 404) throw noAccess;
    if (response.status === 403)
      throw new GitAppError(
        "reviewer_team_unverifiable",
        `Weldall cannot verify that the reviewer team "${team}" has write access to ${label(name)}: Forgejo refused the bot user's token. Give the token the scope read:organization, then publish again.`,
        409,
      );
    if (response.status !== 200) throw unexpected(response);
    const parsed = teamResponse.safeParse(response.json);
    if (!parsed.success) throw protocolError();
    if (!teamCanWrite(parsed.data)) throw noAccess;
  }

  return {
    checkBranchRules,
    checkReviewerTeam,
    readRepository,
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
        throw new GitAppError("invalid_target", "The repository to resume does not match.");
      let repository = input.resume
        ? await readRepository(name, signal)
        : await generate({ template, name, description: input.description }, signal);
      if (!input.resume) {
        // `generate` answers with an empty default branch; the repository read has it.
        repository = await readRepository(repository.name, signal);
        await input.onCreated?.({
          repository: { owner: organization, name: repository.name, id: String(repository.id) },
          defaultBranch: requireDefaultBranch(repository),
          webUrl: forgejoRepositoryWebUrl(config, { owner: organization, name: repository.name }),
        });
      }
      // A retry after a failed drop finds the admin right again and lowers it then.
      repository = await dropAdminRight(repository, signal);
      const result: NewRepository = {
        repository: { owner: organization, name: repository.name, id: String(repository.id) },
        defaultBranch: requireDefaultBranch(repository),
        webUrl: forgejoRepositoryWebUrl(config, { owner: organization, name: repository.name }),
      };
      const templateCommit = await waitForDefaultBranch(
        repository.name,
        result.defaultBranch,
        signal,
      );
      const warnings = await checkBranchRules(repository.name, result.defaultBranch, signal);
      await checkReviewerTeam(repository.name, signal);
      return { ...result, templateCommit, warnings };
    },
  };
}

function requireDefaultBranch(repository: ForgejoRepository): string {
  if (!repository.default_branch) throw protocolError();
  return repository.default_branch;
}
