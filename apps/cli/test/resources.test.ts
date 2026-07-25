import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateEs256KeyPair, type ResourceRegistryEntry } from "@weldall/sdk";
import type { WeldallConfig } from "../src/config.js";

const EXPENSES_ISSUER = "https://expenses.seibert.localdev";
const EXPENSES_RESOURCE = `${EXPENSES_ISSUER}/api`;

const state = vi.hoisted(() => ({ session: null as any }));
vi.mock("../src/services/auth.js", () => ({
  withAccess: async (_config: unknown, operation: (session: unknown) => Promise<unknown>) =>
    operation(state.session),
}));
vi.mock("../src/storage/lock.js", () => ({
  withLock: async (operation: () => Promise<unknown>) => operation(),
}));

const config: WeldallConfig = {
  issuer: "https://weldall.example",
  resource: "https://weldall.example/api",
  authorize: "https://weldall.example/api/auth/oauth2/authorize",
  token: "https://weldall.example/api/auth/oauth2/token",
  revoke: "https://weldall.example/api/auth/oauth2/revoke",
  jwks: "https://weldall.example/api/oauth/jwks",
  cli: "https://weldall.example/api/me/cli",
  scopes: "https://weldall.example/api/me/scopes",
  skills: "https://weldall.example/api/me/skills",
  userInfo: "https://weldall.example/api/auth/oauth2/userinfo",
};
const expenses: ResourceRegistryEntry = {
  key: "expenses",
  name: "Expenses",
  resourceIdentifier: EXPENSES_RESOURCE,
  authorizationServer: EXPENSES_ISSUER,
  downstreamClientId: "weldall-cli-at-expenses",
  requestPrefixes: [`${EXPENSES_ISSUER}/api`],
  supportedScopes: ["expenses:read"],
  grantedScopes: ["expenses:read"],
};

beforeEach(async () => {
  const key = await generateEs256KeyPair();
  state.session = {
    accessToken: "weldall-access-token",
    subject: "user",
    credentials: {
      version: 1,
      issuer: config.issuer,
      ...key,
      refreshToken: "refresh-token",
    },
  };
  vi.unstubAllGlobals();
});

describe("URL-first resource requests", () => {
  it.each([["https://expenses.seibert.localdev/api-attacker"], ["https://catcher.example/api"]])(
    "rejects %s before token exchange or target fetch",
    async (target) => {
      const fetcher = vi.fn(async (input: string | URL | Request) => {
        expect(String(input)).toBe(config.scopes);
        return Response.json([expenses]);
      });
      vi.stubGlobal("fetch", fetcher);
      const { resourceRequest } = await import("../src/services/resources.js");
      await expect(
        resourceRequest(config, {
          url: target,
          method: "POST",
          scopes: ["expenses:read"],
          body: "secret",
        }),
      ).rejects.toThrow("No registered resource accepts");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher).not.toHaveBeenCalledWith(config.token, expect.anything());
    },
  );

  it("rejects unsupported and ungranted scopes before token exchange", async () => {
    const fetcher = vi.fn(async () => Response.json([expenses]));
    vi.stubGlobal("fetch", fetcher);
    const { resourceRequest } = await import("../src/services/resources.js");
    await expect(
      resourceRequest(config, {
        url: `${EXPENSES_ISSUER}/api/expenses`,
        method: "GET",
        scopes: ["expenses:delete"],
      }),
    ).rejects.toThrow("not supported");
    expect(fetcher).toHaveBeenCalledTimes(1);

    expenses.supportedScopes.push("expenses:delete");
    await expect(
      resourceRequest(config, {
        url: `${EXPENSES_ISSUER}/api/expenses`,
        method: "GET",
        scopes: ["expenses:delete"],
      }),
    ).rejects.toThrow("not granted");
    expenses.supportedScopes.pop();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
