import { readFileSync } from "node:fs";
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
  generateEs256KeyPair,
  requestMachineToken,
  type DpopKeyPair,
} from "@weldall/sdk";

vi.mock("../src/server/auth/auth.js", () => ({
  auth: { handler: vi.fn(async () => new Response(null, { status: 500 })) },
}));
import { appHostReportAuditEvent } from "../src/server/app-host/audit";
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
/** Allowed for the Git app's resource with `weldall:subject-scopes-check`, but not a Git app. */
const checkerClientId = `${prefix}-checker`;
let gitAppKey: DpopKeyPair;
let outsiderKey: DpopKeyPair;
let checkerKey: DpopKeyPair;
let gitResourceId: string;
const commit = (digit: string) => digit.repeat(40);
/** The example request the Git app's client is tested to send (an identical copy lives there). */
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/app-host/audit-event-request.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

/** Routes the token request to the route handler, as Next.js would. */
async function weldallFetch(input: string | URL | Request, init?: RequestInit) {
  const request = input instanceof Request ? input : new Request(input, init);
  if (new URL(request.url).pathname === "/api/auth/oauth2/token") {
    const { tokenFacade } = await import("../src/server/oauth/facade.js");
    return tokenFacade(request);
  }
  return new Response(null, { status: 404 });
}

/** A request of a machine client, signed as the Git app's client signs it. */
async function call(
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  {
    clientId = gitAppClientId,
    key = gitAppKey,
    scope = APP_HOST_SCOPE_KEY,
  }: { clientId?: string; key?: DpopKeyPair; scope?: string } = {},
) {
  const token = (
    await requestMachineToken({
      issuer: WELDALL_ISSUER,
      clientId,
      resource: WELDALL_RESOURCE,
      scopes: [scope],
      kid: "current",
      key,
      fetch: weldallFetch,
    })
  ).accessToken;
  const url = `${WELDALL_ISSUER}${path}`;
  const proof = await createDpopProof({ ...key, method: "POST", url, accessToken: token });
  const response = await handler(
    new Request(url, {
      method: "POST",
      headers: { authorization: `DPoP ${token}`, dpop: proof, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, json: (await response.json()) as any };
}

const report = (body: Record<string, unknown>, as?: Parameters<typeof call>[3]) =>
  call(
    appHostReportAuditEvent,
    "/api/app-host/v1/audit-events",
    { resource: gitResource, eventId: randomUUID(), ...body },
    as,
  );
const stored = (auditEventId: string) =>
  db.auditEvent.findUniqueOrThrow({ where: { id: auditEventId } });

const repository = { owner: "acme-apps", name: `${prefix}-tracker` };
const fetchDetails = {
  credentialId: null,
  requestBytes: 1,
  responseBytes: 2,
  durationMs: 3,
  upstreamStatus: 200,
};
const rejectedPushDetails = {
  refUpdates: [],
  refUpdateCount: 0,
  credentialId: null,
  requestBytes: null,
  responseBytes: null,
  durationMs: null,
  upstreamStatus: null,
};

describe.skipIf(!approvedTarget)(
  "app host API for a Git app on explicitly selected disposable PostgreSQL",
  () => {
    beforeAll(async () => {
      if (!approvedTarget) throw new Error("Unsafe database target");
      const issuerKey = await generateEs256KeyPair();
      [gitAppKey, outsiderKey, checkerKey] = await Promise.all([
        generateEs256KeyPair(),
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
      const otherResourceId = (await resource(`${prefix}-other`, otherResource)).id;
      const { createMachineClient } = await import("../src/server/machines/service.js");
      for (const [clientId, key, resourceIds, scopeIds] of [
        [gitAppClientId, gitAppKey, [gitResourceId], [appHost.id, subjectCheck.id]],
        [outsiderClientId, outsiderKey, [otherResourceId], [appHost.id, subjectCheck.id]],
        [checkerClientId, checkerKey, [gitResourceId], [subjectCheck.id]],
      ] as const)
        await createMachineClient(
          {
            clientId,
            name: clientId,
            key: { kid: "current", publicJwk: key.publicJwk },
            access: { resourceIds: [...resourceIds], scopeIds: [...scopeIds] },
          },
          { id: prefix, requestId: `${prefix}-machine` },
        );
    });

    afterAll(async () => {
      if (!approvedTarget) return;
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

    it("accepts the example request the Git app's client sends", async () => {
      // Only the resource and the person must exist here; everything else is the fixture as is.
      const accepted = await report({ ...fixture, resource: gitResource, subject: alice.id });
      expect(accepted).toMatchObject({
        status: 201,
        json: { accepted: true, eventId: fixture.eventId, duplicate: false },
      });
      expect(await stored(accepted.json.auditEventId)).toMatchObject({
        eventType: "git_push.forwarded",
        actorType: "user",
        actorId: alice.id,
        subjectType: "resource",
        subjectId: gitResourceId,
        metadata: {
          resourceId: gitResourceId,
          appId: fixture.appId,
          repositoryOwner: "acme-apps",
          repositoryName: "app-expenses",
          ...(fixture.details as object),
        },
      });
    });

    it("records a reported push as the person's, once, and confirms acceptance", async () => {
      const body = {
        eventId: randomUUID(),
        eventType: "git_push.forwarded",
        subject: alice.id,
        appId: "app_tracker",
        repository,
        details: {
          refUpdates: [
            { ref: "refs/heads/weldall/publish-1", oldCommit: commit("0"), newCommit: commit("a") },
          ],
          refUpdateCount: 1,
          credentialId: "cred-1",
        },
      };
      const accepted = await report(body);
      expect(accepted).toMatchObject({
        status: 201,
        json: { accepted: true, eventId: body.eventId, duplicate: false },
      });
      const entry = await stored(accepted.json.auditEventId);
      expect(entry).toMatchObject({
        eventType: "git_push.forwarded",
        actorType: "user",
        actorId: alice.id,
        actorEmail: alice.email,
        clientId: gitAppClientId,
        outcome: "success",
        subjectType: "resource",
        subjectId: gitResourceId,
        deduplicationKey: `app-host:${gitResourceId}:${body.eventId}`,
        metadata: {
          resourceId: gitResourceId,
          appId: "app_tracker",
          repositoryOwner: "acme-apps",
          repositoryName: `${prefix}-tracker`,
          refUpdates: body.details.refUpdates,
          refUpdateCount: 1,
          credentialId: "cred-1",
        },
      });

      const retried = await report(body);
      expect(retried).toEqual({ status: 200, json: { ...accepted.json, duplicate: true } });
      expect(
        await db.auditEvent.count({ where: { deduplicationKey: entry.deduplicationKey } }),
      ).toBe(1);
      expect(
        await report({ ...body, details: { ...body.details, credentialId: "cred-2" } }),
      ).toMatchObject({ status: 409, json: { error: "event_id_conflict" } });
    });

    it("takes the app id as the Git app's and trusts it to decide who acts on an app", async () => {
      // Weldall keeps no app records: an id it has never seen and a person other than the one
      // who published before are both recorded as reported.
      for (const subject of [alice.id, bob.id]) {
        const accepted = await report({
          eventType: "git_fetch.completed",
          subject,
          appId: "app_never_seen_by_weldall",
          repository,
          details: fetchDetails,
        });
        expect(accepted.status).toBe(201);
        expect(await stored(accepted.json.auditEventId)).toMatchObject({
          actorId: subject,
          outcome: "success",
          metadata: { appId: "app_never_seen_by_weldall", repositoryName: `${prefix}-tracker` },
        });
      }
      // A rejection may name both the app and the repository it concerned.
      const denied = await report({
        eventType: "git_push.denied",
        subject: bob.id,
        appId: "app_tracker",
        repository,
        reason: "Only the owner may push.",
        details: rejectedPushDetails,
      });
      expect(await stored(denied.json.auditEventId)).toMatchObject({
        actorId: bob.id,
        outcome: "denied",
        reasonCode: "invalid_request",
        subjectId: gitResourceId,
        metadata: {
          appId: "app_tracker",
          repositoryOwner: "acme-apps",
          repositoryName: `${prefix}-tracker`,
          reason: "Only the owner may push.",
        },
      });
    });

    it("redacts credentials in reported text and records the machine when no person is known", async () => {
      const accepted = await report({
        eventType: "git_push.denied",
        subject: null,
        appId: null,
        repository: { owner: "acme-apps", name: "unknown-repo" },
        reason: `Rejected credential ghp_${"a".repeat(36)} for Authorization: Basic dXNlcjpzZWNyZXQ=`,
        details: rejectedPushDetails,
      });
      const entry = await stored(accepted.json.auditEventId);
      expect(entry).toMatchObject({
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
      const reason = (entry.metadata as { reason: string }).reason;
      expect(reason).not.toContain("ghp_");
      expect(reason).not.toContain("dXNlcjpzZWNyZXQ=");
      expect(reason).toContain("[***]");
    });

    it("records registrations and re-verification from the Git app's registry", async () => {
      const registered = await report({
        eventType: "git_repository.registered",
        subject: bob.id,
        appId: "app_registered",
        repository: { owner: "acme-apps", name: `${prefix}-existing` },
        details: { owner: alice.id, repositoryId: "R_1", defaultBranch: "main", warnings: [] },
      });
      expect(registered.status).toBe(201);
      expect(await stored(registered.json.auditEventId)).toMatchObject({
        eventType: "git_repository.registered",
        actorId: bob.id,
        outcome: "success",
        metadata: {
          resourceId: gitResourceId,
          appId: "app_registered",
          repositoryOwner: "acme-apps",
          repositoryName: `${prefix}-existing`,
          owner: alice.id,
          repositoryId: "R_1",
          defaultBranch: "main",
          warnings: [],
        },
      });

      const details = {
        previousExpiresAt: "2026-12-01T00:00:00.000Z",
        expiresAt: "2027-03-01T00:00:00.000Z",
        previousState: "expiring_soon",
      };
      const confirmed = await report({
        eventType: "app_confirmation.succeeded",
        subject: alice.id,
        appId: "app_registered",
        repository: { owner: "acme-apps", name: `${prefix}-existing` },
        details,
      });
      expect(await stored(confirmed.json.auditEventId)).toMatchObject({
        eventType: "app_confirmation.succeeded",
        actorId: alice.id,
        outcome: "success",
        subjectType: "resource",
        subjectId: gitResourceId,
        metadata: {
          resourceId: gitResourceId,
          appId: "app_registered",
          repositoryName: `${prefix}-existing`,
          ...details,
        },
      });

      const refused = await report({
        eventType: "app_confirmation.denied",
        subject: bob.id,
        appId: null,
        repository: null,
        reason: "No app app_registered of this person.",
        details: {},
      });
      expect(await stored(refused.json.auditEventId)).toMatchObject({
        eventType: "app_confirmation.denied",
        actorId: bob.id,
        outcome: "denied",
        metadata: {
          resourceId: gitResourceId,
          appId: null,
          repositoryOwner: null,
          repositoryName: null,
          reason: "No app app_registered of this person.",
        },
      });
    });

    it("refuses reports that do not fit the contract or name a resource the client may not use", async () => {
      expect(
        await report(
          {
            eventType: "git_host.checked",
            subject: null,
            repository: null,
            details: { passed: 1, failed: 0, unverifiable: 0, failedChecks: [], durationMs: 5 },
          },
          { clientId: outsiderClientId, key: outsiderKey },
        ),
      ).toMatchObject({ status: 403, json: { error: "invalid_target" } });
      expect(
        await report({
          eventType: "git_host.checked",
          subject: null,
          repository: null,
          details: { passed: 1, failed: 0, unverifiable: 0, failedChecks: [], durationMs: 5 },
        }),
      ).toMatchObject({ status: 201 });
      expect(
        await report({
          eventType: "git_fetch.completed",
          subject: `${prefix}-nobody`,
          appId: "app_tracker",
          repository,
          details: fetchDetails,
        }),
      ).toMatchObject({ status: 404, json: { error: "unknown_subject" } });
      const valid = {
        eventType: "git_credential.issued",
        subject: alice.id,
        appId: "app_tracker",
        repository,
        details: { credentialId: "c1", access: "write", expiresAt: new Date().toISOString() },
      };
      expect(await report(valid)).toMatchObject({ status: 201 });
      for (const body of [
        { ...valid, extra: true },
        { ...valid, details: { ...valid.details, token: "x" } },
        { ...valid, eventType: "skill.created" },
        { ...valid, subject: null },
        { ...valid, eventId: "short" },
        // A success event always names the app and its repository.
        { ...valid, repository: null },
        { ...valid, appId: null },
        { ...valid, repository: undefined },
      ])
        expect(await report(body)).toMatchObject({
          status: 400,
          json: { error: "invalid_request" },
        });
    });

    it("lets the Git app check a person's login permission with check-scopes", async () => {
      const check = (subject: string) =>
        call(
          subjectScopesCheck,
          "/api/authorization/v1/check-scopes",
          { subject, scopes: ["weldall:login"] },
          { scope: SUBJECT_SCOPES_CHECK_SCOPE_KEY },
        );
      // The Git app's resource does not list `weldall:login`; holding `weldall:app-host` is what
      // lets the Git app's machine client check it.
      expect(await check(alice.id)).toMatchObject({
        status: 200,
        json: { granted: ["weldall:login"], missing: [] },
      });
      expect(await check(carol.id)).toMatchObject({
        status: 200,
        json: { granted: [], missing: ["weldall:login"] },
      });
    });

    it("refuses the login permission check to a machine client that is not a Git app", async () => {
      // Allowed for the same resource, which does not list `weldall:login`, but without
      // `weldall:app-host`: the same answer as for any scope its resources do not support.
      for (const subject of [alice.id, carol.id])
        expect(
          await call(
            subjectScopesCheck,
            "/api/authorization/v1/check-scopes",
            { subject, scopes: ["weldall:login"] },
            { clientId: checkerClientId, key: checkerKey, scope: SUBJECT_SCOPES_CHECK_SCOPE_KEY },
          ),
        ).toMatchObject({ status: 403, json: { error: "insufficient_scope" } });
    });
  },
);
