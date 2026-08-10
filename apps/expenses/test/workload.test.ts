import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKLOAD_TOKEN_TYP,
  createDpopProof,
  generateEs256KeyPair,
  inMemory,
  signEs256,
  type DpopKeyPair,
} from "@weldall/sdk";
import { createExpensesBWorkloadApp } from "../src/workload.js";

const issuer = "https://weldall.example";
const origin = "https://expenses-b.example";
const resource = `${origin}/api`;
let issuerKey: DpopKeyPair;
let expensesAKey: DpopKeyPair;

beforeEach(async () => {
  issuerKey = await generateEs256KeyPair();
  expensesAKey = await generateEs256KeyPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `${issuer}/.well-known/oauth-authorization-server`)
        return Response.json({ issuer, jwks_uri: `${issuer}/api/oauth/jwks` });
      if (url === `${issuer}/api/oauth/jwks`)
        return Response.json({
          keys: [{ ...issuerKey.publicJwk, kid: "w1", alg: "ES256", use: "sig" }],
        });
      return new Response(null, { status: 404 });
    }),
  );
});

async function accessToken(scopes: string[]) {
  const now = Math.floor(Date.now() / 1_000);
  return signEs256(
    {
      iss: issuer,
      sub: "workload:expenses-a",
      client_id: "expenses-a",
      azp: "expenses-a",
      aud: resource,
      scope: scopes.join(" "),
      identity_type: "workload",
      token_type: "workload",
      cnf: { jkt: expensesAKey.jkt },
      iat: now,
      exp: now + 300,
      jti: crypto.randomUUID(),
    },
    { kid: "w1", privateJwk: issuerKey.privateJwk, typ: WORKLOAD_TOKEN_TYP },
  );
}

async function headers(token: string, method = "GET") {
  const url = `${resource}/internal/expenses`;
  const proof = await createDpopProof({ ...expensesAKey, method, url, accessToken: token });
  return { authorization: `DPoP ${token}`, dpop: proof };
}

describe("Expenses B workload route", () => {
  it("accepts Expenses A without a user and rejects proof replay", async () => {
    const app = createExpensesBWorkloadApp({
      weldallIssuer: issuer,
      resource,
      publicOrigin: origin,
      allowedClientIds: ["expenses-a"],
      replayStore: inMemory({ suppressWarning: true }),
    });
    const token = await accessToken(["expenses:read"]);
    const requestHeaders = await headers(token);
    const accepted = await app.request("/api/internal/expenses", { headers: requestHeaders });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      caller: "expenses-a",
      identityType: "workload",
    });
    expect((await app.request("/api/internal/expenses", { headers: requestHeaders })).status).toBe(
      401,
    );
  });

  it("rejects a valid workload token without the route scope", async () => {
    const app = createExpensesBWorkloadApp({
      weldallIssuer: issuer,
      resource,
      publicOrigin: origin,
      allowedClientIds: ["expenses-a"],
      replayStore: inMemory({ suppressWarning: true }),
    });
    const token = await accessToken(["expenses:create"]);
    expect(
      (await app.request("/api/internal/expenses", { headers: await headers(token) })).status,
    ).toBe(403);
  });
});
