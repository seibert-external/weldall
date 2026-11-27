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
/** Removes `weldall:app-host` from a machine client, as an administrator would. */
const removeAppHostScope = (clientId: string) =>
  db.machineAllowedScope.deleteMany({
    where: { client: { clientId }, scope: { key: APP_HOST_SCOPE_KEY } },
  });
/** Exists but may not use Weldall (no `weldall:login`). */
const carol = person("carol");
const gitResource = `https://git-${prefix}.example.com/api`;
const otherResource = `https://other-${prefix}.example.com/api`;
const appHostClientId = `${prefix}-app-host`;
const outsiderClientId = `${prefix}-outsider`;
/** Allowed for the app host's resource with `weldall:subject-scopes-check`, but not an app host. */
const checkerClientId = `${prefix}-checker`;
/** An app host whose only allowed resource is disabled. */
const disabledClientId = `${prefix}-disabled`;
/** App hosts that lose `weldall:app-host` during a test. */
const revokedClientId = `${prefix}-revoked`;
const recheckClientId = `${prefix}-recheck`;
const disabledResource = `https://disabled-${prefix}.example.com/api`;
let gitAppKey: DpopKeyPair;
let outsiderKey: DpopKeyPair;
let checkerKey: DpopKeyPair;
let disabledKey: DpopKeyPair;
let revokedKey: DpopKeyPair;
let recheckKey: DpopKeyPair;
let gitResourceId: string;
const commit = (digit: string) => digit.repeat(40);
/** The example request the app host's client is tested to send (an identical copy lives there). */
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

/** A request of a machine client, signed as the app host's client signs it. */
async function call(
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  {
    clientId = appHostClientId,
    key = gitAppKey,
    scope = APP_HOST_SCOPE_KEY,
    beforeRequest,
    rawBody,
  }: {
    clientId?: string;
    key?: DpopKeyPair;
    scope?: string;
    /** Runs after the token was issued, before the request reaches the handler. */
    beforeRequest?: () => Promise<void>;
    /** Sent as is instead of `JSON.stringify(body)`. */
    rawBody?: string;
  } = {},
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
  await beforeRequest?.();
  const response = await handler(
    new Request(url, {
      method: "POST",
      headers: { authorization: `DPoP ${token}`, dpop: proof, "content-type": "application/json" },
      body: rawBody ?? JSON.stringify(body),
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
  "app host API for an app host on explicitly selected disposable PostgreSQL",
  () => {
    beforeAll(async () => {
      if (!approvedTarget) throw new Error("Unsafe database target");
      const issuerKey = await generateEs256KeyPair();
      [gitAppKey, outsiderKey, checkerKey, disabledKey, revokedKey, recheckKey] = await Promise.all(
        Array.from({ length: 6 }, () => generateEs256KeyPair()),
      );
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
      const disabledResourceId = (await resource(`${prefix}-disabled`, disabledResource)).id;
      const { createMachineClient } = await import("../src/server/machines/service.js");
      for (const [clientId, key, resourceIds, scopeIds] of [
        [appHostClientId, gitAppKey, [gitResourceId], [appHost.id, subjectCheck.id]],
        [outsiderClientId, outsiderKey, [otherResourceId], [appHost.id, subjectCheck.id]],
        [checkerClientId, checkerKey, [gitResourceId], [subjectCheck.id]],
        [disabledClientId, disabledKey, [disabledResourceId], [appHost.id, subjectCheck.id]],
        [revokedClientId, revokedKey, [gitResourceId], [appHost.id, subjectCheck.id]],
        [recheckClientId, recheckKey, [gitResourceId], [appHost.id, subjectCheck.id]],
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
      await db.downstreamResource.update({
        where: { id: disabledResourceId },
        data: { enabled: false },
      });
    });

    afterAll(async () => {
      if (!approvedTarget) return;
      await db.machineClient.deleteMany({ where: { clientId: { startsWith: prefix } } });
      await db.downstreamResource.deleteMany({ where: { key: { startsWith: prefix } } });
      vi.restoreAllMocks();
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

    it("accepts the example request the app host's client sends", async () => {
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
        clientId: appHostClientId,
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

    it("takes the app id as the app host's and trusts it to decide who acts on an app", async () => {
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
        actorId: appHostClientId,
        clientId: appHostClientId,
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

    it("records registrations and re-verification from the app host's registry", async () => {
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

      const reassigned = await report({
        eventType: "app_owner.assigned",
        subject: bob.id,
        appId: "app_registered",
        repository: { owner: "acme-apps", name: `${prefix}-existing` },
        details: { owner: bob.id, previousOwner: alice.id },
      });
      expect(reassigned.status).toBe(201);
      expect(await stored(reassigned.json.auditEventId)).toMatchObject({
        eventType: "app_owner.assigned",
        actorId: bob.id,
        outcome: "success",
        subjectType: "resource",
        subjectId: gitResourceId,
        metadata: {
          resourceId: gitResourceId,
          appId: "app_registered",
          repositoryOwner: "acme-apps",
          repositoryName: `${prefix}-existing`,
          owner: bob.id,
          previousOwner: alice.id,
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

    it("lets the app host check a person's login permission with check-scopes", async () => {
      const check = (subject: string) =>
        call(
          subjectScopesCheck,
          "/api/authorization/v1/check-scopes",
          { subject, scopes: ["weldall:login"] },
          { scope: SUBJECT_SCOPES_CHECK_SCOPE_KEY },
        );
      // The app host's resource does not list `weldall:login`; holding `weldall:app-host` is what
      // lets the app host's machine client check it.
      expect(await check(alice.id)).toMatchObject({
        status: 200,
        json: { granted: ["weldall:login"], missing: [] },
      });
      expect(await check(carol.id)).toMatchObject({
        status: 200,
        json: { granted: [], missing: ["weldall:login"] },
      });
    });

    it("refuses the login permission check to a machine client that is not an app host", async () => {
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
    it("stores reported text with lone surrogates or NUL instead of failing", async () => {
      // PostgreSQL's JSONB refuses lone surrogates and NUL; free text is made storable.
      const denied = await report({
        eventType: "git_pull_request.denied",
        subject: bob.id,
        appId: "app_tracker",
        repository,
        reason: "bad \ud800 ref\u0000end",
        details: { headBranch: "weldall/\udfff-publish" },
      });
      expect(denied.status).toBe(201);
      expect((await stored(denied.json.auditEventId)).metadata).toMatchObject({
        reason: "bad � ref end",
        headBranch: "weldall/�-publish",
      });
      // A success path must not be blocked by a person-chosen branch name either.
      const push = {
        eventType: "git_push.forwarded",
        subject: alice.id,
        appId: "app_tracker",
        repository,
        details: {
          refUpdates: [
            { ref: "refs/heads/\ud83d-x", oldCommit: commit("0"), newCommit: commit("b") },
          ],
          refUpdateCount: 1,
          credentialId: null,
        },
      };
      const forwarded = await report(push);
      expect(forwarded.status).toBe(201);
      expect((await stored(forwarded.json.auditEventId)).metadata).toMatchObject({
        refUpdates: [{ ref: "refs/heads/�-x" }],
      });
      // Identifiers are validated, not repaired: a lone surrogate there is a bad request.
      for (const body of [
        { ...push, subject: `${alice.id}\ud800` },
        {
          eventType: "app_owner.assigned",
          subject: bob.id,
          appId: "app_registered",
          repository,
          details: { owner: "owner-\ud800", previousOwner: null },
        },
      ])
        expect(await report(body)).toMatchObject({
          status: 400,
          json: { error: "invalid_request" },
        });
    });

    it("stores token-shaped identifiers exactly as reported", async () => {
      const credentialId = `wgc_k1.${"p".repeat(20)}`;
      const tokenShaped = { owner: "acme-apps", name: `ghp_${"n".repeat(12)}` };
      const issued = await report({
        eventType: "git_credential.issued",
        subject: alice.id,
        appId: `ghs_${"a".repeat(12)}`,
        repository: tokenShaped,
        details: { credentialId, access: "write", expiresAt: new Date().toISOString() },
      });
      expect(issued.status).toBe(201);
      expect((await stored(issued.json.auditEventId)).metadata).toMatchObject({
        appId: `ghs_${"a".repeat(12)}`,
        repositoryName: tokenShaped.name,
        credentialId,
      });
      const fetched = await report({
        eventType: "git_fetch.completed",
        subject: alice.id,
        appId: "app_tracker",
        repository,
        details: { ...fetchDetails, credentialId },
      });
      expect((await stored(fetched.json.auditEventId)).metadata).toMatchObject({ credentialId });
    });

    it("cuts long text to its stored length and refuses only what the contract bounds", async () => {
      const longRef = `refs/heads/${"r".repeat(3_000)}`;
      const accepted = await report({
        eventType: "git_push.denied",
        subject: bob.id,
        appId: "app_tracker",
        repository,
        reason: `Refused. ${"x".repeat(7_000)}`,
        details: {
          ...rejectedPushDetails,
          refUpdates: [{ ref: longRef, oldCommit: commit("1"), newCommit: commit("2") }],
          refUpdateCount: 1,
        },
      });
      expect(accepted.status).toBe(201);
      const metadata = (await stored(accepted.json.auditEventId)).metadata as any;
      expect(metadata.reason).toHaveLength(500);
      expect(metadata.reason.startsWith("Refused. ")).toBe(true);
      expect(metadata.reason.endsWith("…[truncated]")).toBe(true);
      expect(metadata.refUpdates[0].ref).toHaveLength(255);

      const tooLong = await report({
        eventType: "git_push.denied",
        subject: bob.id,
        appId: "app_tracker",
        repository,
        reason: "x".repeat(8_001),
        details: rejectedPushDetails,
      });
      expect(tooLong).toMatchObject({ status: 400, json: { error: "invalid_request" } });
      const tooLarge = await report({
        eventType: "git_push.denied",
        subject: bob.id,
        appId: "app_tracker",
        repository,
        reason: "Refused.",
        details: {
          ...rejectedPushDetails,
          refUpdates: Array.from({ length: 10 }, () => ({
            ref: "r".repeat(7_000),
            oldCommit: commit("1"),
            newCommit: commit("2"),
          })),
          refUpdateCount: 10,
        },
      });
      expect(tooLarge).toMatchObject({
        status: 400,
        json: { error: "invalid_request", error_description: "request body is too large" },
      });
    });

    it("refuses numbers beyond exact integers with 400", async () => {
      for (const raw of ["1e300", "9007199254740992", "1e400"]) {
        const body = {
          resource: gitResource,
          eventId: randomUUID(),
          eventType: "git_push.forwarded",
          subject: alice.id,
          appId: "app_tracker",
          repository,
          details: { refUpdates: [], refUpdateCount: 0, credentialId: null },
        };
        expect(
          await call(appHostReportAuditEvent, "/api/app-host/v1/audit-events", body, {
            rawBody: JSON.stringify(body).replace('"refUpdateCount":0', `"refUpdateCount":${raw}`),
          }),
        ).toMatchObject({ status: 400, json: { error: "invalid_request" } });
      }
    });

    it("records two concurrent identical reports once", async () => {
      const body = {
        eventId: randomUUID(),
        eventType: "git_fetch.completed",
        subject: alice.id,
        appId: "app_tracker",
        repository,
        details: fetchDetails,
      };
      const answers = await Promise.all([report(body), report(body)]);
      expect(answers.map(({ status }) => status).sort()).toEqual([200, 201]);
      expect(answers.map(({ json }) => json.duplicate).sort()).toEqual([false, true]);
      expect(answers[0]!.json.auditEventId).toBe(answers[1]!.json.auditEventId);
      expect(
        await db.auditEvent.count({
          where: { deduplicationKey: `app-host:${gitResourceId}:${body.eventId}` },
        }),
      ).toBe(1);
    });

    it("refuses an app host without its scope or an enabled resource", async () => {
      const checked = {
        eventType: "git_host.checked",
        subject: null,
        repository: null,
        details: { passed: 1, failed: 0, unverifiable: 0, failedChecks: [], durationMs: 5 },
      };
      // Its only allowed resource is disabled.
      expect(
        await call(
          appHostReportAuditEvent,
          "/api/app-host/v1/audit-events",
          { ...checked, resource: disabledResource, eventId: randomUUID() },
          { clientId: disabledClientId, key: disabledKey },
        ),
      ).toMatchObject({ status: 403, json: { error: "invalid_target" } });
      // A valid token of the app host's client, but not for `weldall:app-host`.
      expect(await report(checked, { scope: SUBJECT_SCOPES_CHECK_SCOPE_KEY })).toMatchObject({
        status: 403,
        json: { error: "insufficient_scope" },
      });
      // `weldall:app-host` removed after the token was issued.
      expect(
        await report(checked, {
          clientId: revokedClientId,
          key: revokedKey,
          beforeRequest: async () => {
            await removeAppHostScope(revokedClientId);
          },
        }),
      ).toMatchObject({ status: 401, json: { error: "invalid_token" } });
    });

    it("refuses the login permission check beyond what the app host may check", async () => {
      const check = (scopes: string[], as: Parameters<typeof call>[3] = {}) =>
        call(
          subjectScopesCheck,
          "/api/authorization/v1/check-scopes",
          { subject: alice.id, scopes },
          { scope: SUBJECT_SCOPES_CHECK_SCOPE_KEY, ...as },
        );
      // An app host whose only allowed resource is disabled may not check `weldall:login`.
      expect(
        await check(["weldall:login"], { clientId: disabledClientId, key: disabledKey }),
      ).toMatchObject({ status: 403, json: { error: "insufficient_scope" } });
      // `weldall:login` does not open the check to scopes no allowed resource supports.
      expect(await check(["weldall:login", "weldall:admin"])).toMatchObject({
        status: 403,
        json: { error: "insufficient_scope" },
      });
      // `weldall:app-host` removed between the first check and the one inside the transaction.
      const transaction = db.$transaction.bind(db);
      vi.spyOn(db, "$transaction").mockImplementationOnce((async (...args: unknown[]) => {
        await removeAppHostScope(recheckClientId);
        return (transaction as (...args: unknown[]) => unknown)(...args);
      }) as typeof db.$transaction);
      expect(
        await check(["weldall:login"], { clientId: recheckClientId, key: recheckKey }),
      ).toMatchObject({ status: 403, json: { error: "insufficient_scope" } });
      expect(
        await db.machineAllowedScope.count({
          where: { client: { clientId: recheckClientId }, scope: { key: APP_HOST_SCOPE_KEY } },
        }),
      ).toBe(0);
    });
  },
);
