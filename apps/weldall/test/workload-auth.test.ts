import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT, importJWK, type JWTPayload } from "jose";
import {
  PRIVATE_KEY_JWT_ASSERTION_TYPE,
  WORKLOAD_TOKEN_TYP,
  createDpopProof,
  createWorkloadClientAssertion,
  generateEs256KeyPair,
  inMemory,
  initWorkloadVerifier,
  requestWorkloadToken,
  type DpopKeyPair,
} from "@weldall/sdk";
import { createExpensesBWorkloadApp } from "../../expenses/src/workload.js";
import { WELDALL_ISSUER, WELDALL_TOKEN_ENDPOINT } from "../src/server/oauth/constants.js";

vi.mock("../src/server/auth/auth.js", () => ({
  auth: { handler: vi.fn(async () => new Response(null, { status: 500 })) },
}));

const clientId = `expenses-a-${randomUUID()}`;
const duplicateKeyClientId = `expenses-duplicate-${randomUUID()}`;
const resourceIdentifier = `https://expenses-b-${randomUUID()}.example/api`;
const lockOrderResourceIdentifier = `https://expenses-lock-${randomUUID()}.example/api`;
const resourceOrigin = new URL(resourceIdentifier).origin;
const actorId = `workload-admin-${randomUUID()}`;
const readScopeKey = `expenses-test:read-${randomUUID()}`;
const createScopeKey = `expenses-test:create-${randomUUID()}`;
const unselectedScopeKey = `expenses-test:unselected-${randomUUID()}`;
let issuerKey: DpopKeyPair;
let expensesAKey: DpopKeyPair;
let workloadDatabaseId: string;
let workloadKeyId: string;
let resourceId: string;
let readScopeId: string;

beforeAll(async () => {
  issuerKey = await generateEs256KeyPair();
  expensesAKey = await generateEs256KeyPair();
  Object.assign(process.env, {
    POSTGRES_URL: process.env.POSTGRES_URL ?? "postgresql://postgres@localhost:5433/postgres",
    BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-characters",
    OAUTH_PROXY_SECRET: "test-oauth-proxy-secret-at-least-32-characters",
    WELDALL_SIGNING_PRIVATE_JWK: JSON.stringify(issuerKey.privateJwk),
    WELDALL_SIGNING_PUBLIC_JWK: JSON.stringify(issuerKey.publicJwk),
    WELDALL_SIGNING_KID: "workload-e2e-weldall",
    WELDALL_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  });
  const { db } = await import("@weldall/db");
  const [readScope, createScope, unselectedScope] = await Promise.all([
    db.scope.create({
      data: {
        key: readScopeKey,
        description: "Read Expenses B",
        createdBy: actorId,
        updatedBy: actorId,
      },
    }),
    db.scope.create({
      data: {
        key: createScopeKey,
        description: "Create Expenses B",
        createdBy: actorId,
        updatedBy: actorId,
      },
    }),
    db.scope.create({
      data: {
        key: unselectedScopeKey,
        description: "Unselected Expenses B scope",
        createdBy: actorId,
        updatedBy: actorId,
      },
    }),
  ]);
  readScopeId = readScope.id;
  const resource = await db.downstreamResource.create({
    data: {
      key: `expenses-b-${randomUUID()}`,
      name: "Expenses B workload target",
      resourceIdentifier,
      authorizationServer: resourceOrigin,
      downstreamClientId: `expenses-b-${randomUUID()}`,
      createdBy: actorId,
      updatedBy: actorId,
      scopes: {
        create: [
          { scopeId: readScope.id },
          { scopeId: createScope.id },
          { scopeId: unselectedScope.id },
        ],
      },
      requestPrefixes: { create: { urlPrefix: resourceIdentifier, createdBy: actorId } },
    },
  });
  resourceId = resource.id;
  const { createWorkloadClient } = await import("../src/server/workloads/service.js");
  const client = await createWorkloadClient(
    {
      clientId,
      name: "Expenses A",
      key: { kid: "expenses-a-current", publicJwk: expensesAKey.publicJwk },
      access: { resourceIds: [resourceId], scopeIds: [readScope.id, createScope.id] },
    },
    { id: actorId, requestId: `create-${randomUUID()}` },
  );
  workloadDatabaseId = client.id;
  workloadKeyId = client.keys[0]!.id;
});

afterAll(async () => {
  const { db } = await import("@weldall/db");
  await db.auditEvent.deleteMany({
    where: { OR: [{ actorId }, { actorId: clientId }, { clientId }] },
  });
  await db.workloadClient.deleteMany({
    where: { clientId: { in: [clientId, duplicateKeyClientId] } },
  });
  await db.downstreamResource.deleteMany({
    where: { resourceIdentifier: { in: [resourceIdentifier, lockOrderResourceIdentifier] } },
  });
  await db.scope.deleteMany({
    where: { key: { in: [readScopeKey, createScopeKey, unselectedScopeKey] } },
  });
});

async function facadeFetch(input: string | URL | Request, init?: RequestInit) {
  const request = input instanceof Request ? input : new Request(input, init);
  const { tokenFacade } = await import("../src/server/oauth/facade.js");
  return tokenFacade(request);
}

async function obtain(
  scopes = [readScopeKey],
  resource = resourceIdentifier,
  key = expensesAKey,
  kid = "expenses-a-current",
) {
  return requestWorkloadToken({
    issuer: WELDALL_ISSUER,
    clientId,
    resource,
    scopes,
    kid,
    key,
    fetch: facadeFetch,
  });
}

function targetVerifier() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `${WELDALL_ISSUER}/.well-known/oauth-authorization-server`)
        return Response.json({
          issuer: WELDALL_ISSUER,
          jwks_uri: `${WELDALL_ISSUER}/api/oauth/jwks`,
        });
      if (url === `${WELDALL_ISSUER}/api/oauth/jwks`)
        return Response.json({
          keys: [{ ...issuerKey.publicJwk, kid: "workload-e2e-weldall", alg: "ES256", use: "sig" }],
        });
      return new Response(null, { status: 404 });
    }),
  );
  return initWorkloadVerifier(WELDALL_ISSUER, {
    resource: resourceIdentifier,
    publicOrigin: resourceOrigin,
    supportedScopes: [readScopeKey, createScopeKey],
    allowedClientIds: [clientId],
    replayStore: inMemory({ suppressWarning: true }),
  });
}

async function targetRequest(token: string, key = expensesAKey) {
  const url = `${resourceIdentifier}/expenses`;
  const proof = await createDpopProof({ ...key, method: "GET", url, accessToken: token });
  return new Request(url, { headers: { authorization: `DPoP ${token}`, dpop: proof } });
}

async function customAssertion(
  claims: Partial<JWTPayload> = {},
  header: { kid?: string; typ?: string } = {},
) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    iss: clientId,
    sub: clientId,
    aud: WELDALL_TOKEN_ENDPOINT,
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
    ...claims,
  })
    .setProtectedHeader({
      alg: "ES256",
      typ: header.typ ?? "JWT",
      kid: header.kid ?? "expenses-a-current",
    })
    .sign(await importJWK(expensesAKey.privateJwk, "ES256"));
}

function workloadTokenRequest(
  assertion: string,
  proof: string,
  scopes = readScopeKey,
  resource = resourceIdentifier,
  requestId?: string,
) {
  return new Request(WELDALL_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      dpop: proof,
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_assertion_type: PRIVATE_KEY_JWT_ASSERTION_TYPE,
      client_assertion: assertion,
      resource,
      scope: scopes,
    }),
  });
}

async function rawRequest(
  assertion: string,
  proof: string,
  scopes = readScopeKey,
  resource = resourceIdentifier,
  requestId?: string,
) {
  const { tokenFacade } = await import("../src/server/oauth/facade.js");
  return tokenFacade(workloadTokenRequest(assertion, proof, scopes, resource, requestId));
}

describe("Expenses A to Expenses B workload authentication", () => {
  it("registers Expenses A, obtains a token from Weldall, and enforces it at Expenses B", async () => {
    const issued = await obtain();
    targetVerifier();
    const deleteScope = `${readScopeKey}:delete`;
    const expensesB = createExpensesBWorkloadApp({
      weldallIssuer: WELDALL_ISSUER,
      resource: resourceIdentifier,
      publicOrigin: resourceOrigin,
      allowedClientIds: [clientId],
      replayStore: inMemory({ suppressWarning: true }),
      readScope: readScopeKey,
      createScope: createScopeKey,
      deleteScope,
    });
    const readUrl = `${resourceIdentifier}/internal/expenses`;
    const readProof = await createDpopProof({
      ...expensesAKey,
      method: "GET",
      url: readUrl,
      accessToken: issued.accessToken,
    });
    const accepted = await expensesB.request("/api/internal/expenses", {
      headers: { authorization: `DPoP ${issued.accessToken}`, dpop: readProof },
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      caller: clientId,
      identityType: "workload",
    });
    expect(issued.scope).toBe(readScopeKey);

    const createProof = await createDpopProof({
      ...expensesAKey,
      method: "POST",
      url: readUrl,
      accessToken: issued.accessToken,
    });
    expect(
      (
        await expensesB.request("/api/internal/expenses", {
          method: "POST",
          headers: { authorization: `DPoP ${issued.accessToken}`, dpop: createProof },
        })
      ).status,
    ).toBe(403);
    const deleteUrl = `${readUrl}/expense-b-1`;
    const deleteProof = await createDpopProof({
      ...expensesAKey,
      method: "DELETE",
      url: deleteUrl,
      accessToken: issued.accessToken,
    });
    expect(
      (
        await expensesB.request("/api/internal/expenses/expense-b-1", {
          method: "DELETE",
          headers: { authorization: `DPoP ${issued.accessToken}`, dpop: deleteProof },
        })
      ).status,
    ).toBe(403);

    const { db } = await import("@weldall/db");
    const event = await db.auditEvent.findFirstOrThrow({
      where: { actorId: clientId, eventType: "workload_token.issued" },
      orderBy: { occurredAt: "desc" },
    });
    expect(event).toMatchObject({ actorType: "workload", clientId, outcome: "success" });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(issued.accessToken);
    expect(serialized).not.toContain(expensesAKey.privateJwk.d);
  });

  it("rejects a resource-supported scope that is not selected for the workload", async () => {
    await expect(obtain([unselectedScopeKey])).rejects.toMatchObject({ code: "invalid_scope" });
  });

  it("rejects an unselected resource", async () => {
    const { db } = await import("@weldall/db");
    const unselectedResource = await db.downstreamResource.create({
      data: {
        key: `expenses-unselected-${randomUUID()}`,
        name: "Unselected workload target",
        resourceIdentifier: `https://expenses-unselected-${randomUUID()}.example/api`,
        authorizationServer: "https://expenses-unselected.example",
        downstreamClientId: `expenses-unselected-${randomUUID()}`,
        createdBy: actorId,
        updatedBy: actorId,
        scopes: { create: { scopeId: readScopeId } },
        requestPrefixes: {
          create: {
            urlPrefix: `https://expenses-unselected-${randomUUID()}.example/api`,
            createdBy: actorId,
          },
        },
      },
    });
    await expect(
      obtain([readScopeKey], unselectedResource.resourceIdentifier),
    ).rejects.toMatchObject({
      code: "invalid_target",
    });
    await db.downstreamResource.delete({ where: { id: unselectedResource.id } });
  });

  it("rejects a selected scope that is unsupported by the requested resource", async () => {
    const { db } = await import("@weldall/db");
    const createScope = await db.scope.findUniqueOrThrow({ where: { key: createScopeKey } });
    await db.resourceScope.delete({
      where: { resourceId_scopeId: { resourceId, scopeId: createScope.id } },
    });
    await expect(obtain([createScopeKey])).rejects.toMatchObject({ code: "invalid_scope" });
    await db.resourceScope.create({ data: { resourceId, scopeId: createScope.id } });
  });

  it("rejects invalid assertion signatures and wrong DPoP keys", async () => {
    const attacker = await generateEs256KeyPair();
    await expect(obtain([readScopeKey], resourceIdentifier, attacker)).rejects.toMatchObject({
      code: "invalid_client",
    });

    const issued = await obtain();
    targetVerifier();
    await expect(
      targetVerifier().verify(await targetRequest(issued.accessToken, attacker)),
    ).rejects.toMatchObject({
      code: "invalid_dpop_proof",
    });
  });

  it("treats resource and scope registration as non-authorizing after access replacement", async () => {
    const { getWorkloadClient, replaceWorkloadAccess } =
      await import("../src/server/workloads/service.js");
    const before = await getWorkloadClient(workloadDatabaseId);
    await replaceWorkloadAccess(
      {
        clientId: workloadDatabaseId,
        resourceIds: [],
        scopeIds: before.access.scopeIds,
        expectedVersion: before.version,
      },
      { id: actorId, requestId: `remove-access-${randomUUID()}` },
    );
    await expect(obtain()).rejects.toMatchObject({ code: "invalid_target" });
    const removed = await getWorkloadClient(workloadDatabaseId);
    await replaceWorkloadAccess(
      {
        clientId: workloadDatabaseId,
        resourceIds: [resourceId],
        scopeIds: removed.access.scopeIds,
        expectedVersion: removed.version,
      },
      { id: actorId, requestId: `restore-access-${randomUUID()}` },
    );
  });

  it("does not let absent resource access become visible after its lock statement", async () => {
    const { db } = await import("@weldall/db");
    await db.workloadAllowedResource.delete({
      where: {
        workloadClientId_resourceId: { workloadClientId: workloadDatabaseId, resourceId },
      },
    });
    const assertion = await createWorkloadClientAssertion({
      clientId,
      tokenEndpoint: WELDALL_TOKEN_ENDPOINT,
      kid: "expenses-a-current",
      privateJwk: expensesAKey.privateJwk,
    });
    const proof = await createDpopProof({
      ...expensesAKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const denied = await rawRequest(assertion, proof);
    expect(denied.status).toBe(400);
    await expect(denied.json()).resolves.toMatchObject({ error: "invalid_target" });

    const { getWorkloadClient, replaceWorkloadAccess } =
      await import("../src/server/workloads/service.js");
    const current = await getWorkloadClient(workloadDatabaseId);
    await replaceWorkloadAccess(
      {
        clientId: workloadDatabaseId,
        resourceIds: [resourceId],
        scopeIds: current.access.scopeIds,
        expectedVersion: current.version,
      },
      { id: actorId, requestId: `restore-absent-access-${randomUUID()}` },
    );
    // Later access applies only to a fresh issuance transaction; the denied request above
    // cannot continue and observe the new row under READ COMMITTED. Its authenticated proof
    // was durably consumed despite that denial.
    const replay = await rawRequest(assertion, proof);
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_dpop_proof" });
    await expect(obtain()).resolves.toMatchObject({ tokenType: "DPoP" });
  });

  it("locks an unselected resource during concurrent resource deletion", async () => {
    const { db } = await import("@weldall/db");
    const resource = await db.downstreamResource.create({
      data: {
        key: `expenses-lock-${randomUUID()}`,
        name: "Expenses lock-order target",
        resourceIdentifier: lockOrderResourceIdentifier,
        authorizationServer: new URL(lockOrderResourceIdentifier).origin,
        downstreamClientId: `expenses-lock-${randomUUID()}`,
        createdBy: actorId,
        updatedBy: actorId,
        scopes: { create: { scopeId: readScopeId } },
        requestPrefixes: {
          create: { urlPrefix: lockOrderResourceIdentifier, createdBy: actorId },
        },
      },
    });
    const assertion = await createWorkloadClientAssertion({
      clientId,
      tokenEndpoint: WELDALL_TOKEN_ENDPOINT,
      kid: "expenses-a-current",
      privateJwk: expensesAKey.privateJwk,
    });
    const proof = await createDpopProof({
      ...expensesAKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const { deleteResource } = await import("../src/server/admin/service.js");

    const [issuance, deletion] = await Promise.all([
      rawRequest(assertion, proof, readScopeKey, lockOrderResourceIdentifier),
      deleteResource(
        { id: resource.id, expectedVersion: resource.version },
        { id: actorId, requestId: `delete-lock-order-${randomUUID()}` },
      ),
    ]);

    expect(issuance.status).toBe(400);
    await expect(issuance.json()).resolves.toMatchObject({ error: "invalid_target" });
    expect(deletion).toEqual({ id: resource.id });
    await expect(db.downstreamResource.count({ where: { id: resource.id } })).resolves.toBe(0);
  }, 10_000);

  it("orders in-flight issuance before a concurrent key revocation commit", async () => {
    const assertion = await createWorkloadClientAssertion({
      clientId,
      tokenEndpoint: WELDALL_TOKEN_ENDPOINT,
      kid: "expenses-a-current",
      privateJwk: expensesAKey.privateJwk,
    });
    const proof = await createDpopProof({
      ...expensesAKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    let releaseAudit!: () => void;
    const auditReleased = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    let auditEntered!: () => void;
    const enteredAudit = new Promise<void>((resolve) => {
      auditEntered = resolve;
    });
    const { tokenFacadeWithAuditWriter } = await import("../src/server/oauth/facade.js");
    const issuance = tokenFacadeWithAuditWriter(
      new Request(WELDALL_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_assertion_type: PRIVATE_KEY_JWT_ASSERTION_TYPE,
          client_assertion: assertion,
          resource: resourceIdentifier,
          scope: readScopeKey,
        }),
      }),
      {
        async write(event) {
          if (event.eventType === "workload_token.issued") {
            auditEntered();
            await auditReleased;
          }
        },
      },
    );
    await enteredAudit;
    const { revokeWorkloadKey } = await import("../src/server/workloads/service.js");
    let revocationCommitted = false;
    const revocation = revokeWorkloadKey(
      { clientId: workloadDatabaseId, keyId: workloadKeyId },
      { id: actorId, requestId: `concurrent-revoke-${randomUUID()}` },
    ).then((value) => {
      revocationCommitted = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(revocationCommitted).toBe(false);
    releaseAudit();
    expect((await issuance).status).toBe(200);
    await revocation;
    expect(revocationCommitted).toBe(true);
    const { db } = await import("@weldall/db");
    await db.workloadClientKey.update({
      where: { id: workloadKeyId },
      data: { revokedAt: null, revokedBy: null },
    });
  });

  it("orders in-flight issuance before a concurrent access-policy replacement", async () => {
    const assertion = await createWorkloadClientAssertion({
      clientId,
      tokenEndpoint: WELDALL_TOKEN_ENDPOINT,
      kid: "expenses-a-current",
      privateJwk: expensesAKey.privateJwk,
    });
    const proof = await createDpopProof({
      ...expensesAKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    let releaseAudit!: () => void;
    const auditReleased = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    let auditEntered!: () => void;
    const enteredAudit = new Promise<void>((resolve) => {
      auditEntered = resolve;
    });
    const { tokenFacadeWithAuditWriter } = await import("../src/server/oauth/facade.js");
    const issuance = tokenFacadeWithAuditWriter(workloadTokenRequest(assertion, proof), {
      async write(event) {
        if (event.eventType === "workload_token.issued") {
          auditEntered();
          await auditReleased;
        }
      },
    });
    await enteredAudit;

    const { getWorkloadClient, replaceWorkloadAccess } =
      await import("../src/server/workloads/service.js");
    const before = await getWorkloadClient(workloadDatabaseId);
    let replacementCommitted = false;
    const replacement = replaceWorkloadAccess(
      {
        clientId: workloadDatabaseId,
        resourceIds: [],
        scopeIds: [],
        expectedVersion: before.version,
      },
      { id: actorId, requestId: `concurrent-access-${randomUUID()}` },
    ).then((value) => {
      replacementCommitted = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replacementCommitted).toBe(false);
    releaseAudit();
    expect((await issuance).status).toBe(200);
    const removed = await replacement;
    expect(replacementCommitted).toBe(true);

    await replaceWorkloadAccess(
      {
        clientId: workloadDatabaseId,
        resourceIds: [resourceId],
        scopeIds: before.access.scopeIds,
        expectedVersion: removed.version,
      },
      { id: actorId, requestId: `restore-concurrent-access-${randomUUID()}` },
    );
  });

  it("rejects disabled clients and revoked keys", async () => {
    const { db } = await import("@weldall/db");
    await db.workloadClient.update({
      where: { id: workloadDatabaseId },
      data: { enabled: false, deactivatedAt: new Date() },
    });
    await expect(obtain()).rejects.toMatchObject({ code: "invalid_client" });
    await db.workloadClient.update({
      where: { id: workloadDatabaseId },
      data: { enabled: true, deactivatedAt: null },
    });

    await db.workloadClientKey.update({
      where: { id: workloadKeyId },
      data: { revokedAt: new Date() },
    });
    await expect(obtain()).rejects.toMatchObject({ code: "invalid_client" });
    await db.workloadClientKey.update({ where: { id: workloadKeyId }, data: { revokedAt: null } });
  });

  it("rejects malformed private_key_jwt claims and headers without leaking assertions", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const assertions = [
      await customAssertion({ aud: "https://wrong.example/token" }),
      await customAssertion({ iss: "other-workload" }),
      await customAssertion({ sub: "other-workload" }),
      await customAssertion({ aud: [WELDALL_TOKEN_ENDPOINT, "https://other.example/token"] }),
      await customAssertion({ iat: now + 120, exp: now + 180 }),
      await customAssertion({ iat: now, exp: now + 61 }),
      await customAssertion({}, { kid: "unknown-key" }),
      await customAssertion({}, { typ: "not-jwt" }),
    ];
    for (const assertion of assertions) {
      const proof = await createDpopProof({
        ...expensesAKey,
        method: "POST",
        url: WELDALL_TOKEN_ENDPOINT,
      });
      const response = await rawRequest(assertion, proof);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_client" });
    }
    const { db } = await import("@weldall/db");
    const audits = await db.auditEvent.findMany({
      where: {
        eventType: "workload_token.denied",
        metadata: { path: ["clientId"], equals: clientId },
      },
      orderBy: { occurredAt: "desc" },
      take: assertions.length,
    });
    expect(audits).toHaveLength(assertions.length);
    const serialized = JSON.stringify(audits);
    for (const assertion of assertions) expect(serialized).not.toContain(assertion);
  });

  it("persists a sanitized denial audit for an unsafe resource value", async () => {
    const assertion = await customAssertion();
    const proof = await createDpopProof({
      ...expensesAKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const requestId = `unsafe-resource-${randomUUID()}`;
    const unsafeResource = `${resourceIdentifier}\nforged-audit-line`;
    const response = await rawRequest(assertion, proof, readScopeKey, unsafeResource, requestId);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_target" });
    const { db } = await import("@weldall/db");
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { requestId, eventType: "workload_token.denied" },
    });
    expect(audit).toMatchObject({
      actorType: "workload",
      actorId: clientId,
      clientId,
      subjectType: null,
      subjectId: null,
      metadata: expect.objectContaining({ audience: null }),
    });
    expect(JSON.stringify(audit)).not.toContain("forged-audit-line");
  });

  it("keeps replay markers after an authenticated policy denial", async () => {
    const assertion = await createWorkloadClientAssertion({
      clientId,
      tokenEndpoint: WELDALL_TOKEN_ENDPOINT,
      kid: "expenses-a-current",
      privateJwk: expensesAKey.privateJwk,
    });
    const proof = await createDpopProof({
      ...expensesAKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const denied = await rawRequest(assertion, proof, unselectedScopeKey);
    expect(denied.status).toBe(400);
    await expect(denied.json()).resolves.toMatchObject({ error: "invalid_scope" });

    const proofReplay = await rawRequest(assertion, proof);
    expect(proofReplay.status).toBe(400);
    await expect(proofReplay.json()).resolves.toMatchObject({ error: "invalid_dpop_proof" });

    const freshProof = await createDpopProof({
      ...expensesAKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const assertionReplay = await rawRequest(assertion, freshProof);
    expect(assertionReplay.status).toBe(400);
    await expect(assertionReplay.json()).resolves.toMatchObject({ error: "invalid_client" });
  });

  it("keeps replay markers when successful issuance later fails its audit write", async () => {
    const assertion = await createWorkloadClientAssertion({
      clientId,
      tokenEndpoint: WELDALL_TOKEN_ENDPOINT,
      kid: "expenses-a-current",
      privateJwk: expensesAKey.privateJwk,
    });
    const proof = await createDpopProof({
      ...expensesAKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const { tokenFacadeWithAuditWriter } = await import("../src/server/oauth/facade.js");
    const auditFailure = await tokenFacadeWithAuditWriter(workloadTokenRequest(assertion, proof), {
      async write() {
        throw new Error("audit unavailable");
      },
    });
    expect(auditFailure.status).toBe(500);
    await expect(auditFailure.json()).resolves.toMatchObject({ error: "server_error" });

    const proofReplay = await rawRequest(assertion, proof);
    expect(proofReplay.status).toBe(400);
    await expect(proofReplay.json()).resolves.toMatchObject({ error: "invalid_dpop_proof" });

    const freshProof = await createDpopProof({
      ...expensesAKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const assertionReplay = await rawRequest(assertion, freshProof);
    expect(assertionReplay.status).toBe(400);
    await expect(assertionReplay.json()).resolves.toMatchObject({ error: "invalid_client" });
  });

  it("completes parallel issuance without nested replay-pool acquisition", async () => {
    const responses = await Promise.all(
      Array.from({ length: 16 }, async () => {
        const assertion = await createWorkloadClientAssertion({
          clientId,
          tokenEndpoint: WELDALL_TOKEN_ENDPOINT,
          kid: "expenses-a-current",
          privateJwk: expensesAKey.privateJwk,
        });
        const proof = await createDpopProof({
          ...expensesAKey,
          method: "POST",
          url: WELDALL_TOKEN_ENDPOINT,
        });
        return rawRequest(assertion, proof);
      }),
    );
    expect(responses.map(({ status }) => status)).toEqual(Array(16).fill(200));
  });

  it("atomically rejects assertion replay and token-endpoint DPoP replay", async () => {
    const assertion = await createWorkloadClientAssertion({
      clientId,
      tokenEndpoint: WELDALL_TOKEN_ENDPOINT,
      kid: "expenses-a-current",
      privateJwk: expensesAKey.privateJwk,
    });
    const firstProof = await createDpopProof({
      ...expensesAKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    expect((await rawRequest(assertion, firstProof)).status).toBe(200);
    const freshProof = await createDpopProof({
      ...expensesAKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    const assertionReplay = await rawRequest(assertion, freshProof);
    expect(assertionReplay.status).toBe(400);
    await expect(assertionReplay.json()).resolves.toMatchObject({ error: "invalid_client" });

    const secondAssertion = await createWorkloadClientAssertion({
      clientId,
      tokenEndpoint: WELDALL_TOKEN_ENDPOINT,
      kid: "expenses-a-current",
      privateJwk: expensesAKey.privateJwk,
    });
    const replayedProof = await createDpopProof({
      ...expensesAKey,
      method: "POST",
      url: WELDALL_TOKEN_ENDPOINT,
    });
    expect((await rawRequest(secondAssertion, replayedProof)).status).toBe(200);
    const thirdAssertion = await createWorkloadClientAssertion({
      clientId,
      tokenEndpoint: WELDALL_TOKEN_ENDPOINT,
      kid: "expenses-a-current",
      privateJwk: expensesAKey.privateJwk,
    });
    const dpopReplay = await rawRequest(thirdAssertion, replayedProof);
    expect(dpopReplay.status).toBe(400);
    await expect(dpopReplay.json()).resolves.toMatchObject({ error: "invalid_dpop_proof" });

    const { db } = await import("@weldall/db");
    const replayAudit = await db.auditEvent.findFirstOrThrow({
      where: {
        clientId,
        eventType: "workload_token.denied",
        reasonCode: "replay_detected",
      },
      orderBy: { occurredAt: "desc" },
    });
    expect(JSON.stringify(replayAudit)).not.toContain(assertion);
    expect(JSON.stringify(replayAudit)).not.toContain(replayedProof);
  });

  it("issues the documented distinct workload token profile", async () => {
    const issued = await obtain();
    const { decodeJwt, decodeProtectedHeader } = await import("jose");
    expect(decodeProtectedHeader(issued.accessToken).typ).toBe(WORKLOAD_TOKEN_TYP);
    expect(decodeJwt(issued.accessToken)).toMatchObject({
      iss: WELDALL_ISSUER,
      sub: `workload:${clientId}`,
      client_id: clientId,
      azp: clientId,
      aud: resourceIdentifier,
      identity_type: "workload",
      token_type: "workload",
      scope: readScopeKey,
      cnf: { jkt: expensesAKey.jkt },
      iat: expect.any(Number),
      exp: expect.any(Number),
      jti: expect.any(String),
    });
  });

  it("prevents one public key from representing two workload identities", async () => {
    const { createWorkloadClient } = await import("../src/server/workloads/service.js");
    await expect(
      createWorkloadClient(
        {
          clientId: duplicateKeyClientId,
          name: "Duplicate key workload",
          key: { kid: "duplicate-key", publicJwk: expensesAKey.publicJwk },
          access: { resourceIds: [], scopeIds: [] },
        },
        { id: actorId, requestId: `duplicate-key-${randomUUID()}` },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const { db } = await import("@weldall/db");
    await expect(
      db.workloadClient.count({ where: { clientId: duplicateKeyClientId } }),
    ).resolves.toBe(0);
  });

  it("supports overlapping rotation and explicit retirement of the old key", async () => {
    const replacement = await generateEs256KeyPair();
    const { registerWorkloadKey, revokeWorkloadKey } =
      await import("../src/server/workloads/service.js");
    await registerWorkloadKey(
      {
        clientId: workloadDatabaseId,
        kid: "expenses-a-next",
        publicJwk: replacement.publicJwk,
      },
      { id: actorId, requestId: `rotate-${randomUUID()}` },
    );
    await expect(obtain()).resolves.toMatchObject({ tokenType: "DPoP" });
    await expect(
      obtain([readScopeKey], resourceIdentifier, replacement, "expenses-a-next"),
    ).resolves.toMatchObject({ tokenType: "DPoP" });

    await revokeWorkloadKey(
      { clientId: workloadDatabaseId, keyId: workloadKeyId },
      { id: actorId, requestId: `retire-${randomUUID()}` },
    );
    await expect(obtain()).rejects.toMatchObject({ code: "invalid_client" });
    await expect(
      obtain([readScopeKey], resourceIdentifier, replacement, "expenses-a-next"),
    ).resolves.toMatchObject({ tokenType: "DPoP" });
  });
});
