import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT, importJWK, type JWTPayload } from "jose";
import {
  PRIVATE_KEY_JWT_ASSERTION_TYPE,
  MACHINE_TOKEN_TYP,
  createDpopProof,
  createMachineClientAssertion,
  generateEs256KeyPair,
  inMemory,
  initWeldall,
  requestMachineToken,
  type DpopKeyPair,
} from "@weldall/sdk";
import { WELDALL_ISSUER, WELDALL_TOKEN_ENDPOINT } from "../src/server/oauth/constants.js";

vi.mock("../src/server/auth/auth.js", () => ({
  auth: { handler: vi.fn(async () => new Response(null, { status: 500 })) },
}));

const clientId = `expenses-a-${randomUUID()}`;
const duplicateKeyClientId = `expenses-duplicate-${randomUUID()}`;
const resourceIdentifier = `https://expenses-b-${randomUUID()}.example/api`;
const lockOrderResourceIdentifier = `https://expenses-lock-${randomUUID()}.example/api`;
const resourceOrigin = new URL(resourceIdentifier).origin;
const actorId = `machine-admin-${randomUUID()}`;
const readScopeKey = `expenses-test:read-${randomUUID()}`;
const createScopeKey = `expenses-test:create-${randomUUID()}`;
const unselectedScopeKey = `expenses-test:unselected-${randomUUID()}`;
let issuerKey: DpopKeyPair;
let resourceSigningKey: DpopKeyPair;
let expensesAKey: DpopKeyPair;
let machineDatabaseId: string;
let machineKeyId: string;
let resourceId: string;
let readScopeId: string;

beforeAll(async () => {
  issuerKey = await generateEs256KeyPair();
  resourceSigningKey = await generateEs256KeyPair();
  expensesAKey = await generateEs256KeyPair();
  Object.assign(process.env, {
    POSTGRES_URL: process.env.POSTGRES_URL ?? "postgresql://postgres@localhost:5433/postgres",
    BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-characters",
    OAUTH_PROXY_SECRET: "test-oauth-proxy-secret-at-least-32-characters",
    WELDALL_SIGNING_PRIVATE_JWK: JSON.stringify(issuerKey.privateJwk),
    WELDALL_SIGNING_PUBLIC_JWK: JSON.stringify(issuerKey.publicJwk),
    WELDALL_SIGNING_KID: "machine-e2e-weldall",
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
      name: "Expenses B machine target",
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
  const { createMachineClient } = await import("../src/server/machines/service.js");
  const client = await createMachineClient(
    {
      clientId,
      name: "Expenses A",
      key: { kid: "expenses-a-current", publicJwk: expensesAKey.publicJwk },
      access: { resourceIds: [resourceId], scopeIds: [readScope.id, createScope.id] },
    },
    { id: actorId, requestId: `create-${randomUUID()}` },
  );
  machineDatabaseId = client.id;
  machineKeyId = client.keys[0]!.id;
});

afterAll(async () => {
  const { db } = await import("@weldall/db");
  await db.auditEvent.deleteMany({
    where: { OR: [{ actorId }, { actorId: clientId }, { clientId }] },
  });
  await db.machineClient.deleteMany({
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
  return requestMachineToken({
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
          keys: [{ ...issuerKey.publicJwk, kid: "machine-e2e-weldall", alg: "ES256", use: "sig" }],
        });
      return new Response(null, { status: 404 });
    }),
  );
  return initWeldall(WELDALL_ISSUER, {
    resource: resourceIdentifier,
    publicOrigin: resourceOrigin,
    clientId: "expenses-b",
    supportedScopes: [readScopeKey, createScopeKey],
    signingKey: {
      kid: "expenses-b-signing",
      privateJwk: resourceSigningKey.privateJwk,
      publicJwk: resourceSigningKey.publicJwk,
    },
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

function machineTokenRequest(
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
  return tokenFacade(machineTokenRequest(assertion, proof, scopes, resource, requestId));
}

describe("Expenses A to Expenses B machine authentication", () => {
  it("registers Expenses A, obtains a token from Weldall, and enforces it at Expenses B", async () => {
    const issued = await obtain();
    const expensesB = targetVerifier();
    const accepted = await expensesB.verify(await targetRequest(issued.accessToken), {
      scopes: [readScopeKey],
    });
    expect(accepted).toMatchObject({
      clientId,
      identityType: "machine",
      identity: { type: "machine", clientId },
    });
    expect(issued.scope).toBe(readScopeKey);

    await expect(
      expensesB.verify(await targetRequest(issued.accessToken), { scopes: [createScopeKey] }),
    ).rejects.toMatchObject({ code: "insufficient_scope", status: 403 });

    const { db } = await import("@weldall/db");
    const event = await db.auditEvent.findFirstOrThrow({
      where: { actorId: clientId, eventType: "machine_token.issued" },
      orderBy: { occurredAt: "desc" },
    });
    expect(event).toMatchObject({ actorType: "machine", clientId, outcome: "success" });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(issued.accessToken);
    expect(serialized).not.toContain(expensesAKey.privateJwk.d);
  });

  it("rejects a resource-supported scope that is not selected for the machine", async () => {
    await expect(obtain([unselectedScopeKey])).rejects.toMatchObject({ code: "invalid_scope" });
  });

  it("rejects an unselected resource", async () => {
    const { db } = await import("@weldall/db");
    const unselectedResource = await db.downstreamResource.create({
      data: {
        key: `expenses-unselected-${randomUUID()}`,
        name: "Unselected machine target",
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
    const { getMachineClient, replaceMachineAccess } =
      await import("../src/server/machines/service.js");
    const before = await getMachineClient(machineDatabaseId);
    await replaceMachineAccess(
      {
        clientId: machineDatabaseId,
        resourceIds: [],
        scopeIds: before.access.scopeIds,
        expectedVersion: before.version,
      },
      { id: actorId, requestId: `remove-access-${randomUUID()}` },
    );
    await expect(obtain()).rejects.toMatchObject({ code: "invalid_target" });
    const removed = await getMachineClient(machineDatabaseId);
    await replaceMachineAccess(
      {
        clientId: machineDatabaseId,
        resourceIds: [resourceId],
        scopeIds: removed.access.scopeIds,
        expectedVersion: removed.version,
      },
      { id: actorId, requestId: `restore-access-${randomUUID()}` },
    );
  });

  it("does not let absent resource access become visible after its lock statement", async () => {
    const { db } = await import("@weldall/db");
    await db.machineAllowedResource.delete({
      where: {
        machineClientId_resourceId: { machineClientId: machineDatabaseId, resourceId },
      },
    });
    const assertion = await createMachineClientAssertion({
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

    const { getMachineClient, replaceMachineAccess } =
      await import("../src/server/machines/service.js");
    const current = await getMachineClient(machineDatabaseId);
    await replaceMachineAccess(
      {
        clientId: machineDatabaseId,
        resourceIds: [resourceId],
        scopeIds: current.access.scopeIds,
        expectedVersion: current.version,
      },
      { id: actorId, requestId: `restore-absent-access-${randomUUID()}` },
    );
    // Later access applies only to a fresh issuance transaction; the denied request above
    // cannot continue and observe the new row under READ COMMITTED. Its authenticated proof
    // remains consumed within this process despite that denial.
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
    const assertion = await createMachineClientAssertion({
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
    const assertion = await createMachineClientAssertion({
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
          if (event.eventType === "machine_token.issued") {
            auditEntered();
            await auditReleased;
          }
        },
      },
    );
    await enteredAudit;
    const { revokeMachineKey } = await import("../src/server/machines/service.js");
    let revocationCommitted = false;
    const revocation = revokeMachineKey(
      { clientId: machineDatabaseId, keyId: machineKeyId },
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
    await db.machineClientKey.update({
      where: { id: machineKeyId },
      data: { revokedAt: null, revokedBy: null },
    });
  });

  it("orders in-flight issuance before a concurrent access-policy replacement", async () => {
    const assertion = await createMachineClientAssertion({
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
    const issuance = tokenFacadeWithAuditWriter(machineTokenRequest(assertion, proof), {
      async write(event) {
        if (event.eventType === "machine_token.issued") {
          auditEntered();
          await auditReleased;
        }
      },
    });
    await enteredAudit;

    const { getMachineClient, replaceMachineAccess } =
      await import("../src/server/machines/service.js");
    const before = await getMachineClient(machineDatabaseId);
    let replacementCommitted = false;
    const replacement = replaceMachineAccess(
      {
        clientId: machineDatabaseId,
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

    await replaceMachineAccess(
      {
        clientId: machineDatabaseId,
        resourceIds: [resourceId],
        scopeIds: before.access.scopeIds,
        expectedVersion: removed.version,
      },
      { id: actorId, requestId: `restore-concurrent-access-${randomUUID()}` },
    );
  });

  it("rejects disabled clients and revoked keys", async () => {
    const { db } = await import("@weldall/db");
    await db.machineClient.update({
      where: { id: machineDatabaseId },
      data: { enabled: false, deactivatedAt: new Date() },
    });
    await expect(obtain()).rejects.toMatchObject({ code: "invalid_client" });
    await db.machineClient.update({
      where: { id: machineDatabaseId },
      data: { enabled: true, deactivatedAt: null },
    });

    await db.machineClientKey.update({
      where: { id: machineKeyId },
      data: { revokedAt: new Date() },
    });
    await expect(obtain()).rejects.toMatchObject({ code: "invalid_client" });
    await db.machineClientKey.update({ where: { id: machineKeyId }, data: { revokedAt: null } });
  });

  it("rejects malformed private_key_jwt claims and headers without leaking assertions", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const assertions = [
      await customAssertion({ aud: "https://wrong.example/token" }),
      await customAssertion({ iss: "other-machine" }),
      await customAssertion({ sub: "other-machine" }),
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
        eventType: "machine_token.denied",
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
      where: { requestId, eventType: "machine_token.denied" },
    });
    expect(audit).toMatchObject({
      actorType: "machine",
      actorId: clientId,
      clientId,
      subjectType: null,
      subjectId: null,
      metadata: expect.objectContaining({ audience: null }),
    });
    expect(JSON.stringify(audit)).not.toContain("forged-audit-line");
  });

  it("keeps replay markers after an authenticated policy denial", async () => {
    const assertion = await createMachineClientAssertion({
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
    const assertion = await createMachineClientAssertion({
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
    const auditFailure = await tokenFacadeWithAuditWriter(machineTokenRequest(assertion, proof), {
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

  it("completes parallel issuance with process-local replay protection", async () => {
    const responses = await Promise.all(
      Array.from({ length: 16 }, async () => {
        const assertion = await createMachineClientAssertion({
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
    const assertion = await createMachineClientAssertion({
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

    const secondAssertion = await createMachineClientAssertion({
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
    const thirdAssertion = await createMachineClientAssertion({
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
        eventType: "machine_token.denied",
        reasonCode: "replay_detected",
      },
      orderBy: { occurredAt: "desc" },
    });
    expect(JSON.stringify(replayAudit)).not.toContain(assertion);
    expect(JSON.stringify(replayAudit)).not.toContain(replayedProof);
  });

  it("issues the documented distinct machine token profile", async () => {
    const issued = await obtain();
    const { decodeJwt, decodeProtectedHeader } = await import("jose");
    expect(decodeProtectedHeader(issued.accessToken).typ).toBe(MACHINE_TOKEN_TYP);
    expect(decodeJwt(issued.accessToken)).toMatchObject({
      iss: WELDALL_ISSUER,
      sub: `machine:${clientId}`,
      client_id: clientId,
      azp: clientId,
      aud: resourceIdentifier,
      identity_type: "machine",
      token_type: "machine",
      scope: readScopeKey,
      cnf: { jkt: expensesAKey.jkt },
      iat: expect.any(Number),
      exp: expect.any(Number),
      jti: expect.any(String),
    });
  });

  it("prevents one public key from representing two machine identities", async () => {
    const { createMachineClient } = await import("../src/server/machines/service.js");
    await expect(
      createMachineClient(
        {
          clientId: duplicateKeyClientId,
          name: "Duplicate key machine",
          key: { kid: "duplicate-key", publicJwk: expensesAKey.publicJwk },
          access: { resourceIds: [], scopeIds: [] },
        },
        { id: actorId, requestId: `duplicate-key-${randomUUID()}` },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const { db } = await import("@weldall/db");
    await expect(
      db.machineClient.count({ where: { clientId: duplicateKeyClientId } }),
    ).resolves.toBe(0);
  });

  it("supports overlapping rotation and explicit retirement of the old key", async () => {
    const replacement = await generateEs256KeyPair();
    const { registerMachineKey, revokeMachineKey } =
      await import("../src/server/machines/service.js");
    await registerMachineKey(
      {
        clientId: machineDatabaseId,
        kid: "expenses-a-next",
        publicJwk: replacement.publicJwk,
      },
      { id: actorId, requestId: `rotate-${randomUUID()}` },
    );
    await expect(obtain()).resolves.toMatchObject({ tokenType: "DPoP" });
    await expect(
      obtain([readScopeKey], resourceIdentifier, replacement, "expenses-a-next"),
    ).resolves.toMatchObject({ tokenType: "DPoP" });

    await revokeMachineKey(
      { clientId: machineDatabaseId, keyId: machineKeyId },
      { id: actorId, requestId: `retire-${randomUUID()}` },
    );
    await expect(obtain()).rejects.toMatchObject({ code: "invalid_client" });
    await expect(
      obtain([readScopeKey], resourceIdentifier, replacement, "expenses-a-next"),
    ).resolves.toMatchObject({ tokenType: "DPoP" });
  });
});
