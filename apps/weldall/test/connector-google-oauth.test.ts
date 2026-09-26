import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RejectedProviderCredentials } from "../src/server/connectors/errors";

const clientId = "test.apps.googleusercontent.com";
const nonce = "n".repeat(43);
const scopes = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.readonly",
].sort();
const config = {
  clientId,
  allowedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  defaultScopes: [],
};
const secrets = { clientSecret: "private-client-secret" };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: Awaited<ReturnType<typeof exportJWK>>[] };
let provider: (typeof import("../src/server/connectors/providers/google"))["googleProvider"];
let tokenResponse: Record<string, unknown>;
let tokenStatus: number;
let jwksStatus: number;
let revokeStatus: number;
const fetcher = vi.fn<typeof fetch>();

async function identityToken(claims: JWTPayload = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: "https://accounts.google.com",
    aud: clientId,
    sub: "google-account",
    iat: now,
    exp: now + 300,
    nonce,
    email: "owner@example.com",
    email_verified: true,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .sign(keys.privateKey);
}
const complete = () =>
  provider.completeAuthorization({
    config,
    secrets,
    selection: { scopes },
    callback: new URLSearchParams({ code: "private-code" }),
    attempt: { verifier: "v".repeat(43), nonce },
    callbackUrl: "https://weldall.example.com/api/connectors/google/callback",
  });
async function rejectedCredentials() {
  const error: unknown = await complete().catch((error: unknown) => error);
  expect(error).toMatchObject({ code: "identity_unverified" });
  expect(error).not.toHaveProperty("cause");
  expect(JSON.stringify(error)).not.toMatch(/private-access|private-refresh|private-client-secret/);
  const credentials = (error as RejectedProviderCredentials).credentials;
  expect(() => provider.parseCredentials(credentials)).toThrow();
  return credentials;
}

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "RS256" }] };
});
beforeEach(async () => {
  // Each case gets a fresh remote-JWKS cache while exercising real JOSE verification.
  vi.resetModules();
  provider = (await import("../src/server/connectors/providers/google")).googleProvider;
  tokenStatus = 200;
  jwksStatus = 200;
  revokeStatus = 200;
  tokenResponse = {
    access_token: "private-access",
    refresh_token: "private-refresh",
    expires_in: 3600,
    token_type: "Bearer",
    scope: scopes.join(" "),
    id_token: await identityToken(),
  };
  fetcher.mockReset().mockImplementation(async (target) => {
    switch (String(target)) {
      case "https://oauth2.googleapis.com/token":
        return Response.json(tokenResponse, { status: tokenStatus });
      case "https://www.googleapis.com/oauth2/v3/certs":
        return Response.json(jwks, { status: jwksStatus });
      case "https://oauth2.googleapis.com/revoke":
        return new Response(null, { status: revokeStatus });
      default:
        throw new Error("Unexpected network request in Google OAuth test");
    }
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());

describe("Google identity verification and cleanup", () => {
  it("retains a revocation-only token when JWKS retrieval fails after successful issuance", async () => {
    jwksStatus = 503;
    const credentials = await rejectedCredentials();
    expect(credentials).toEqual({ revocationToken: "private-refresh" });
    expect(fetcher.mock.calls.map(([target]) => String(target))).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://www.googleapis.com/oauth2/v3/certs",
    ]);
    revokeStatus = 503;
    expect(await provider.disconnectGrant({ config, secrets, credentials })).toMatchObject({
      status: "unconfirmed",
    });
    revokeStatus = 200;
    expect(await provider.disconnectGrant({ config, secrets, credentials })).toEqual({
      status: "revoked",
    });
    const revocations = fetcher.mock.calls.filter(([target]) => String(target).endsWith("/revoke"));
    expect(revocations).toHaveLength(2);
    for (const [, init] of revocations) {
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect((init?.body as URLSearchParams).get("token")).toBe("private-refresh");
    }
  });

  it.each([
    ["nonce", { nonce: "another-browser" }],
    ["issuer", { iss: "https://attacker.example.com" }],
    ["audience", { aud: "another-client" }],
    ["expiry", { exp: 1 }],
    ["unverified email", { email_verified: false }],
    ["missing email", { email: undefined }],
    ["authorized party", { azp: "another-client" }],
  ])("keeps rejected %s grants out of executable credentials", async (_name, claims) => {
    tokenResponse.id_token = await identityToken(claims);
    expect(await rejectedCredentials()).toEqual({ revocationToken: "private-refresh" });
  });

  it("retains a cleanup token for malformed signatures", async () => {
    tokenResponse.id_token = `${String(tokenResponse.id_token).split(".").slice(0, 2).join(".")}.AAAA`;
    expect(await rejectedCredentials()).toEqual({ revocationToken: "private-refresh" });
  });

  it("retains the refresh token when the identity token is missing", async () => {
    delete tokenResponse.id_token;
    expect(await rejectedCredentials()).toEqual({ revocationToken: "private-refresh" });
  });

  it("can revoke an access-only grant without treating it as a ready connection", async () => {
    delete tokenResponse.refresh_token;
    const credentials = await rejectedCredentials();
    expect(credentials).toEqual({ revocationToken: "private-access" });
    expect(await provider.disconnectGrant({ config, secrets, credentials })).toEqual({
      status: "revoked",
    });
    expect((fetcher.mock.calls.at(-1)?.[1]?.body as URLSearchParams).get("token")).toBe(
      "private-access",
    );
  });

  it("still activates a verified identity with the exact requested grant", async () => {
    const result = await complete();
    expect(result).toMatchObject({
      accountId: "google-account",
      accountName: "owner@example.com",
      grant: { scopes },
      credentials: {
        accessToken: "private-access",
        refreshToken: "private-refresh",
        grantedScopes: scopes,
      },
    });
    expect(() => provider.parseCredentials(result.credentials)).not.toThrow();
  });

  it("does not invent cleanup credentials when token issuance fails", async () => {
    tokenStatus = 400;
    tokenResponse = { error: "invalid_grant" };
    const error: unknown = await complete().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "authorization_lost" });
    expect(error).not.toHaveProperty("credentials");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
