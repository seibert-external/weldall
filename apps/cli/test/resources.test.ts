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
vi.mock("../src/oauth/session.js", () => ({
  validateIdJagResponse: async () => "downstream-assertion",
}));

const config: WeldallConfig = {
  issuer: "https://weldall.example",
  resource: "https://weldall.example/api",
  authorize: "https://weldall.example/api/auth/oauth2/authorize",
  token: "https://weldall.example/api/auth/oauth2/token",
  revoke: "https://weldall.example/api/auth/oauth2/revoke",
  jwks: "https://weldall.example/api/oauth/jwks",
  cli: "https://weldall.example/api/me/cli",
  grants: "https://weldall.example/api/me/grants",
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

describe("scope overview", () => {
  it("returns assigned scopes even when no enabled resource exposes them", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === config.grants) return Response.json(["weldall:administer"]);
      if (url === config.scopes) return Response.json([]);
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const { listScopes } = await import("../src/services/resources.js");

    await expect(listScopes(config)).resolves.toEqual({
      assignedScopes: ["weldall:administer"],
      resources: [],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("falls back to resource grants during a rolling server upgrade", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input) === config.grants
          ? new Response(null, { status: 404 })
          : Response.json([expenses]),
      ),
    );
    const { listScopes } = await import("../src/services/resources.js");

    await expect(listScopes(config)).resolves.toEqual({
      assignedScopes: ["expenses:read"],
      resources: [expenses],
    });
  });
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

  it("passes a binary body through and returns the successful response unconsumed", async () => {
    const target = `${EXPENSES_ISSUER}/api/files/report.pdf`;
    const bytes = Uint8Array.from([0, 255, 128, 13, 10]);
    const responseBytes = Uint8Array.from([5, 4, 3, 2, 1, 0]);
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === config.scopes) return Response.json([expenses]);
      if (url === config.token) return Response.json({ issued_token: "id-jag" });
      if (url === `${EXPENSES_ISSUER}/oauth/token`) {
        return Response.json({ access_token: "resource-access-token" });
      }
      if (url === target) {
        expect(init?.method).toBe("PUT");
        expect(new Headers(init?.headers).get("authorization")).toBe("DPoP resource-access-token");
        expect(init?.body).toBeInstanceOf(Blob);
        expect(new Uint8Array(await (init?.body as Blob).arrayBuffer())).toEqual(bytes);
        return new Response(responseBytes, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const { resourceRequest } = await import("../src/services/resources.js");

    const response = await resourceRequest(config, {
      url: target,
      method: "PUT",
      scopes: ["expenses:read"],
      headers: { "content-type": "application/octet-stream" },
      body: new Blob([bytes]),
    });

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(responseBytes);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

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
