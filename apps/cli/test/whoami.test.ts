import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateEs256KeyPair } from "@weldall/sdk";
import type { WeldallConfig } from "../src/config.js";
import { CliError } from "../src/errors.js";

const state = vi.hoisted(() => ({ session: null as any }));
vi.mock("../src/services/session-manager.js", () => ({
  SessionManager: class {
    getAccessSession = async () => state.session;
  },
}));

const { whoAmI } = await import("../src/services/auth.js");

const issuer = "https://weldall.example.com";
const config: WeldallConfig = {
  issuer,
  resource: `${issuer}/api`,
  authorize: `${issuer}/api/auth/oauth2/authorize`,
  token: `${issuer}/api/auth/oauth2/token`,
  revoke: `${issuer}/api/auth/oauth2/revoke`,
  jwks: `${issuer}/api/oauth/jwks`,
  cli: `${issuer}/api/me/cli`,
  grants: `${issuer}/api/me/grants`,
  scopes: `${issuer}/api/me/scopes`,
  skills: `${issuer}/api/me/skills`,
  userInfo: `${issuer}/api/auth/oauth2/userinfo`,
};

beforeEach(async () => {
  const key = await generateEs256KeyPair();
  state.session = {
    accessToken: "access-a",
    subject: "account-a",
    expiresAt: Math.floor(Date.now() / 1_000) + 600,
    credentials: { version: 2, issuer, ...key, refreshToken: "refresh-a" },
  };
  vi.unstubAllGlobals();
});

describe("whoami", () => {
  it("asks for a new login when userinfo refuses the saved sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "invalid_token", error_description: "Invalid access token" },
          { status: 401 },
        ),
      ),
    );

    const error = await whoAmI(config).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe(
      "Weldall userinfo request failed with HTTP 401: Invalid access token",
    );
    expect((error as CliError).hint).toBe(
      "Weldall no longer accepts this sign-in. Run `weldall login` to sign in again.",
    );
  });

  it("keeps other userinfo failures as they are", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );

    const error = await whoAmI(config).catch((caught: unknown) => caught);

    expect((error as CliError).message).toBe(
      "Weldall userinfo request failed with HTTP 503: unavailable",
    );
    expect((error as CliError).hint).toBeUndefined();
  });
});
