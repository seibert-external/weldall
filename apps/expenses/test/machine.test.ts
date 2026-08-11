import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MACHINE_TOKEN_TYP,
  createDpopProof,
  generateEs256KeyPair,
  signEs256,
  type DpopKeyPair,
} from "@weldall/sdk";
import { EXPENSES_ISSUER, EXPENSES_RESOURCE, WELDALL_ISSUER } from "../src/constants.js";

let issuerKey: DpopKeyPair;
let expensesKey: DpopKeyPair;
let machineKey: DpopKeyPair;

beforeEach(async () => {
  issuerKey = await generateEs256KeyPair();
  expensesKey = await generateEs256KeyPair();
  machineKey = await generateEs256KeyPair();
  Object.assign(process.env, {
    WELDALL_SIGNING_PRIVATE_JWK: JSON.stringify(issuerKey.privateJwk),
    WELDALL_SIGNING_PUBLIC_JWK: JSON.stringify(issuerKey.publicJwk),
    WELDALL_SIGNING_KID: "weldall-1",
    EXPENSES_SIGNING_PRIVATE_JWK: JSON.stringify(expensesKey.privateJwk),
    EXPENSES_SIGNING_PUBLIC_JWK: JSON.stringify(expensesKey.publicJwk),
    EXPENSES_SIGNING_KID: "expenses-1",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `${WELDALL_ISSUER}/.well-known/oauth-authorization-server`)
        return Response.json({
          issuer: WELDALL_ISSUER,
          jwks_uri: `${WELDALL_ISSUER}/.well-known/jwks.json`,
        });
      if (url === `${WELDALL_ISSUER}/.well-known/jwks.json`)
        return Response.json({
          keys: [{ ...issuerKey.publicJwk, kid: "weldall-1", alg: "ES256", use: "sig" }],
        });
      return new Response(null, { status: 404 });
    }),
  );
});

async function machineToken(scopes: string[]) {
  const now = Math.floor(Date.now() / 1_000);
  return signEs256(
    {
      iss: WELDALL_ISSUER,
      sub: "machine:expenses-a",
      client_id: "expenses-a",
      azp: "expenses-a",
      aud: EXPENSES_RESOURCE,
      scope: scopes.join(" "),
      identity_type: "machine",
      token_type: "machine",
      cnf: { jkt: machineKey.jkt },
      iat: now,
      exp: now + 300,
      jti: crypto.randomUUID(),
    },
    { kid: "weldall-1", privateJwk: issuerKey.privateJwk, typ: MACHINE_TOKEN_TYP },
  );
}

async function headers(token: string) {
  const proof = await createDpopProof({
    ...machineKey,
    method: "GET",
    url: `${EXPENSES_ISSUER}/api/expenses`,
    accessToken: token,
  });
  return { authorization: `DPoP ${token}`, dpop: proof };
}

describe("Expenses unified protected route", () => {
  it("accepts a machine by default through the same scope-only route and rejects proof replay", async () => {
    const { createApp } = await import("../src/app.js");
    const app = await createApp();
    const token = await machineToken(["expenses:read"]);
    const requestHeaders = await headers(token);

    const accepted = await app.request("/api/expenses", { headers: requestHeaders });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      requestedBy: "expenses-a",
      identityType: "machine",
      subject: "machine:expenses-a",
    });
    expect((await app.request("/api/expenses", { headers: requestHeaders })).status).toBe(401);
  });

  it("applies the same route scope policy to machine callers", async () => {
    const { createApp } = await import("../src/app.js");
    const app = await createApp();
    const token = await machineToken(["expenses:create"]);
    expect((await app.request("/api/expenses", { headers: await headers(token) })).status).toBe(
      403,
    );
  });
});
