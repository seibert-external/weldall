import { db, LOGIN_SCOPE_KEY, type App, type Prisma } from "@weldall/db";
import {
  appHostCreateAppRequestSchema,
  appHostLookupRequestSchema,
  appHostUpdateAppRequestSchema,
  WeldallAuthError,
  type AppHostApp,
} from "@weldall/sdk";
import { createApp, isAppRepositoryReady } from "../app-registry/service";
import { appState } from "../app-registry/state";
import { safeHttpsUrl } from "../app-registry/links";
import { loggedOauthErrorResponse } from "../oauth/error-response";
import { hasEffectiveSystemScopeFor } from "../policy/resources";
import {
  appHostRequestBody,
  appHostResource,
  appHostSubject,
  authenticateAppHost,
  isUniqueViolation,
  noStore,
  type AppHostResource,
} from "./caller";

/**
 * App registry endpoints for a Git app (see `caller.ts` for authentication and the resource
 * binding). The Git app creates the entry for a person, keeps its repository and links current
 * and asks whom an app belongs to. Expiry and confirmation stay the owner's: nothing here moves
 * them.
 */

const appIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

export function presentHostApp(app: App, resource: { key: string }, now = new Date()): AppHostApp {
  return {
    id: app.id,
    name: app.name,
    purpose: app.purpose,
    owner: { id: app.ownerId },
    resource: resource.key,
    repository: {
      owner: app.repositoryOwner,
      name: app.repositoryName,
      id: app.repositoryId,
      webUrl: safeHttpsUrl(app.repositoryWebUrl),
    },
    defaultBranch: app.defaultBranch,
    template: app.template === null ? null : { name: app.template, commit: app.templateCommit },
    ready: isAppRepositoryReady(app),
    links: { preview: safeHttpsUrl(app.previewUrl), live: safeHttpsUrl(app.liveUrl) },
    createdAt: app.createdAt.toISOString(),
    confirmedAt: app.confirmedAt?.toISOString() ?? null,
    expiresAt: app.expiresAt.toISOString(),
    state: appState(app.expiresAt, now),
  };
}

const notFound = () =>
  new WeldallAuthError("not_found", "no app of this resource has this id", 404);

/**
 * The resource's apps whose repository matches case-insensitively, as Git hosts compare names.
 * Lower-cased equality, never `ILIKE`, so `_` and `%` stay literal.
 */
async function appsByRepository(
  resource: AppHostResource,
  repository: { owner: string; name: string },
  client: Prisma.TransactionClient | typeof db = db,
  exceptId?: string,
) {
  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "App"
    WHERE "resourceId" = ${resource.id}
      AND lower("repositoryOwner") = lower(${repository.owner})
      AND lower("repositoryName") = lower(${repository.name})
      AND "id" <> ${exceptId ?? ""}
    LIMIT 2`;
  return rows.map(({ id }) => id);
}

async function resourceApp(resource: AppHostResource, id: string) {
  const app = appIdPattern.test(id)
    ? await db.app.findFirst({ where: { id, resourceId: resource.id } })
    : null;
  if (!app) throw notFound();
  return app;
}

/**
 * `POST /api/app-host/v1/apps`: registers an app for a person who exists and still holds
 * `weldall:login`. Repeating the call for the same repository and owner returns the existing entry
 * (`created: false`, `200`) without changing it; another owner's or a case-variant entry is
 * `409 app_exists`.
 */
export async function appHostCreateApp(request: Request): Promise<Response> {
  try {
    const caller = await authenticateAppHost(request);
    const body = await appHostRequestBody(request, appHostCreateAppRequestSchema);
    const resource = await appHostResource(caller, body.resource);
    const owner = await appHostSubject(body.owner);
    if (!(await hasEffectiveSystemScopeFor(owner.email, LOGIN_SCOPE_KEY)))
      throw new WeldallAuthError("access_denied", "the owner may not use Weldall", 403);
    const repository = { owner: body.repository.owner, name: body.repository.name };
    const existing = async () => {
      const ids = await appsByRepository(resource, repository);
      if (!ids.length) return null;
      const app = ids.length === 1 ? await db.app.findUnique({ where: { id: ids[0]! } }) : null;
      if (
        app?.ownerId === owner.id &&
        app.repositoryOwner === repository.owner &&
        app.repositoryName === repository.name
      )
        return app;
      throw new WeldallAuthError(
        "app_exists",
        "another app of this resource is registered for this repository",
        409,
      );
    };
    const found = await existing();
    if (found) return created(false, found, resource);
    let app: App;
    try {
      app = await createApp({
        name: body.name,
        purpose: body.purpose,
        ownerId: owner.id,
        repository: { resourceId: resource.id, ...body.repository },
        defaultBranch: body.defaultBranch,
        template: body.template,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent identical call won the race, or the repository id is taken.
      const raced = await existing();
      if (raced) return created(false, raced, resource);
      throw new WeldallAuthError(
        "app_exists",
        "another app of this resource is registered for this repository id",
        409,
      );
    }
    return created(true, app, resource);
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

function created(isNew: boolean, app: App, resource: AppHostResource) {
  return Response.json(
    { created: isNew, app: presentHostApp(app, resource) },
    { status: isNew ? 201 : 200, headers: noStore },
  );
}

/**
 * `PATCH /api/app-host/v1/apps/{id}`: links, default branch, repository rename, web link, the
 * repository id (once) and the template commit (once, which makes a template app ready).
 */
export async function appHostUpdateApp(request: Request, id: string): Promise<Response> {
  try {
    const caller = await authenticateAppHost(request);
    const body = await appHostRequestBody(request, appHostUpdateAppRequestSchema);
    const resource = await appHostResource(caller, body.resource);
    const app = await resourceApp(resource, id);
    const repository = body.repository ?? {};
    if (
      repository.id !== undefined &&
      app.repositoryId !== null &&
      app.repositoryId !== repository.id
    )
      throw new WeldallAuthError(
        "repository_id_mismatch",
        "the app's repository id is already set and cannot change",
        409,
      );
    if (body.templateCommit !== undefined) {
      if (app.template === null)
        throw new WeldallAuthError("invalid_request", "the app did not start from a template");
      if (app.templateCommit !== null && app.templateCommit !== body.templateCommit)
        throw new WeldallAuthError(
          "template_commit_mismatch",
          "the app's template commit is already set and cannot change",
          409,
        );
    }
    const renamed = {
      owner: repository.owner ?? app.repositoryOwner,
      name: repository.name ?? app.repositoryName,
    };
    if (
      (renamed.owner !== app.repositoryOwner || renamed.name !== app.repositoryName) &&
      (await appsByRepository(resource, renamed, db, app.id)).length
    )
      throw new WeldallAuthError(
        "app_exists",
        "another app of this resource is registered for this repository",
        409,
      );
    const data: Prisma.AppUpdateManyMutationInput = {
      ...(repository.owner === undefined ? {} : { repositoryOwner: repository.owner }),
      ...(repository.name === undefined ? {} : { repositoryName: repository.name }),
      ...(repository.id === undefined ? {} : { repositoryId: repository.id }),
      ...(repository.webUrl === undefined ? {} : { repositoryWebUrl: repository.webUrl }),
      ...(body.defaultBranch === undefined ? {} : { defaultBranch: body.defaultBranch }),
      ...(body.templateCommit === undefined ? {} : { templateCommit: body.templateCommit }),
      ...(body.links?.preview === undefined ? {} : { previewUrl: body.links.preview }),
      ...(body.links?.live === undefined ? {} : { liveUrl: body.links.live }),
    };
    let count: number;
    try {
      // The conditions keep the set-once fields set-once under concurrent updates.
      ({ count } = await db.app.updateMany({
        where: {
          id: app.id,
          resourceId: resource.id,
          ...(repository.id === undefined
            ? {}
            : { OR: [{ repositoryId: null }, { repositoryId: repository.id }] }),
          ...(body.templateCommit === undefined
            ? {}
            : {
                AND: [{ OR: [{ templateCommit: null }, { templateCommit: body.templateCommit }] }],
              }),
        },
        data,
      }));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new WeldallAuthError(
        "app_exists",
        "another app of this resource is registered for this repository",
        409,
      );
    }
    if (count !== 1)
      throw new WeldallAuthError("conflict", "the app changed concurrently; retry", 409);
    const updated = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    return Response.json({ app: presentHostApp(updated, resource) }, { headers: noStore });
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}

/**
 * `POST /api/app-host/v1/apps/lookup`: one app of the resource by id or by repository, and with
 * `subject` whether that person owns it. Two entries that differ only in case resolve to nothing.
 * Whether the person may still use Weldall is checked with `check-scopes` (`weldall:login`).
 */
export async function appHostLookupApp(request: Request): Promise<Response> {
  try {
    const caller = await authenticateAppHost(request);
    const body = await appHostRequestBody(request, appHostLookupRequestSchema);
    const resource = await appHostResource(caller, body.resource);
    let app: App;
    if ("id" in body.app) app = await resourceApp(resource, body.app.id);
    else {
      const ids = await appsByRepository(resource, {
        owner: body.app.repositoryOwner,
        name: body.app.repositoryName,
      });
      const found = ids.length === 1 ? await db.app.findUnique({ where: { id: ids[0]! } }) : null;
      if (!found)
        throw new WeldallAuthError(
          "not_found",
          "no app of this resource is registered for this repository",
          404,
        );
      app = found;
    }
    const subject = body.subject === undefined ? null : await appHostSubject(body.subject);
    return Response.json(
      {
        app: presentHostApp(app, resource),
        ownedBySubject: subject ? app.ownerId === subject.id : null,
      },
      { headers: noStore },
    );
  } catch (error) {
    return loggedOauthErrorResponse(error);
  }
}
