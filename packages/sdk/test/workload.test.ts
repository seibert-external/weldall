import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  WORKLOAD_TOKEN_TYP,
  createDpopProof,
  createWorkloadClientAssertion,
  generateEs256KeyPair,
  inMemory,
  initWorkloadVerifier,
  requestWorkloadToken,
  signEs256,
  type DpopKeyPair,
} from "../src/index.js";

const issuer = "https://weldall.example";
const origin = "https://expenses-b.example";
const resource = `${origin}/api`;
let weldallKey: DpopKeyPair;
let workloadKey: DpopKeyPair;

beforeEach(async () => {
  weldallKey = await generateEs256KeyPair();
  workloadKey = await generateEs256KeyPair();
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

async function token(patch: Record<string, unknown> = {}, typ = WORKLOAD_TOKEN_TYP) {
  const now = Math.floor(Date.now() / 1_000);
  return signEs256(
    {
      iss: issuer,
      sub: "workload:expenses-a",
      client_id: "expenses-a",
      azp: "expenses-a",
      aud: resource,
      scope: "expenses:read",
      identity_type: "workload",
      token_type: "workload",
      cnf: { jkt: workloadKey.jkt },
      iat: now,
      exp: now + 300,
      jti: `token-${crypto.randomUUID()}`,
      ...patch,
    },
    { kid: "w1", privateJwk: weldallKey.privateJwk, typ },
  );
}

const verifier = () =>
  initWorkloadVerifier(issuer, {
    resource,
    publicOrigin: origin,
    supportedScopes: ["expenses:read", "expenses:create"],
    allowedClientIds: ["expenses-a"],
    replayStore: inMemory({ suppressWarning: true }),
  });

async function request(accessToken: string, key = workloadKey, method = "GET") {
  const url = `${resource}/expenses`;
  const proof = await createDpopProof({ ...key, method, url, accessToken });
  return new Request(url, {
    method,
    headers: { authorization: `DPoP ${accessToken}`, dpop: proof },
  });
}

describe("workload client and target SDK", () => {
  it("creates a strict RFC 7523 assertion without private material in claims", async () => {
    const assertion = await createWorkloadClientAssertion({
      clientId: "expenses-a",
      tokenEndpoint: `${issuer}/api/auth/oauth2/token`,
      kid: "a1",
      privateJwk: workloadKey.privateJwk,
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
    expect(JSON.stringify(decodeJwt(assertion))).not.toContain(workloadKey.privateJwk.d);
  });

  it("requests a DPoP-bound client-credentials token", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form).toMatchObject(expect.any(URLSearchParams));
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
      requestWorkloadToken({
        issuer,
        clientId: "expenses-a",
        resource: "https://expenses-b.example:443/api",
        scopes: ["expenses:read"],
        kid: "a1",
        key: workloadKey,
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
      key: workloadKey,
    };
    await expect(
      requestWorkloadToken({
        ...base,
        fetch: (async () =>
          Response.json({ error: "invalid_scope" }, { status: 400 })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid_scope", status: 400 });
    await expect(
      requestWorkloadToken({
        ...base,
        fetch: (async () =>
          Response.json({ access_token: "token", token_type: "Bearer" })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "server_error", status: 500 });
    await expect(
      requestWorkloadToken({ ...base, resource: `${resource}?tenant=one` }),
    ).rejects.toThrow("resource must be an origin without credentials, path, query, or fragment");
  });

  it("accepts Expenses A and rejects replay and missing target scope", async () => {
    const instance = verifier();
    const accessToken = await token();
    const first = await request(accessToken);
    await expect(instance.verify(first, { scopes: ["expenses:read"] })).resolves.toMatchObject({
      identityType: "workload",
      subject: "workload:expenses-a",
      clientId: "expenses-a",
    });
    const replay = await instance.verifyNoThrow(first);
    expect(replay.ok).toBe(false);
    if (!replay.ok)
      expect(replay.error).toMatchObject({ code: "invalid_dpop_proof", reason: "replay_detected" });
    await expect(
      instance.verify(await request(accessToken), { scopes: ["expenses:create"] }),
    ).rejects.toMatchObject({
      code: "insufficient_scope",
      status: 403,
    });
  });

  it("rejects wrong audience, workload identity mismatch, and token-type confusion", async () => {
    for (const accessToken of [
      await token({ aud: "https://wrong.example/api" }),
      await token({ sub: "user-1" }),
      await token({ token_type: "user" }),
      await token({}, "at+jwt"),
    ]) {
      await expect(verifier().verify(await request(accessToken))).rejects.toMatchObject({
        code: "invalid_token",
        status: 401,
      });
    }
  });

  it("rejects a proof signed by a different workload key", async () => {
    const attacker = await generateEs256KeyPair();
    const accessToken = await token();
    await expect(verifier().verify(await request(accessToken, attacker))).rejects.toMatchObject({
      code: "invalid_dpop_proof",
      status: 401,
    });
  });

  it("requires target-local workload allowlisting and replay protection", () => {
    expect(() =>
      initWorkloadVerifier(issuer, {
        resource,
        publicOrigin: origin,
        supportedScopes: ["expenses:read"],
        allowedClientIds: [],
        replayStore: inMemory({ suppressWarning: true }),
      }),
    ).toThrow("allowedClientIds");
    expect(() =>
      initWorkloadVerifier(issuer, {
        resource,
        publicOrigin: origin,
        supportedScopes: ["expenses:read"],
        allowedClientIds: ["expenses-a"],
        replayStore: "disabled" as never,
      }),
    ).toThrow("replay protection");
  });
});
