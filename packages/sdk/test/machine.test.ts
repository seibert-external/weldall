import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  MACHINE_TOKEN_TYP,
  createDpopProof,
  createMachineClientAssertion,
  generateEs256KeyPair,
  inMemory,
  initWeldall,
  requestMachineToken,
  signEs256,
  type DpopKeyPair,
  type ReplayStore,
} from "../src/index.js";

const issuer = "https://weldall.example";
const origin = "https://expenses-b.example";
const resource = `${origin}/api`;
let weldallKey: DpopKeyPair;
let resourceKey: DpopKeyPair;
let machineKey: DpopKeyPair;

beforeEach(async () => {
  weldallKey = await generateEs256KeyPair();
  resourceKey = await generateEs256KeyPair();
  machineKey = await generateEs256KeyPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `${issuer}/.well-known/oauth-authorization-server`)
        return Response.json({ issuer, jwks_uri: `${issuer}/api/oauth/jwks` });
      if (url === `${issuer}/api/oauth/jwks`)
        return Response.json({
          keys: [{ ...weldallKey.publicJwk, kid: "w1", alg: "ES256", use: "sig" }],
        });
      return new Response(null, { status: 404 });
    }),
  );
});

async function token(patch: Record<string, unknown> = {}, typ = MACHINE_TOKEN_TYP) {
  const now = Math.floor(Date.now() / 1_000);
  return signEs256(
    {
      iss: issuer,
      sub: "machine:expenses-a",
      client_id: "expenses-a",
      azp: "expenses-a",
      aud: resource,
      scope: "expenses:read",
      identity_type: "machine",
      token_type: "machine",
      cnf: { jkt: machineKey.jkt },
      iat: now,
      exp: now + 300,
      jti: `token-${crypto.randomUUID()}`,
      ...patch,
    },
    { kid: "w1", privateJwk: weldallKey.privateJwk, typ },
  );
}

const verifier = (replayStore: ReplayStore | "disabled" = inMemory({ suppressWarning: true })) =>
  initWeldall(issuer, {
    resource,
    publicOrigin: origin,
    clientId: "expenses-b",
    supportedScopes: ["expenses:read", "expenses:create"],
    signingKey: {
      kid: "resource-1",
      privateJwk: resourceKey.privateJwk,
      publicJwk: resourceKey.publicJwk,
    },
    replayStore,
  });

async function request(accessToken: string, key = machineKey, method = "GET") {
  const url = `${resource}/expenses`;
  const proof = await createDpopProof({ ...key, method, url, accessToken });
  return new Request(url, {
    method,
    headers: { authorization: `DPoP ${accessToken}`, dpop: proof },
  });
}

describe("machine client and unified resource SDK", () => {
  it("does not expose a parallel machine resource-authentication API", async () => {
    const sdk = await import("../src/index.js");
    const hono = await import("../src/hono.js");
    expect(sdk).not.toHaveProperty("initMachineVerifier");
    expect(hono).not.toHaveProperty("initMachineAuth");
    expect(hono).not.toHaveProperty("protectMachine");
    expect(hono).not.toHaveProperty("getMachineAuth");
  });

  it("creates a strict RFC 7523 assertion without private material in claims", async () => {
    const assertion = await createMachineClientAssertion({
      clientId: "expenses-a",
      tokenEndpoint: `${issuer}/api/auth/oauth2/token`,
      kid: "a1",
      privateJwk: machineKey.privateJwk,
      jti: "assertion-1",
      now: 1_000,
    });
    expect(decodeProtectedHeader(assertion)).toMatchObject({ alg: "ES256", typ: "JWT", kid: "a1" });
    expect(decodeJwt(assertion)).toMatchObject({
      iss: "expenses-a",
      sub: "expenses-a",
      aud: `${issuer}/api/auth/oauth2/token`,
      iat: 1_000,
      exp: 1_060,
      jti: "assertion-1",
    });
    expect(JSON.stringify(decodeJwt(assertion))).not.toContain(machineKey.privateJwk.d);
  });

  it("requests a DPoP-bound client-credentials token", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("grant_type")).toBe("client_credentials");
      expect(form.get("client_id")).toBe("expenses-a");
      expect(form.get("client_assertion")).not.toBeNull();
      expect(form.get("resource")).toBe(resource);
      expect(new Headers(init?.headers).get("dpop")).toBeTruthy();
      return Response.json({
        access_token: "opaque-for-helper-test",
        token_type: "DPoP",
        expires_in: 300,
        scope: "expenses:read",
      });
    });
    await expect(
      requestMachineToken({
        issuer,
        clientId: "expenses-a",
        resource: "https://expenses-b.example:443/api",
        scopes: ["expenses:read"],
        kid: "a1",
        key: machineKey,
        fetch: fetcher as typeof fetch,
      }),
    ).resolves.toMatchObject({ tokenType: "DPoP", expiresIn: 300 });
  });

  it("rejects OAuth errors, malformed success responses, and resource queries", async () => {
    const base = {
      issuer,
      clientId: "expenses-a",
      resource,
      scopes: ["expenses:read"],
      kid: "a1",
      key: machineKey,
    };
    await expect(
      requestMachineToken({
        ...base,
        fetch: (async () =>
          Response.json({ error: "invalid_scope" }, { status: 400 })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid_scope", status: 400 });
    await expect(
      requestMachineToken({
        ...base,
        fetch: (async () =>
          Response.json({ access_token: "token", token_type: "Bearer" })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "server_error", status: 500 });
    await expect(
      requestMachineToken({ ...base, resource: `${resource}?tenant=one` }),
    ).rejects.toThrow("resource must be an origin without credentials, path, query, or fragment");
  });

  it("accepts machines by default, returns a discriminated principal, and rejects proof replay", async () => {
    const instance = verifier();
    const accessToken = await token();
    const first = await request(accessToken);
    await expect(instance.verify(first, { scopes: ["expenses:read"] })).resolves.toMatchObject({
      identityType: "machine",
      identity: { type: "machine", subject: "machine:expenses-a", clientId: "expenses-a" },
      clientId: "expenses-a",
    });
    const replay = await instance.verifyNoThrow(first);
    expect(replay.ok).toBe(false);
    if (!replay.ok)
      expect(replay.error).toMatchObject({ code: "invalid_dpop_proof", reason: "replay_detected" });
    await expect(
      instance.verify(await request(accessToken), { scopes: ["expenses:create"] }),
    ).rejects.toMatchObject({ code: "insufficient_scope", status: 403 });
  });

  it("keeps replayStore disabled valid and skips resource-side replay consumption", async () => {
    const instance = verifier("disabled");
    const accessToken = await token();
    const repeated = await request(accessToken);
    await expect(instance.verify(repeated)).resolves.toMatchObject({ identityType: "machine" });
    await expect(instance.verify(repeated)).resolves.toMatchObject({ identityType: "machine" });
  });

  it("fails closed when the bounded replay store reaches capacity", async () => {
    const instance = verifier(inMemory({ maxEntries: 1, suppressWarning: true }));
    await expect(instance.verify(await request(await token()))).resolves.toMatchObject({
      identityType: "machine",
    });
    const result = await instance.verifyNoThrow(await request(await token()));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({ code: "temporarily_unavailable", status: 503 });
  });

  it("dispatches by exact typ without profile fallback or token confusion", async () => {
    const instance = verifier();
    await expect(
      instance.verify(await request(await token({}, "unknown+jwt"))),
    ).rejects.toMatchObject({ code: "invalid_token" });
    await expect(
      instance.verify(await request(await token({}, "oauth-id-jag+jwt"))),
    ).rejects.toMatchObject({ code: "invalid_token" });
    await expect(instance.verify(await request(await token({}, "at+jwt")))).rejects.toMatchObject({
      code: "invalid_token",
    });
    await expect(
      instance.verify(
        await request(await token({ identity_type: "user", email: "a@example.com" })),
      ),
    ).rejects.toMatchObject({ code: "invalid_token" });
    await expect(
      instance.verify(await request(await token({ email: "a@example.com", email_verified: true }))),
    ).rejects.toMatchObject({ code: "invalid_token" });

    const now = Math.floor(Date.now() / 1_000);
    const confusedUserToken = await signEs256(
      {
        iss: origin,
        sub: "machine:expenses-a",
        email: "a@example.com",
        email_verified: true,
        client_id: "expenses-b",
        aud: resource,
        scope: "expenses:read",
        identity_type: "machine",
        token_type: "machine",
        cnf: { jkt: machineKey.jkt },
        iat: now,
        exp: now + 600,
        jti: crypto.randomUUID(),
      },
      { kid: "resource-1", privateJwk: resourceKey.privateJwk, typ: "at+jwt" },
    );
    await expect(instance.verify(await request(confusedUserToken))).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("rejects machine proofs with the wrong method, URL, or access-token hash", async () => {
    const instance = verifier();
    const accessToken = await token();
    const url = `${resource}/expenses`;
    for (const proof of [
      await createDpopProof({ ...machineKey, method: "POST", url, accessToken }),
      await createDpopProof({
        ...machineKey,
        method: "GET",
        url: `${resource}/other`,
        accessToken,
      }),
      await createDpopProof({ ...machineKey, method: "GET", url }),
    ]) {
      await expect(
        instance.verify(
          new Request(url, {
            headers: { authorization: `DPoP ${accessToken}`, dpop: proof },
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid_dpop_proof" });
    }
  });

  it("rejects wrong audience and a proof signed by another machine key", async () => {
    const instance = verifier();
    await expect(
      instance.verify(await request(await token({ aud: "https://other.example/api" }))),
    ).rejects.toMatchObject({ code: "invalid_token" });
    await expect(
      instance.verify(await request(await token({ iss: "https://other.example" }))),
    ).rejects.toMatchObject({ code: "invalid_token" });
    const attacker = await generateEs256KeyPair();
    const accessToken = await token();
    await expect(instance.verify(await request(accessToken, attacker))).rejects.toMatchObject({
      code: "invalid_dpop_proof",
    });
  });
});
