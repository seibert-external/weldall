import {
  LOGIN_SCOPE,
  WeldallAuthError,
  appHostAuditEventRequestSchema,
  appHostCreateAppRequestSchema,
  appHostLookupRequestSchema,
  appHostUpdateAppRequestSchema,
  type AppHostApp,
  type AppHostAuditEventRequest,
} from "@weldall/sdk";
import type { AppHostApi } from "../../src/weldall.js";

/**
 * In-process fake of Weldall's app host API, implementing the contract in
 * `packages/sdk/src/app-host.ts`: every request is validated against the SDK's request schemas
 * (with the resource added, as the real client does), registry and audit rules follow the
 * contract header, and every call is recorded. No network.
 */
export function createFakeWeldall({
  resource,
  people,
}: {
  resource: string;
  /** Weldall user id → scopes the person holds right now. */
  people: Record<string, string[]>;
}) {
  const apps = new Map<string, AppHostApp>();
  const events: Array<AppHostAuditEventRequest & { auditEventId: string }> = [];
  const calls: Array<{ method: keyof AppHostApi; input: unknown }> = [];
  /** Errors thrown by the next calls of a method, in order. */
  const failures = new Map<keyof AppHostApi, unknown[]>();
  let nextId = 1;

  const record = (method: keyof AppHostApi, input: unknown) => {
    calls.push({ method, input });
    const queued = failures.get(method);
    if (queued?.length) throw queued.shift();
  };
  const knownSubject = (subject: string) => {
    if (!(subject in people)) throw new WeldallAuthError("unknown_subject", "unknown", 404);
  };
  const invalid = (message: string) => new WeldallAuthError("invalid_request", message, 400);
  const sameRepository = (app: AppHostApp, owner: string, name: string) =>
    app.repository.owner.toLowerCase() === owner.toLowerCase() &&
    app.repository.name.toLowerCase() === name.toLowerCase();
  const withState = (app: AppHostApp): AppHostApp => ({
    ...app,
    ready: app.template === null || app.template.commit !== null,
  });

  const api: AppHostApi = {
    async createApp(input) {
      record("createApp", input);
      const parsed = appHostCreateAppRequestSchema.safeParse({ ...input, resource });
      if (!parsed.success) throw invalid(parsed.error.message);
      const body = parsed.data;
      knownSubject(body.owner);
      if (!people[body.owner]!.includes(LOGIN_SCOPE))
        throw new WeldallAuthError("access_denied", "the owner may not use Weldall", 403);
      const existing = [...apps.values()].find((app) =>
        sameRepository(app, body.repository.owner, body.repository.name),
      );
      if (existing) {
        if (
          existing.owner.id === body.owner &&
          existing.repository.owner === body.repository.owner &&
          existing.repository.name === body.repository.name
        )
          return { created: false, app: existing };
        throw new WeldallAuthError("app_exists", "another app", 409);
      }
      const id = `app${String(nextId++).padStart(4, "0")}`;
      const app = withState({
        id,
        name: body.name,
        purpose: body.purpose,
        owner: { id: body.owner },
        resource: "git-app",
        repository: body.repository,
        defaultBranch: body.defaultBranch,
        template: body.template,
        ready: false,
        links: { preview: null, live: null },
        createdAt: new Date().toISOString(),
        confirmedAt: null,
        expiresAt: new Date(Date.now() + 180 * 86_400_000).toISOString(),
        state: "active",
      });
      apps.set(id, app);
      return { created: true, app };
    },
    async updateApp(appId, input) {
      record("updateApp", { appId, ...input });
      const parsed = appHostUpdateAppRequestSchema.safeParse({ ...input, resource });
      if (!parsed.success) throw invalid(parsed.error.message);
      const app = apps.get(appId);
      if (!app) throw new WeldallAuthError("not_found", "no app", 404);
      const body = parsed.data;
      if (body.templateCommit !== undefined) {
        if (!app.template) throw invalid("the app did not start from a template");
        if (app.template.commit !== null && app.template.commit !== body.templateCommit)
          throw new WeldallAuthError("template_commit_mismatch", "set", 409);
      }
      const updated = withState({
        ...app,
        repository: { ...app.repository, ...defined(body.repository) },
        defaultBranch: body.defaultBranch ?? app.defaultBranch,
        template:
          app.template && body.templateCommit !== undefined
            ? { ...app.template, commit: body.templateCommit }
            : app.template,
        links: { ...app.links, ...defined(body.links) },
      });
      apps.set(appId, updated);
      return updated;
    },
    async lookupApp(input) {
      record("lookupApp", input);
      const parsed = appHostLookupRequestSchema.safeParse({ ...input, resource });
      if (!parsed.success) throw invalid(parsed.error.message);
      const { app: by, subject } = parsed.data;
      if (subject !== undefined) knownSubject(subject);
      const app =
        "id" in by
          ? apps.get(by.id)
          : [...apps.values()].find((candidate) =>
              sameRepository(candidate, by.repositoryOwner, by.repositoryName),
            );
      if (!app) throw new WeldallAuthError("not_found", "no app", 404);
      return { app, ownedBySubject: subject === undefined ? null : app.owner.id === subject };
    },
    async reportAuditEvent(input) {
      record("reportAuditEvent", input);
      const parsed = appHostAuditEventRequestSchema.safeParse({ ...input, resource });
      if (!parsed.success) throw invalid(parsed.error.message);
      const report = parsed.data;
      const duplicate = events.find(({ eventId }) => eventId === report.eventId);
      if (duplicate) {
        const { auditEventId, ...stored } = duplicate;
        if (JSON.stringify(stored) !== JSON.stringify(report))
          throw new WeldallAuthError("event_id_conflict", "conflict", 409);
        return {
          accepted: true,
          eventId: report.eventId,
          auditEventId,
          duplicate: true,
          recordedAt: new Date().toISOString(),
        };
      }
      if (report.subject !== null) knownSubject(report.subject);
      if ("appId" in report && report.appId !== null) {
        const app = apps.get(report.appId);
        if (!app) throw new WeldallAuthError("not_found", "no app", 404);
        if (!("reason" in report) && app.owner.id !== report.subject)
          throw new WeldallAuthError("subject_not_owner", "not the owner", 403);
      }
      const auditEventId = `audit-${events.length + 1}`;
      events.push({ ...report, auditEventId });
      return {
        accepted: true,
        eventId: report.eventId,
        auditEventId,
        duplicate: false,
        recordedAt: new Date().toISOString(),
      };
    },
    async checkSubjectScopes(subject, scopes) {
      record("checkSubjectScopes", { subject, scopes });
      // As `apps/weldall/src/server/oauth/subject-scopes-api.ts`: an unknown user is 404 not_found.
      if (!(subject in people))
        throw new WeldallAuthError("not_found", "subject was not found", 404);
      const held = people[subject]!;
      return {
        granted: scopes.filter((scope) => held.includes(scope)).sort(),
        missing: scopes.filter((scope) => !held.includes(scope)).sort(),
        evaluatedAt: new Date().toISOString(),
      };
    },
  };

  return {
    api,
    apps,
    events,
    calls,
    /** Makes the next calls of `method` throw `errors`, in order. */
    fail(method: keyof AppHostApi, ...errors: unknown[]) {
      failures.set(method, [...(failures.get(method) ?? []), ...errors]);
    },
    callsOf: (method: keyof AppHostApi) =>
      calls.filter((call) => call.method === method).map(({ input }) => input),
  };
}
/** The entries of a partial update that are set; omitted fields stay. */
function defined<T extends object>(value: T | undefined) {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined),
  ) as { [K in keyof T]-?: Exclude<T[K], undefined> };
}

export type FakeWeldall = ReturnType<typeof createFakeWeldall>;
