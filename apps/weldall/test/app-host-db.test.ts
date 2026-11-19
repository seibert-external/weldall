import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  APP_HOST_SCOPE_KEY,
  db,
  ensureSystemScopes,
  SUBJECT_SCOPES_CHECK_SCOPE_KEY,
} from "@weldall/db";
import {
  createDpopProof,
  createWeldallAppHostClient,
  generateEs256KeyPair,
  requestMachineToken,
  WeldallAuthError,
  type DpopKeyPair,
  type WeldallAppHostClient,
} from "@weldall/sdk";

vi.mock("../src/server/auth/auth.js", () => ({
  auth: { handler: vi.fn(async () => new Response(null, { status: 500 })) },
}));
import { appHostCreateApp, appHostLookupApp, appHostUpdateApp } from "../src/server/app-host/apps";
import { appHostReportAuditEvent } from "../src/server/app-host/audit";
import { listAppsForMachine, listOwnApps } from "../src/server/app-registry/registry";
import { createApp } from "../src/server/app-registry/service";
import { WELDALL_ISSUER, WELDALL_RESOURCE } from "../src/server/oauth/constants";
import { subjectScopesCheck } from "../src/server/oauth/subject-scopes-api";

const target = "postgresql://postgres@localhost:5433/postgres";
// Use the operator-approved local database or CI's existing disposable test service; never reset either here.
const approvedTarget =
  process.env.POSTGRES_URL === target ||
  /^postgresql:\/\/postgres@localhost:5433\/weldall_connector_test_[a-f0-9]{32}$/.test(
    process.env.POSTGRES_URL ?? "",
  ) ||
  (process.env.CI === "true" &&
    process.env.POSTGRES_URL === "postgresql://postgres:postgres@localhost:5432/postgres");
const prefix = `apphost-${randomUUID()}`;
const person = (name: string) => ({
  id: `${prefix}-${name}`,
  email: `${prefix}-${name}@example.com`,
  name: `${name} ${prefix}`,
});
const alice = person("alice");
const bob = person("bob");
/** Exists but may not use Weldall (no `weldall:login`). */
const carol = person("carol");
const gitResource = `https://git-${prefix}.example.com/api`;
const otherResource = `https://other-${prefix}.example.com/api`;
const gitAppClientId = `${prefix}-git-app`;
const outsiderClientId = `${prefix}-outsider`;
let gitAppKey: DpopKeyPair;
let outsiderKey: DpopKeyPair;
let gitResourceId: string;
let otherResourceId: string;
let client: WeldallAppHostClient;
let outsider: WeldallAppHostClient;
const commit = (digit: string) => digit.repeat(40);

/** Routes the SDK client's requests to the route handlers, as Next.js would. */
async function weldallFetch(input: string | URL | Request, init?: RequestInit) {
  const request = input instanceof Request ? input : new Request(input, init);
  const path = new URL(request.url).pathname;
  if (path === "/api/auth/oauth2/token") {
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    return tokenFacade(request);
  }
  if (path === "/api/app-host/v1/apps") return appHostCreateApp(request);
  if (path === "/api/app-host/v1/apps/lookup") return appHostLookupApp(request);
  if (path === "/api/app-host/v1/audit-events") return appHostReportAuditEvent(request);
  if (path === "/api/authorization/v1/check-scopes") return subjectScopesCheck(request);
  const update = /^\/api\/app-host\/v1\/apps\/([^/]+)$/.exec(path);
  if (update) return appHostUpdateApp(request, decodeURIComponent(update[1]!));
  return new Response(null, { status: 404 });
}

/** A raw request, for bodies the SDK's types would not allow. */
async function raw(
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  method = "POST",
) {
  const token = (
    await requestMachineToken({
      issuer: WELDALL_ISSUER,
      clientId: gitAppClientId,
      resource: WELDALL_RESOURCE,
      scopes: [APP_HOST_SCOPE_KEY],
      kid: "current",
      key: gitAppKey,
      fetch: weldallFetch,
    })
  ).accessToken;
  const url = `${WELDALL_ISSUER}${path}`;
  const proof = await createDpopProof({ ...gitAppKey, method, url, accessToken: token });
  const response = await handler(
    new Request(url, {
      method,
      headers: { authorization: `DPoP ${token}`, dpop: proof, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, json: (await response.json()) as any };
}

const rejected = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => {
      if (!(error instanceof WeldallAuthError)) throw error;
      return { code: error.code, status: error.status };
    },
  );

const newApp = (name: string, owner = alice.id) => ({
  owner,
  name,
  purpose: `${name} purpose`,
  repository: {
    owner: "acme-apps",
    name: `${prefix}-${name}`,
    id: null,
    webUrl: `https://git.example.com/acme-apps/${prefix}-${name}`,
  },
  defaultBranch: "main",
  template: { name: "react", commit: null },
});

describe.skipIf(!approvedTarget)(
  "app host API for a Git app on explicitly selected disposable PostgreSQL",
  () => {
    beforeAll(async () => {
      if (!approvedTarget) throw new Error("Unsafe database target");
      const issuerKey = await generateEs256KeyPair();
      [gitAppKey, outsiderKey] = await Promise.all([
        generateEs256KeyPair(),
        generateEs256KeyPair(),
      ]);
      Object.assign(process.env, {
        WELDALL_SIGNING_PRIVATE_JWK: JSON.stringify(issuerKey.privateJwk),
        WELDALL_SIGNING_PUBLIC_JWK: JSON.stringify(issuerKey.publicJwk),
        WELDALL_SIGNING_KID: `${prefix}-signing`,
      });
      await ensureSystemScopes(db, prefix);
      const scope = (key: string) => db.scope.findUniqueOrThrow({ where: { key } });
      const [login, appHost, subjectCheck] = await Promise.all([
        scope("weldall:login"),
        scope(APP_HOST_SCOPE_KEY),
        scope(SUBJECT_SCOPES_CHECK_SCOPE_KEY),
      ]);
      for (const [user, scopes] of [
        [alice, [login]],
        [bob, [login]],
        [carol, []],
      ] as const) {
        await db.user.create({
          data: { id: user.id, email: user.email, name: user.name, emailVerified: true },
        });
        if (scopes.length)
          await db.emailScopeAssignment.create({
            data: {
              normalizedEmail: user.email,
              createdBy: prefix,
              updatedBy: prefix,
              grants: { create: scopes.map(({ id }) => ({ scopeId: id, createdBy: prefix })) },
            },
          });
      }
      const resource = (key: string, identifier: string) =>
        db.downstreamResource.create({
          data: {
            key,
            name: key,
            resourceIdentifier: identifier,
            authorizationServer: WELDALL_ISSUER,
            downstreamClientId: key,
            createdBy: prefix,
            updatedBy: prefix,
          },
        });
      gitResourceId = (await resource(`${prefix}-git`, gitResource)).id;
      otherResourceId = (await resource(`${prefix}-other`, otherResource)).id;
      const { createMachineClient } = await import("../src/server/machines/service.js");
      for (const [clientId, key, resourceIds] of [
        [gitAppClientId, gitAppKey, [gitResourceId]],
        [outsiderClientId, outsiderKey, [otherResourceId]],
      ] as const)
        await createMachineClient(
          {
            clientId,
            name: clientId,
            key: { kid: "current", publicJwk: key.publicJwk },
            access: { resourceIds: [...resourceIds], scopeIds: [appHost.id, subjectCheck.id] },
          },
          { id: prefix, requestId: `${prefix}-machine` },
        );
      const options = { issuer: WELDALL_ISSUER, kid: "current", fetch: weldallFetch };
      client = createWeldallAppHostClient({
        ...options,
        clientId: gitAppClientId,
        key: gitAppKey,
        resource: gitResource,
      });
      // Allowed for another resource only, but naming the Git app's resource.
      outsider = createWeldallAppHostClient({
        ...options,
        clientId: outsiderClientId,
        key: outsiderKey,
        resource: gitResource,
      });
    });

    afterAll(async () => {
      if (!approvedTarget) return;
      await db.app.deleteMany({ where: { ownerId: { startsWith: prefix } } });
      await db.machineClient.deleteMany({ where: { clientId: { startsWith: prefix } } });
      await db.downstreamResource.deleteMany({ where: { key: { startsWith: prefix } } });
      await db.emailScopeAssignment.deleteMany({
        where: { normalizedEmail: { startsWith: prefix } },
      });
      await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
      await db.auditEvent.deleteMany({
        where: {
          OR: [
            { actorId: { startsWith: prefix } },
            { clientId: { startsWith: prefix } },
            { deduplicationKey: { startsWith: `app-host:${gitResourceId}:` } },
          ],
        },
      });
    });

    it("registers an app for a person, idempotently per owner and repository", async () => {
      const first = await client.createApp(newApp("tracker"));
      expect(first.created).toBe(true);
      expect(first.app).toMatchObject({
        name: "tracker",
        owner: { id: alice.id },
        resource: `${prefix}-git`,
        repository: { owner: "acme-apps", name: `${prefix}-tracker`, id: null },
        template: { name: "react", commit: null },
        ready: false,
        links: { preview: null, live: null },
        confirmedAt: null,
        state: "active",
      });
      const again = await client.createApp(newApp("tracker"));
      expect(again).toEqual({ ...first, created: false });
      expect(await rejected(client.createApp(newApp("tracker", bob.id)))).toEqual({
        code: "app_exists",
        status: 409,
      });
      // A case variant of a registered repository is the same repository on the host.
      const variant = newApp("tracker");
      variant.repository.name = variant.repository.name.toUpperCase();
      expect(await rejected(client.createApp(variant))).toEqual({
        code: "app_exists",
        status: 409,
      });
    });

    it("registers only for people who exist and may use Weldall", async () => {
      expect(await rejected(client.createApp(newApp("ghost", `${prefix}-nobody`)))).toEqual({
        code: "unknown_subject",
        status: 404,
      });
      expect(await rejected(client.createApp(newApp("carols", carol.id)))).toEqual({
        code: "access_denied",
        status: 403,
      });
      expect(await db.app.count({ where: { name: { in: ["ghost", "carols"] } } })).toBe(0);
    });

    it("refuses a machine client that is not allowed for the named resource", async () => {
      expect(await rejected(outsider.createApp(newApp("intruder")))).toEqual({
        code: "invalid_target",
        status: 403,
      });
      const { app } = await client.lookupApp({
        app: { repositoryOwner: "acme-apps", repositoryName: `${prefix}-tracker` },
      });
      expect(await rejected(outsider.lookupApp({ app: { id: app.id } }))).toEqual({
        code: "invalid_target",
        status: 403,
      });
      expect(
        await rejected(outsider.updateApp(app.id, { links: { live: "https://x.example.com/" } })),
      ).toEqual({ code: "invalid_target", status: 403 });
    });

    it("updates links, repository and template commit; set-once fields stay set", async () => {
      const { app } = await client.createApp(newApp("linked"));
      const updated = await client.updateApp(app.id, {
        links: { preview: "https://preview.example.com/1", live: "https://live.example.com/" },
        repository: { id: "R_1", name: `${prefix}-linked-renamed` },
        templateCommit: commit("b"),
      });
      expect(updated).toMatchObject({
        repository: { owner: "acme-apps", name: `${prefix}-linked-renamed`, id: "R_1" },
        template: { name: "react", commit: commit("b") },
        ready: true,
        links: { preview: "https://preview.example.com/1", live: "https://live.example.com/" },
        expiresAt: app.expiresAt,
      });
      expect(await rejected(client.updateApp(app.id, { repository: { id: "R_2" } }))).toEqual({
        code: "repository_id_mismatch",
        status: 409,
      });
      expect(await rejected(client.updateApp(app.id, { templateCommit: commit("c") }))).toEqual({
        code: "template_commit_mismatch",
        status: 409,
      });
      // Renaming onto another registered repository is refused.
      expect(
        await rejected(client.updateApp(app.id, { repository: { name: `${prefix}-tracker` } })),
      ).toEqual({ code: "app_exists", status: 409 });
      const cleared = await client.updateApp(app.id, { links: { preview: null } });
      expect(cleared.links).toEqual({ preview: null, live: "https://live.example.com/" });

      for (const body of [
        { resource: gitResource },
        { resource: gitResource, links: { live: "http://insecure.example.com/" } },
        { resource: gitResource, links: { live: "https://user:secret@example.com/" } },
        { resource: gitResource, expiresAt: "2099-01-01T00:00:00.000Z" },
      ])
        expect(
          await raw(
            (request) => appHostUpdateApp(request, app.id),
            `/api/app-host/v1/apps/${app.id}`,
            body,
            "PATCH",
          ),
        ).toMatchObject({ status: 400, json: { error: "invalid_request" } });
    });

    it("resolves an app by id or repository and answers whom it belongs to", async () => {
      const byRepository = await client.lookupApp({
        app: { repositoryOwner: "ACME-APPS", repositoryName: `${prefix}-TRACKER` },
        subject: alice.id,
      });
      expect(byRepository).toMatchObject({
        app: { name: "tracker", owner: { id: alice.id } },
        ownedBySubject: true,
      });
      const byId = await client.lookupApp({
        app: { id: byRepository.app.id },
        subject: bob.id,
      });
      expect(byId.ownedBySubject).toBe(false);
      expect((await client.lookupApp({ app: { id: byRepository.app.id } })).ownedBySubject).toBe(
        null,
      );
      expect(
        await rejected(client.lookupApp({ app: { id: byRepository.app.id }, subject: "nobody" })),
      ).toEqual({ code: "unknown_subject", status: 404 });
      expect(
        await rejected(client.lookupApp({ app: { id: "c0000000000000000000000000" } })),
      ).toEqual({ code: "not_found", status: 404 });
      // An app of another resource does not exist for this Git app.
      const foreign = await createApp({
        name: "foreign",
        purpose: "foreign",
        ownerId: alice.id,
        repository: { resourceId: otherResourceId, owner: "acme-apps", name: `${prefix}-foreign` },
        defaultBranch: "main",
      });
      expect(await rejected(client.lookupApp({ app: { id: foreign.id } }))).toEqual({
        code: "not_found",
        status: 404,
      });
      expect(
        await rejected(client.updateApp(foreign.id, { links: { live: "https://x.example.com/" } })),
      ).toEqual({ code: "not_found", status: 404 });
    });

    it("shows resource apps in the registry views", async () => {
      const own = await listOwnApps({ id: alice.id, requestId: prefix } as never);
      const tracker = own.apps.find(({ name }) => name === "tracker")!;
      expect(tracker.repository).toEqual({
        resource: `${prefix}-git`,
        owner: "acme-apps",
        name: `${prefix}-tracker`,
        webUrl: `https://git.example.com/acme-apps/${prefix}-tracker`,
      });
      const machine = await listAppsForMachine({ limit: 200 });
      expect(machine.apps.map(({ id }) => id)).toContain(tracker.id);
    });

    it("records a reported push as the person's, once, and confirms acceptance", async () => {
      const { app } = await client.lookupApp({
        app: { repositoryOwner: "acme-apps", repositoryName: `${prefix}-tracker` },
      });
      const eventId = randomUUID();
      const report = {
        eventId,
        eventType: "git_push.forwarded" as const,
        subject: alice.id,
        appId: app.id,
        details: {
          refUpdates: [
            { ref: "refs/heads/weldall/publish-1", oldCommit: commit("0"), newCommit: commit("a") },
          ],
          refUpdateCount: 1,
          credentialId: "cred-1",
        },
      };
      const accepted = await client.reportAuditEvent(report);
      expect(accepted).toMatchObject({ accepted: true, eventId, duplicate: false });
      const stored = await db.auditEvent.findUniqueOrThrow({
        where: { id: accepted.auditEventId },
      });
      expect(stored).toMatchObject({
        eventType: "git_push.forwarded",
        actorType: "user",
        actorId: alice.id,
        actorEmail: alice.email,
        clientId: gitAppClientId,
        outcome: "success",
        subjectType: "app",
        subjectId: app.id,
        deduplicationKey: `app-host:${gitResourceId}:${eventId}`,
        metadata: {
          resourceId: gitResourceId,
          appId: app.id,
          repositoryOwner: "acme-apps",
          repositoryName: `${prefix}-tracker`,
          refUpdates: report.details.refUpdates,
          refUpdateCount: 1,
          credentialId: "cred-1",
        },
      });

      const retried = await client.reportAuditEvent(report);
      expect(retried).toEqual({ ...accepted, duplicate: true });
      expect(
        await db.auditEvent.count({ where: { deduplicationKey: stored.deduplicationKey } }),
      ).toBe(1);
      expect(
        await rejected(
          client.reportAuditEvent({
            ...report,
            details: { ...report.details, credentialId: "cred-2" },
          }),
        ),
      ).toEqual({ code: "event_id_conflict", status: 409 });
    });

    it("redacts credentials in reported text and records the machine when no person is known", async () => {
      const accepted = await client.reportAuditEvent({
        eventId: randomUUID(),
        eventType: "git_push.denied",
        subject: null,
        appId: null,
        repository: { owner: "acme-apps", name: "unknown-repo" },
        reason: `Rejected credential ghp_${"a".repeat(36)} for Authorization: Basic dXNlcjpzZWNyZXQ=`,
        details: {
          refUpdates: [],
          refUpdateCount: 0,
          credentialId: null,
          requestBytes: null,
          responseBytes: null,
          durationMs: null,
          upstreamStatus: null,
        },
      });
      const stored = await db.auditEvent.findUniqueOrThrow({
        where: { id: accepted.auditEventId },
      });
      expect(stored).toMatchObject({
        eventType: "git_push.denied",
        actorType: "machine",
        actorId: gitAppClientId,
        clientId: gitAppClientId,
        outcome: "denied",
        reasonCode: "invalid_request",
        subjectType: "resource",
        subjectId: gitResourceId,
        metadata: {
          resourceId: gitResourceId,
          appId: null,
          repositoryOwner: "acme-apps",
          repositoryName: "unknown-repo",
        },
      });
      const reason = (stored.metadata as { reason: string }).reason;
      expect(reason).not.toContain("ghp_");
      expect(reason).not.toContain("dXNlcjpzZWNyZXQ=");
      expect(reason).toContain("[***]");
    });

    it("accepts success events only from the app's owner, rejections from anyone", async () => {
      const { app } = await client.lookupApp({
        app: { repositoryOwner: "acme-apps", repositoryName: `${prefix}-tracker` },
      });
      const fetched = (subject: string) => ({
        eventId: randomUUID(),
        eventType: "git_fetch.completed" as const,
        subject,
        appId: app.id,
        details: {
          credentialId: null,
          requestBytes: 1,
          responseBytes: 2,
          durationMs: 3,
          upstreamStatus: 200,
        },
      });
      const refused = fetched(bob.id);
      expect(await rejected(client.reportAuditEvent(refused))).toEqual({
        code: "subject_not_owner",
        status: 403,
      });
      expect(
        await db.auditEvent.count({
          where: { deduplicationKey: `app-host:${gitResourceId}:${refused.eventId}` },
        }),
      ).toBe(0);
      expect(await client.reportAuditEvent(fetched(alice.id))).toMatchObject({
        accepted: true,
        duplicate: false,
      });
      const denied = await client.reportAuditEvent({
        eventId: randomUUID(),
        eventType: "git_push.denied",
        subject: bob.id,
        appId: app.id,
        repository: null,
        reason: "Only the owner may push.",
        details: {
          refUpdates: [],
          refUpdateCount: 0,
          credentialId: null,
          requestBytes: null,
          responseBytes: null,
          durationMs: null,
          upstreamStatus: null,
        },
      });
      expect(
        await db.auditEvent.findUniqueOrThrow({ where: { id: denied.auditEventId } }),
      ).toMatchObject({ actorId: bob.id, outcome: "denied", subjectId: app.id });
    });

    it("refuses reports that do not fit the contract or name another resource's app", async () => {
      const foreign = await db.app.findFirstOrThrow({ where: { resourceId: otherResourceId } });
      expect(
        await rejected(
          client.reportAuditEvent({
            eventId: randomUUID(),
            eventType: "git_fetch.completed",
            subject: alice.id,
            appId: foreign.id,
            details: {
              credentialId: null,
              requestBytes: 1,
              responseBytes: 2,
              durationMs: 3,
              upstreamStatus: 200,
            },
          }),
        ),
      ).toEqual({ code: "not_found", status: 404 });
      expect(
        await rejected(
          outsider.reportAuditEvent({
            eventId: randomUUID(),
            eventType: "git_host.checked",
            subject: null,
            repository: null,
            details: { passed: 1, failed: 0, unverifiable: 0, failedChecks: [], durationMs: 5 },
          }),
        ),
      ).toEqual({ code: "invalid_target", status: 403 });
      const valid = {
        resource: gitResource,
        eventId: randomUUID(),
        eventType: "git_credential.issued",
        subject: alice.id,
        appId: foreign.id,
        details: { credentialId: "c1", access: "write", expiresAt: new Date().toISOString() },
      };
      for (const body of [
        { ...valid, extra: true },
        { ...valid, details: { ...valid.details, token: "x" } },
        { ...valid, eventType: "skill.created" },
        { ...valid, subject: null },
        { ...valid, eventId: "short" },
      ])
        expect(
          await raw(appHostReportAuditEvent, "/api/app-host/v1/audit-events", body),
        ).toMatchObject({ status: 400, json: { error: "invalid_request" } });
    });

    it("lets the Git app check a person's login permission with check-scopes", async () => {
      expect(await client.checkSubjectScopes(alice.id, ["weldall:login"])).toMatchObject({
        granted: ["weldall:login"],
        missing: [],
      });
      expect(await client.checkSubjectScopes(carol.id, ["weldall:login"])).toMatchObject({
        granted: [],
        missing: ["weldall:login"],
      });
    });
  },
);
