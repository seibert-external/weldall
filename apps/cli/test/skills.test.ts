import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateEs256KeyPair } from "@weldall/sdk";
import type { WeldallConfig } from "../src/config.js";

const state = vi.hoisted(() => ({ session: null as any }));
vi.mock("../src/services/auth.js", () => ({
  withAccess: async (_config: unknown, operation: (session: unknown) => Promise<unknown>) =>
    operation(state.session),
}));

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
    credentials: {
      version: 2,
      issuer,
      ...key,
      refreshToken: "refresh-a",
      accessSession: {
        accessToken: "access-a",
        subject: "account-a",
        expiresAt: Math.floor(Date.now() / 1_000) + 600,
      },
    },
  };
  vi.unstubAllGlobals();
});

describe("skill cache identity binding", () => {
  it("returns the subject that authenticated the request during session replacement", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await blocked;
        return Response.json({
          items: [
            {
              slug: "expenses.review",
              title: "Review expenses",
              preview: "Review submitted company expenses.",
              requiredScopes: ["expenses:read"],
              visibility: "DEFAULT",
              available: true,
              missingScopes: [],
              updatedAt: "2026-01-01T00:00:00.000Z",
              source: { type: "admin" },
            },
          ],
          warnings: [],
        });
      }),
    );
    const { listSkillsWithSubject } = await import("../src/services/skills.js");

    const pending = listSkillsWithSubject(config);
    state.session = { ...state.session, subject: "account-b" };
    release();

    await expect(pending).resolves.toMatchObject({
      subject: "account-a",
      result: { items: [{ slug: "expenses.review" }] },
    });
  });
});
