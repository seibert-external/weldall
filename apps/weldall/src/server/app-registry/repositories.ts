import { db, type App } from "@weldall/db";
import {
  assertConnectorAccess,
  canAccessConnector,
  connectorScopeInclude,
} from "../connectors/access";
import { ConnectorError, type AuthorizedConnectorActor } from "../connectors/contracts";
import { openGitHost } from "../connectors/core/git-hosts";
import type { GitHostWarning, GitRepositoryRef } from "../connectors/git-host";
import { writeGitRepositoryAudit } from "../connectors/git-audit";
import { connectorProviders } from "../connectors/registry";
import { WELDALL_ISSUER } from "../oauth/constants";
import {
  createApp,
  findAppByRepository,
  isAppRepositoryReady,
  markAppRepositoryReady,
} from "./service";

export interface CreateAppRepositoryInput {
  /** Git host connector key; may be omitted when exactly one is available to the caller. */
  connector?: string | undefined;
  template: string;
  /** App name; the repository is named with the connector's prefix plus this name. */
  name: string;
  purpose: string;
}

export interface AppRepositoryResult {
  /** False when an earlier attempt of the same owner had already created the repository. */
  created: boolean;
  app: { id: string; name: string; purpose: string; expiresAt: string };
  connector: string;
  repository: {
    owner: string;
    name: string;
    id: string | null;
    webUrl: string;
    defaultBranch: string;
  };
  template: { name: string; commit: string };
  /** Where git reaches the repository through Weldall's git proxy (step 3c). */
  git: { remotePath: string; remoteUrl: string };
  warnings: GitHostWarning[];
}

/**
 * Path the git proxy serves for an app's repository. The connector key keeps repositories of
 * different Git hosts apart.
 */
export function appGitRemotePath(connectorKey: string, repository: GitRepositoryRef): string {
  return `/git/${[connectorKey, repository.owner, `${repository.name}.git`].map(encodeURIComponent).join("/")}`;
}

/** Codes that reject the caller's request rather than report a failure of Weldall or the host. */
const deniedCodes = new Set([
  "invalid_name",
  "unknown_template",
  "not_found",
  "connection_denied",
  "disabled",
  "connector_ambiguous",
  "app_exists",
  "repository_exists",
  "reviewer_team_access_missing",
  "reviewer_team_unverifiable",
]);

async function resolveConnector(actor: AuthorizedConnectorActor, key: string | undefined) {
  const gitHostTypes = connectorProviders
    .filter((provider) => provider.gitHost)
    .map(({ type }) => type);
  const candidates = await db.connector.findMany({
    where: { providerType: { in: gitHostTypes }, ...(key ? { key } : { enabled: true }) },
    include: connectorScopeInclude,
    orderBy: { key: "asc" },
  });
  if (key) {
    const connector = candidates[0];
    if (!connector) throw new ConnectorError("not_found", "Git host connector not found.", 404);
    assertConnectorAccess({ connector, actor });
    if (!connector.enabled) throw new ConnectorError("disabled", "Connector is disabled.", 409);
    return connector;
  }
  const available = candidates.filter((connector) => canAccessConnector({ connector, actor }));
  if (available.length === 1) return available[0]!;
  throw available.length
    ? new ConnectorError(
        "connector_ambiguous",
        `Several Git host connectors are available. Name one: ${available.map(({ key: candidate }) => candidate).join(", ")}.`,
        409,
      )
    : new ConnectorError("not_found", "No Git host connector is available to you.", 404);
}

/**
 * Creates the repository for a new app from a configured template and registers the app for its
 * caller. Idempotent per owner: the registry entry is written as soon as the host confirms the
 * private repository, so a call after a timeout or a failed prerequisite check resumes with the
 * same repository instead of creating a second one. Another owner's app of the same name is a
 * conflict.
 */
export async function createAppRepository({
  actor,
  input,
  signal,
}: {
  actor: AuthorizedConnectorActor;
  input: CreateAppRepositoryInput;
  signal: AbortSignal;
}): Promise<AppRepositoryResult> {
  let connectorId: string | null = null;
  let repository: GitRepositoryRef | null = null;
  // Set once the registry entry exists, also from inside the host's `onCreated` callback.
  const registry: { app: App | null } = { app: null };
  try {
    if (actor.type === "machine")
      throw new ConnectorError(
        "connection_denied",
        "Apps are owned by people; sign in as a user.",
        403,
      );
    const connector = await resolveConnector(actor, input.connector);
    connectorId = connector.id;
    const host = await openGitHost({ connectorId });
    repository = host.resolveNewRepository(input);
    const target = { connectorId, ...repository };
    registry.app = await findAppByRepository(target);
    assertResumable(registry.app, actor, input, repository);
    const request = { template: input.template, name: input.name, description: input.purpose };
    let created = !registry.app;
    let result;
    try {
      result = await host.createRepository(
        {
          ...request,
          ...(registry.app ? { resume: repository } : {}),
          onCreated: async (newRepository) => {
            registry.app = await createApp({
              name: input.name.trim().toLowerCase(),
              purpose: input.purpose,
              ownerId: actor.id,
              repository: { connectorId: connector.id, ...newRepository.repository },
              defaultBranch: newRepository.defaultBranch,
              // Not ready until every check passed (`isAppRepositoryReady`).
              template: { name: input.template, commit: null },
            });
          },
        },
        signal,
      );
    } catch (error) {
      // A concurrent first call of the same owner created the repository in the meantime.
      if (!(error instanceof ConnectorError && error.code === "repository_exists") || registry.app)
        throw error;
      registry.app = await findAppByRepository(target);
      if (!registry.app)
        throw new ConnectorError(
          "repository_exists",
          `A repository named ${repository.owner}/${repository.name} already exists on the Git host but is not registered in Weldall. It may be an empty leftover of a failed creation. Choose another app name, or ask an administrator to check the repository and delete it if it is empty.`,
          409,
        );
      assertResumable(registry.app, actor, input, repository);
      created = false;
      result = await host.createRepository({ ...request, resume: repository }, signal);
    }
    if (!registry.app)
      throw new ConnectorError(
        "internal_error",
        "The Git host did not report the new repository.",
        500,
      );
    const app = isAppRepositoryReady(registry.app)
      ? registry.app
      : await markAppRepositoryReady(registry.app.id, result.templateCommit);
    const templateCommit = app.templateCommit ?? result.templateCommit;
    await writeGitRepositoryAudit({
      actor,
      outcome: "success",
      connectorId: connector.id,
      appId: app.id,
      repository: result.repository,
      repositoryId: result.repository.id,
      template: input.template,
      templateCommit,
      defaultBranch: app.defaultBranch,
      existingRepository: !created,
      warnings: result.warnings.map(({ code }) => code),
    });
    const remotePath = appGitRemotePath(connector.key, result.repository);
    return {
      created,
      app: {
        id: app.id,
        name: app.name,
        purpose: app.purpose,
        expiresAt: app.expiresAt.toISOString(),
      },
      connector: connector.key,
      repository: {
        owner: result.repository.owner,
        name: result.repository.name,
        id: result.repository.id,
        webUrl: result.webUrl,
        defaultBranch: app.defaultBranch,
      },
      template: { name: input.template, commit: templateCommit },
      git: { remotePath, remoteUrl: `${WELDALL_ISSUER}${remotePath}` },
      warnings: result.warnings,
    };
  } catch (error) {
    const known = error instanceof ConnectorError;
    await writeGitRepositoryAudit({
      actor,
      outcome: known && deniedCodes.has(error.code) ? "denied" : "failed",
      ...(known && error.code === "connection_denied"
        ? { reasonCode: "scope_not_granted" as const }
        : {}),
      reason: known ? error.message : "Creating the repository failed unexpectedly.",
      connectorId,
      // Another owner's app is not linked to this caller's rejection.
      appId: registry.app?.ownerId === actor.id ? registry.app.id : null,
      repository,
      template: input.template,
    });
    throw error;
  }
}

/** Only the same owner may resume, and only with the template the app started from. */
function assertResumable(
  app: App | null,
  actor: AuthorizedConnectorActor,
  input: CreateAppRepositoryInput,
  repository: GitRepositoryRef,
) {
  if (!app) return;
  if (app.ownerId !== actor.id)
    throw new ConnectorError(
      "app_exists",
      `The app name is taken: ${repository.owner}/${repository.name} belongs to another person's app. Choose another name.`,
      409,
    );
  if (app.template !== input.template)
    throw new ConnectorError(
      "app_exists",
      `Your app ${repository.owner}/${repository.name} was created from ${app.template ? `template "${app.template}"` : "an existing repository"}, not "${input.template}".`,
      409,
    );
}
