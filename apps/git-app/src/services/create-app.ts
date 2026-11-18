import type { AppHostApp } from "@weldall/sdk";
import { auditList, auditText } from "../audit.js";
import { GitAppError } from "../errors.js";
import type {
  CreatedRepository,
  GitHostWarning,
  GitRepositoryRef,
  NewRepository,
} from "../hosts/git-host.js";
import { errorForLog } from "../log.js";
import { isTransientWeldallFailure, lookupApp, weldallFailure } from "../weldall.js";
import { authorizePerson } from "../access.js";
import type { GitAppServices, Person } from "./context.js";

export interface CreateAppInput {
  template: string;
  /** App name; the repository is named with the configured prefix plus this name. */
  name: string;
  purpose: string;
}

export interface CreateAppResult {
  /** False when an earlier attempt of the same owner had already created the repository. */
  created: boolean;
  app: { id: string; name: string; purpose: string; expiresAt: string; state: AppHostApp["state"] };
  repository: {
    owner: string;
    name: string;
    id: string | null;
    webUrl: string;
    defaultBranch: string;
  };
  template: { name: string; commit: string };
  warnings: GitHostWarning[];
}

/** Codes that reject the person's request rather than report a failure of the Git app, Weldall or the host. */
const deniedCodes = new Set([
  "access_denied",
  "invalid_name",
  "unknown_template",
  "app_exists",
  "repository_exists",
  "reviewer_team_access_missing",
  "reviewer_team_unverifiable",
]);

/**
 * Creates the repository for a new app from a configured template and registers the app in
 * Weldall for the person (carried over from the server's `app-registry/repositories.ts`, with
 * Weldall's app host API in place of the database).
 *
 * Order of side effects, so that every repository that becomes usable has an audit entry:
 *
 * 1. Weldall confirms the person's permissions and that the repository name is free or theirs
 *    (no host call before Weldall answered).
 * 2. The host creates the private repository from the template.
 * 3. Right after the host confirms it, the app is registered in Weldall as not ready (template
 *    commit null), so a retry resumes with the same repository instead of creating another.
 * 4. The host waits for the default branch and checks the reviewer team and branch rules.
 * 5. `git_repository.created` is reported to Weldall. Only when Weldall stored it:
 * 6. the template commit is set, which makes the app ready (git traffic is refused until then).
 *
 * If step 5 or 6 fails, the person gets 503 and the app stays not ready; repeating the call
 * resumes and reports again (`existingRepository: true`). Step 3 is retried once on a transient
 * failure (it is idempotent for the same owner and repository). If it still fails, the repository may
 * exist on the host without a registry entry or success audit: the failure is reported as
 * `git_repository.failed` with the repository name (best effort) and logged. When Weldall did
 * register it after all (a lost answer), a repeat resumes; otherwise a repeat ends in
 * `repository_exists` and an administrator must remove the empty repository. Such a repository
 * is unusable: the git proxy serves only registered, ready apps.
 */
export async function createAppRepository({
  services,
  person,
  input,
  signal,
}: {
  services: GitAppServices;
  person: Person;
  input: CreateAppInput;
  signal: AbortSignal;
}): Promise<CreateAppResult> {
  const { host, weldall } = services;
  let repository: GitRepositoryRef | null = null;
  // Set once the registry entry is known, also from inside the host's `onCreated` callback.
  const state: { app: AppHostApp | null; unregistered: NewRepository | null } = {
    app: null,
    unregistered: null,
  };
  try {
    await authorizePerson(weldall, person.id, [services.scopes.publish]);
    repository = host.host.resolveNewRepository(input);
    const target = repository;
    state.app = await registeredApp(services, person, target, input);
    const request = { template: input.template, name: input.name, description: input.purpose };
    let created = !state.app;
    let result: CreatedRepository;
    try {
      result = await host.host.createRepository(
        {
          ...request,
          ...(state.app ? { resume: target } : {}),
          onCreated: async (newRepository) => {
            state.unregistered = newRepository;
            const register = () =>
              weldall.createApp({
                owner: person.id,
                name: input.name.trim().toLowerCase(),
                purpose: input.purpose,
                repository: {
                  owner: newRepository.repository.owner,
                  name: newRepository.repository.name,
                  id: newRepository.repository.id,
                  webUrl: newRepository.webUrl,
                },
                defaultBranch: newRepository.defaultBranch,
                // Not ready until every check passed and the audit entry is stored.
                template: { name: input.template, commit: null },
              });
            try {
              let registered;
              try {
                registered = await register();
              } catch (error) {
                // Registering is idempotent for the same owner and repository, so a lost answer
                // or an outage is retried once before the repository is left unregistered.
                if (!isTransientWeldallFailure(error)) throw error;
                registered = await register();
              }
              state.app = registered.app;
              state.unregistered = null;
            } catch (error) {
              throw new GitAppError(
                "registry_unavailable",
                `The Git host created ${label(newRepository.repository)}, but Weldall did not confirm registering it (${weldallFailure(error, "register the app").code}). Retry later: if Weldall registered it after all, the retry continues with it. If the retry reports that the repository already exists, an administrator must delete the empty repository ${label(newRepository.repository)} on the Git host.`,
                503,
              );
            }
          },
        },
        signal,
      );
    } catch (error) {
      // A concurrent first call of the same owner created the repository in the meantime.
      if (!(error instanceof GitAppError && error.code === "repository_exists") || state.app)
        throw error;
      state.app = await registeredApp(services, person, target, input);
      if (!state.app)
        throw new GitAppError(
          "repository_exists",
          `A repository named ${label(target)} already exists on the Git host but is not registered in Weldall. It may be an empty leftover of a failed creation. Choose another app name, or ask an administrator to check the repository and delete it if it is empty.`,
          409,
        );
      created = false;
      result = await host.host.createRepository({ ...request, resume: target }, signal);
    }
    const app = state.app;
    if (!app)
      throw new GitAppError(
        "internal_error",
        "The Git host did not report the new repository.",
        500,
      );
    const templateCommit = app.template?.commit ?? result.templateCommit;
    await services.audit.success({
      eventType: "git_repository.created",
      subject: person.id,
      appId: app.id,
      details: {
        repositoryId: result.repository.id,
        template: input.template,
        templateCommit,
        defaultBranch: app.defaultBranch,
        existingRepository: !created,
        warnings: auditList(
          result.warnings.map(({ code }) => code),
          "warnings",
        ),
      },
    });
    let ready = app;
    if (!app.ready)
      try {
        ready = await weldall.updateApp(app.id, { templateCommit: result.templateCommit });
      } catch (error) {
        throw weldallFailure(error, "mark the app as ready");
      }
    return {
      created,
      app: {
        id: ready.id,
        name: ready.name,
        purpose: ready.purpose,
        expiresAt: ready.expiresAt,
        state: ready.state,
      },
      repository: {
        owner: result.repository.owner,
        name: result.repository.name,
        id: result.repository.id,
        webUrl: result.webUrl,
        defaultBranch: ready.defaultBranch,
      },
      template: { name: input.template, commit: ready.template?.commit ?? templateCommit },
      warnings: result.warnings,
    };
  } catch (error) {
    const known = error instanceof GitAppError;
    if (state.unregistered)
      services.log("error", "repository created on the Git host but not registered in Weldall", {
        repository: label(state.unregistered.repository),
        subject: person.id,
        ...errorForLog(error),
      });
    const audited = !(known && error.code === "audit_unavailable");
    if (audited)
      await services.audit.rejection({
        eventType:
          known && deniedCodes.has(error.code) ? "git_repository.denied" : "git_repository.failed",
        ...(known && error.code === "access_denied"
          ? { reasonCode: "scope_not_granted" as const }
          : {}),
        reason: known ? error.message : "Creating the repository failed unexpectedly.",
        subject: person.id,
        // Another owner's app is never linked to this person's rejection.
        appId: state.app?.owner.id === person.id ? state.app.id : null,
        repository: state.app?.owner.id === person.id ? null : repository,
        details: { template: input.template ? auditText(input.template) : null },
      });
    throw error;
  }
}

const label = (repository: GitRepositoryRef) => `${repository.owner}/${repository.name}`;

/**
 * The person's registry entry for `repository`, or null when none exists. Another person's entry
 * and an entry from another template are refused: only the same owner resumes, and only with the
 * template the app started from.
 */
async function registeredApp(
  services: GitAppServices,
  person: Person,
  repository: GitRepositoryRef,
  input: CreateAppInput,
): Promise<AppHostApp | null> {
  const found = await lookupApp(services.weldall, {
    app: { repositoryOwner: repository.owner, repositoryName: repository.name },
    subject: person.id,
  });
  if (!found) return null;
  if (found.ownedBySubject !== true)
    throw new GitAppError(
      "app_exists",
      `The app name is taken: ${label(repository)} belongs to another person's app. Choose another name.`,
      409,
    );
  if (found.app.template?.name !== input.template)
    throw new GitAppError(
      "app_exists",
      `Your app ${label(repository)} was created from ${found.app.template ? `template "${found.app.template.name}"` : "an existing repository"}, not "${input.template}".`,
      409,
    );
  return found.app;
}
