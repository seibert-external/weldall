import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateEs256KeyPair } from "@weldall/sdk";
import { enforceCliConsent } from "../src/server/auth/consent.js";
import {
  WELDALL_CLIENT_ID,
  WELDALL_ISSUER,
  WELDALL_RESOURCE,
} from "../src/server/oauth/constants.js";

describe("Better Auth DPoP replay patch", () => {
  it.each([undefined, "none", "login"])(
    "forces CLI consent server-side when prompt is %s",
    (prompt) => {
      const url = new URL(`${WELDALL_ISSUER}/api/auth/oauth2/authorize`);
      url.searchParams.set("client_id", WELDALL_CLIENT_ID);
      if (prompt) url.searchParams.set("prompt", prompt);
      const enforced = enforceCliConsent(new Request(url));
      expect(new URL(enforced.url).searchParams.get("prompt")).toBe("consent");
    },
  );

  it("does not rewrite unrelated authorization clients", () => {
    const url = new URL(`${WELDALL_ISSUER}/api/auth/oauth2/authorize`);
    url.searchParams.set("client_id", "other-client");
    const request = new Request(url);
    expect(enforceCliConsent(request)).toBe(request);
  });

  it("uses one process-local replay store at every provider DPoP call site", async () => {
    const providerEntry = fileURLToPath(import.meta.resolve("@better-auth/oauth-provider"));
    const source = await readFile(providerEntry, "utf8");

    expect(source).toContain("const weldallDpopReplayStore = createInMemoryDpopReplayStore();");
    expect(source.match(/replayStore: weldallDpopReplayStore/g)).toHaveLength(2);
    expect(source).not.toContain("replayStore: createDpopReplayStore(");
  });

  it("loads the migrated public client and accepts an ephemeral loopback port", async () => {
    const signingKey = await generateEs256KeyPair();
    Object.assign(process.env, {
      POSTGRES_URL: process.env.POSTGRES_URL ?? "postgresql://postgres@localhost:5433/postgres",
      BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-characters",
      OAUTH_PROXY_SECRET: "test-oauth-proxy-secret-at-least-32-characters",
      ENABLE_DEV_LOGIN: "false",
      GOOGLE_CLIENT_ID: "google-test-client",
      GOOGLE_CLIENT_SECRET: "google-test-secret",
      WELDALL_SIGNING_PRIVATE_JWK: JSON.stringify(signingKey.privateJwk),
      WELDALL_SIGNING_PUBLIC_JWK: JSON.stringify(signingKey.publicJwk),
      WELDALL_SIGNING_KID: "weldall-provider-test",
    });
    const { db } = await import("@weldall/db");
    await expect(
      db.oauthClient.findUniqueOrThrow({ where: { clientId: WELDALL_CLIENT_ID } }),
    ).resolves.toMatchObject({ skipConsent: false });

    const deviceKey = await generateEs256KeyPair();
    const authorize = new URL(`${WELDALL_ISSUER}/api/auth/oauth2/authorize`);
    Object.entries({
      response_type: "code",
      client_id: WELDALL_CLIENT_ID,
      redirect_uri: "http://127.0.0.1:43123/callback",
      scope: "openid profile email offline_access weldall:scopes",
      state: "test-state",
      nonce: "test-nonce",
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
      resource: WELDALL_RESOURCE,
      dpop_jkt: deviceKey.jkt,
    }).forEach(([name, value]) => authorize.searchParams.set(name, value));

    const { auth } = await import("../src/server/auth/auth.js");
    const response = await auth.handler(new Request(authorize));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/login");
  });
});
