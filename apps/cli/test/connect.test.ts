import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEs256KeyPair, verifyStrictDpop } from "@weldall/sdk";
import type { WeldallConfig } from "../src/config.js";
import {
  connectBrowserApplication,
  normalizeConnectionCode,
  requireInteractiveConnectionApproval,
} from "../src/services/connect.js";

const issuer = "https://weldall.example.com";
const lookup = `${issuer}/api/me/browser-connections/pending/lookup`;
const decision = `${issuer}/api/me/browser-connections/pending/decision`;
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
  browserConnections: {
    deviceAuthorization: `${issuer}/api/auth/oauth2/device_authorization`,
    pendingLookup: lookup,
    pendingDecision: decision,
  },
};

const context = {
  requestId: "request-1",
  userCode: "ABCD-EFGH",
  origin: "https://expenses.example.com",
  resource: {
    id: "resource-1",
    key: "expenses",
    name: "Expenses",
    identifier: "https://expenses.example.com/api",
  },
  browserClientId: "weldall-browser:expenses",
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  account: { id: "user-1", email: "user@example.com" },
};

afterEach(() => vi.restoreAllMocks());

describe("browser connection code", () => {
  it.each(["abcd-efgh", "ABCD EFGH", "a-b-c-d-e-f-g-h", "  ABCDEFGH  "])(
    "normalizes %s before any connection work",
    (value) => expect(normalizeConnectionCode(value)).toBe("ABCD-EFGH"),
  );

  it.each(["", "ABC", "ABCD-EFGI", "ABCD-EFGO", "ABCD/EFGH", "ABCD-EFGH-X"])(
    "rejects malformed %s",
    (value) => expect(() => normalizeConnectionCode(value)).toThrow("eight supported"),
  );

  it("fails closed outside an interactive terminal", () => {
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    try {
      expect(() => requireInteractiveConnectionApproval()).toThrow("interactive approval");
    } finally {
      if (stdin) Object.defineProperty(process.stdin, "isTTY", stdin);
      if (stdout) Object.defineProperty(process.stdout, "isTTY", stdout);
    }
  });
});

describe("browser connection approval", () => {
  it.each([true, false])("holds one session lock through explicit decision=%s", async (approve) => {
    const key = await generateEs256KeyPair();
    const events: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      events.push(url === lookup ? "lookup" : "decision");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("DPoP access-token");
      await verifyStrictDpop(new Headers(init?.headers).get("dpop")!, {
        method: "POST",
        url,
        accessToken: "access-token",
        expectedJkt: key.jkt,
        replay: "disabled",
      });
      const body = JSON.parse(String(init?.body));
      expect(body.userCode).toBe("ABCD-EFGH");
      if (url === lookup) return Response.json(context);
      expect(body.approve).toBe(approve);
      return Response.json({ approved: approve, context });
    }) as unknown as typeof fetch;
    const confirm = vi.fn(async (value) => {
      events.push("confirm");
      expect(value).toEqual(context);
      return approve;
    });
    const result = await connectBrowserApplication(config, "ABCD-EFGH", {
      fetcher,
      confirm,
      lock: async (operation) => {
        events.push("lock:start");
        const value = await operation();
        events.push("lock:end");
        return value;
      },
      access: async (_config, operation) => {
        events.push("access:start");
        const value = await operation({
          accessToken: "access-token",
          subject: "user-1",
          credentials: {
            version: 1,
            issuer,
            ...key,
            refreshToken: "refresh-token",
          },
        });
        events.push("access:end");
        return value;
      },
    });
    expect(result.approved).toBe(approve);
    expect(events).toEqual([
      "lock:start",
      "access:start",
      "lookup",
      "confirm",
      "decision",
      "access:end",
      "lock:end",
    ]);
  });

  it.each([400, 404, 409, 410])("uses one unavailable response for HTTP %s", async (status) => {
    const key = await generateEs256KeyPair();
    await expect(
      connectBrowserApplication(config, "ABCD-EFGH", {
        fetcher: vi.fn(async () => Response.json({ error: "secret server state" }, { status })),
        lock: (operation) => operation(),
        access: (_config, operation) =>
          operation({
            accessToken: "access-token",
            subject: "user-1",
            credentials: { version: 1, issuer, ...key, refreshToken: "refresh" },
          }),
        confirm: vi.fn(async () => true),
      }),
    ).rejects.toThrow("Connection code is unavailable");
  });

  it.each([
    ["entered code", { userCode: "2345-6789" }, "invalid browser-connection details"],
    [
      "browser client",
      { browserClientId: "weldall-browser:other" },
      "invalid browser-connection details",
    ],
    ["account", { account: { id: "other-user", email: "user@example.com" } }, "another account"],
  ])("rejects server context that changes the %s", async (_label, patch, message) => {
    const key = await generateEs256KeyPair();
    await expect(
      connectBrowserApplication(config, "ABCD-EFGH", {
        fetcher: vi.fn(async () => Response.json({ ...context, ...patch })),
        lock: (operation) => operation(),
        access: (_config, operation) =>
          operation({
            accessToken: "access-token",
            subject: "user-1",
            credentials: { version: 1, issuer, ...key, refreshToken: "refresh" },
          }),
        confirm: vi.fn(async () => true),
      }),
    ).rejects.toThrow(message);
  });
});
