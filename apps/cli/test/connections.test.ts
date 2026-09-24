import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestConnectionApi,
  requestConnection,
  listConnectors,
  validateConnectionTarget,
} from "../src/services/connections.js";
import type { WeldallConfig } from "../src/config.js";
import { canonicalServerManifest, newLock, serverManifest } from "../src/iac/manifest.js";

vi.mock("@weldall/sdk", async (original) => ({
  ...(await original<object>()),
  createDpopProof: vi.fn().mockResolvedValue("weldall-proof"),
}));
vi.mock("../src/services/auth.js", () => ({
  withAccess: (_config: unknown, operation: (session: unknown) => unknown) =>
    operation({ accessToken: "weldall-token", credentials: { refreshToken: "weldall-refresh" } }),
}));
const config = { issuer: "https://weldall.example.com" } as WeldallConfig;
afterEach(() => vi.unstubAllGlobals());

describe("managed connection CLI", () => {
  it("sends Weldall authentication only to its own connector URL and preserves payload/output", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"items":[]}'));
    vi.stubGlobal("fetch", fetcher);
    const url = `${config.issuer}/connectors/google/calendar/v3/calendars/primary/events`;
    const response = await requestConnection({
      config,
      selector: "my-google",
      input: {
        url,
        method: "POST",
        json: { summary: "Meeting" },
      },
    });
    expect(await response.json()).toEqual({ items: [] });
    const options = fetcher.mock.calls[0]![1];
    expect(options.headers.get("authorization")).toBe("DPoP weldall-token");
    expect(options.headers.get("x-weldall-connection")).toBe("my-google");
    expect(options.body).toBe('{"summary":"Meeting"}');
    expect(options.redirect).toBe("error");
    for (const target of [
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      "https://evil.example/connectors/google/mail",
      "https://user:pass@weldall.example.com/connectors/google/mail",
      `${url}#fragment`,
    ])
      expect(() => validateConnectionTarget({ config, raw: target })).toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("polls metadata through Weldall, never a provider credential endpoint", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ status: "COMPLETED", connection: { id: "connection" } }));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await requestConnectionApi({ config, path: "connection-authorizations/attempt" }),
    ).toEqual({
      status: "COMPLETED",
      connection: { id: "connection" },
    });
    expect(fetcher.mock.calls[0]![0]).toBe(
      `${config.issuer}/api/me/connection-authorizations/attempt`,
    );
    expect(fetcher.mock.calls[0]![1].headers.authorization).toBe("DPoP weldall-token");
  });
  it("accepts the server's rich connector scope descriptors", async () => {
    const connector = {
      key: "google",
      name: "Google Workspace",
      type: "google",
      scopes: [
        {
          id: "openid",
          label: "Identify your Google account",
          description: "Required identity scope.",
          group: "Identity",
          required: true,
          capabilities: [],
        },
        {
          id: "https://www.googleapis.com/auth/calendar.events",
          label: "Read and edit events",
          description: "Manage calendar events.",
          group: "Calendar",
          required: false,
          capabilities: ["Read calendar events"],
        },
      ],
      defaultScopes: ["https://www.googleapis.com/auth/calendar.events"],
      requestPrefix: `${config.issuer}/connectors/google/`,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([connector])));

    await expect(listConnectors(config)).resolves.toEqual([connector]);
  });

  it("requires an explicit local provider without resolving deployment secrets locally", () => {
    const manifest = {
      apiVersion: "weldall.dev/v1" as const,
      workspace: { name: "test", issuer: config.issuer },
      connectors: {
        google: {
          key: "google",
          name: "Google",
          type: "google",
          enabled: false,
          envelopeProvider: "LOCAL_ENV",
          clientId: "client",
          enabledApis: ["gmail"],
          allowedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          defaultScopes: [],
        },
      },
    };
    expect(serverManifest(manifest, newLock(manifest)).connectors).toEqual(manifest.connectors);
    for (const envelopeProvider of [undefined, "OPENBAO", "unknown"]) {
      expect(() =>
        serverManifest(
          {
            ...manifest,
            connectors: { google: { ...manifest.connectors.google, envelopeProvider } },
          },
          newLock(manifest),
        ),
      ).toThrow();
    }
    for (const extra of [{ variable: "ARBITRARY_ENV" }, { providerConfig: {} }]) {
      expect(() =>
        serverManifest(
          { ...manifest, connectors: { google: { ...manifest.connectors.google, ...extra } } },
          newLock(manifest),
        ),
      ).toThrow("Unknown connectors field");
    }
    expect(canonicalServerManifest(manifest).connectors).toEqual(manifest.connectors);
    expect(() =>
      serverManifest(
        {
          ...manifest,
          connectors: { google: { ...manifest.connectors.google, clientSecret: "forbidden" } },
        },
        newLock(manifest),
      ),
    ).toThrow("Unknown connectors field");
  });
});
