import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, ensureSystemScopes, SUBJECT_SCOPES_CHECK_SCOPE_KEY } from "@weldall/db";
import {
  createDpopProof,
  generateEs256KeyPair,
  requestMachineToken,
  type DpopKeyPair,
} from "@weldall/sdk";
import { WELDALL_ISSUER, WELDALL_RESOURCE } from "../src/server/oauth/constants.js";

vi.mock("../src/server/auth/auth.js", () => ({
  auth: { handler: vi.fn(async () => new Response(null, { status: 500 })) },
}));

const runId = randomUUID();
const actorId = `subject-scope-test-${runId}`;
const clientId = `subject-scope-client-${runId}`;
const subject = `subject-scope-user-${runId}`;
const email = `subject-scope-${runId}@example.com`;
const grantedScopeKey = `scopecheck:granted-${runId}`;
const missingScopeKey = `scopecheck:missing-${runId}`;
const uncertainScopeKey = `scopecheck:uncertain-${runId}`;
const foreignScopeKey = `scopecheck:foreign-${runId}`;
const resourceIdentifier = `https://scopecheck-${runId}.example/api`;
const foreignResourceIdentifier = `https://scopecheck-foreign-${runId}.example/api`;
const endpoint = `${WELDALL_ISSUER}/api/authorization/v1/check-scopes`;
const providerKey = `scopecheck-provider-${runId}`;
let machineKey: DpopKeyPair;
let machineId: string;
let assignmentId: string;
let providerId: string;

beforeAll(async () => {
  Object.assign(process.env, {
    BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-characters",
    OAUTH_PROXY_SECRET: "test-oauth-proxy-secret-at-least-32-characters",
    WELDALL_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 12).toString("base64"),
  });
  const issuerKey = await generateEs256KeyPair();
  machineKey = await generateEs256KeyPair();
  Object.assign(process.env, {
    WELDALL_SIGNING_PRIVATE_JWK: JSON.stringify(issuerKey.privateJwk),
    WELDALL_SIGNING_PUBLIC_JWK: JSON.stringify(issuerKey.publicJwk),
    WELDALL_SIGNING_KID: `subject-scope-signing-${runId}`,
  });
  await ensureSystemScopes(db, actorId);
  const checkScope = await db.scope.findUniqueOrThrow({
    where: { key: SUBJECT_SCOPES_CHECK_SCOPE_KEY },
  });
  const [grantedScope, missingScope, uncertainScope, foreignScope] = await Promise.all(
    [grantedScopeKey, missingScopeKey, uncertainScopeKey, foreignScopeKey].map((key) =>
      db.scope.create({
        data: {
          key,
          description: key,
          createdBy: actorId,
          updatedBy: actorId,
        },
      }),
    ),
  );
  const [resource] = await Promise.all([
    db.downstreamResource.create({
      data: {
        key: `scopecheck-${runId}`,
        name: "Subject scope check resource",
        resourceIdentifier,
        authorizationServer: new URL(resourceIdentifier).origin,
        downstreamClientId: `scopecheck-downstream-${runId}`,
        createdBy: actorId,
        updatedBy: actorId,
        requestPrefixes: { create: { urlPrefix: resourceIdentifier, createdBy: actorId } },
        scopes: {
          create: [
            { scopeId: grantedScope.id },
            { scopeId: missingScope.id },
            { scopeId: uncertainScope.id },
          ],
        },
      },
    }),
    db.downstreamResource.create({
      data: {
        key: `scopecheck-foreign-${runId}`,
        name: "Foreign subject scope check resource",
        resourceIdentifier: foreignResourceIdentifier,
        authorizationServer: new URL(foreignResourceIdentifier).origin,
        downstreamClientId: `scopecheck-foreign-downstream-${runId}`,
        createdBy: actorId,
        updatedBy: actorId,
        requestPrefixes: {
          create: { urlPrefix: foreignResourceIdentifier, createdBy: actorId },
        },
        scopes: { create: { scopeId: foreignScope.id } },
      },
    }),
  ]);
  await db.user.create({
    data: { id: subject, name: "Scope Check User", email, emailVerified: true },
  });
  const assignment = await db.emailScopeAssignment.create({
    data: {
      normalizedEmail: email,
      createdBy: actorId,
      updatedBy: actorId,
      grants: { create: { scopeId: grantedScope.id, createdBy: actorId } },
    },
  });
  assignmentId = assignment.id;

  const { createMachineClient } = await import("../src/server/machines/service.js");
  const machine = await createMachineClient(
    {
      clientId,
      name: "Subject scope checker",
      key: { kid: "current", publicJwk: machineKey.publicJwk },
      access: { resourceIds: [resource.id], scopeIds: [checkScope.id] },
    },
    { id: actorId, requestId: `create-machine-${runId}` },
  );
  machineId = machine.id;

  const { createGroupAssignments, createGroupProvider } =
    await import("../src/server/group-providers/service.js");
  const provider = await createGroupProvider(
    {
      key: providerKey,
      name: "Unavailable subject scope provider",
      adapterType: "management-api-v1",
      baseUrl: `https://scopecheck-provider-${runId}.example`,
      token: "scopecheck-token",
      enabled: true,
    },
    { id: actorId, requestId: `create-provider-${runId}` },
  );
  providerId = provider.id;
  await createGroupAssignments(
    { providerId, groupIds: ["scope-checkers"], scopeKeys: [uncertainScopeKey] },
    { id: actorId, requestId: `create-group-${runId}` },
  );
  vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.groupScopeAssignment.deleteMany({ where: { providerId } });
  await db.groupProvider.deleteMany({ where: { id: providerId } });
  await db.emailScopeAssignment.deleteMany({ where: { id: assignmentId } });
  await db.machineClient.deleteMany({ where: { id: machineId } });
  await db.downstreamResource.deleteMany({
    where: { resourceIdentifier: { in: [resourceIdentifier, foreignResourceIdentifier] } },
  });
  await db.user.deleteMany({ where: { id: subject } });
  await db.scope.deleteMany({
    where: {
      key: { in: [grantedScopeKey, missingScopeKey, uncertainScopeKey, foreignScopeKey] },
    },
  });
  await db.auditEvent.deleteMany({
    where: { OR: [{ actorId }, { actorId: clientId }, { clientId }] },
  });
});

async function facadeFetch(input: string | URL | Request, init?: RequestInit) {
  const request = input instanceof Request ? input : new Request(input, init);
  const { tokenFacade } = await import("../src/server/oauth/facade.js");
  return tokenFacade(request);
}

async function machineToken(): Promise<string> {
  return (
    await requestMachineToken({
      issuer: WELDALL_ISSUER,
      clientId,
      resource: WELDALL_RESOURCE,
      scopes: [SUBJECT_SCOPES_CHECK_SCOPE_KEY],
      kid: "current",
      key: machineKey,
      fetch: facadeFetch,
    })
  ).accessToken;
}

async function check(token: string, body: unknown, proofKey = machineKey): Promise<Response> {
  const proof = await createDpopProof({
    ...proofKey,
    method: "POST",
    url: endpoint,
    accessToken: token,
  });
  const { subjectScopesCheck } = await import("../src/server/oauth/subject-scopes-api.js");
  return subjectScopesCheck(
    new Request(endpoint, {
      method: "POST",
      headers: {
        authorization: `DPoP ${token}`,
        dpop: proof,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("machine subject scope checks", () => {
  it("issues an internal machine token and reports granted and missing resource scopes", async () => {
    const response = await check(await machineToken(), {
      subject,
      scopes: [missingScopeKey, grantedScopeKey],
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      granted: [grantedScopeKey],
      missing: [missingScopeKey],
      evaluatedAt: expect.any(String),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires the DPoP key bound to the machine token", async () => {
    const attacker = await generateEs256KeyPair();
    const response = await check(
      await machineToken(),
      { subject, scopes: [grantedScopeKey] },
      attacker,
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_dpop_proof" });
  });

  it("does not disclose scopes outside the machine's allowed resources", async () => {
    const response = await check(await machineToken(), {
      subject,
      scopes: [foreignScopeKey],
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "insufficient_scope" });
  });

  it("does not turn a relevant provider outage into an authoritative missing scope", async () => {
    const response = await check(await machineToken(), {
      subject,
      scopes: [uncertainScopeKey],
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    await expect(response.json()).resolves.toMatchObject({ error: "temporarily_unavailable" });
  });

  it("returns not found without accepting email-based lookups", async () => {
    const unknown = await check(await machineToken(), {
      subject: `unknown-${runId}`,
      scopes: [grantedScopeKey],
    });
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ error: "not_found" });

    const emailLookup = await check(await machineToken(), {
      subject: email,
      scopes: [grantedScopeKey],
    });
    expect(emailLookup.status).toBe(404);
    await expect(emailLookup.json()).resolves.toMatchObject({ error: "not_found" });
  });

  it("revalidates machine scope authorization after token issuance", async () => {
    const token = await machineToken();
    const checkScope = await db.scope.findUniqueOrThrow({
      where: { key: SUBJECT_SCOPES_CHECK_SCOPE_KEY },
    });
    await db.machineAllowedScope.delete({
      where: {
        machineClientId_scopeId: { machineClientId: machineId, scopeId: checkScope.id },
      },
    });
    const response = await check(token, { subject, scopes: [grantedScopeKey] });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_token" });
    await db.machineAllowedScope.create({
      data: { machineClientId: machineId, scopeId: checkScope.id },
    });
  });
});
