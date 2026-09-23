import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectionApi,
  connectionRequest,
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
    const response = await connectionRequest(config, "my-google", {
      url,
      method: "POST",
      json: { summary: "Meeting" },
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
      expect(() => validateConnectionTarget(config, target)).toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("polls metadata through Weldall, never a provider credential endpoint", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ status: "COMPLETED", connection: { id: "connection" } }));
    vi.stubGlobal("fetch", fetcher);
    expect(await connectionApi(config, "connection-authorizations/attempt")).toEqual({
      status: "COMPLETED",
      connection: { id: "connection" },
    });
    expect(fetcher.mock.calls[0]![0]).toBe(
      `${config.issuer}/api/me/connection-authorizations/attempt`,
    );
    expect(fetcher.mock.calls[0]![1].headers.authorization).toBe("DPoP weldall-token");
  });
  it("canonicalizes source references without resolving deployment secrets locally", () => {
    const manifest = {
      apiVersion: "weldall.dev/v1" as const,
      workspace: { name: "test", issuer: config.issuer },
      encryptionKeys: {
        arbitrary: {
          key: "arbitrary",
          name: "Key",
          activeVersion: "1",
          versions: { "1": { source: { type: "env", name: "DOES_NOT_EXIST_ON_CLI" } } },
        },
      },
      connectors: {
        google: {
          key: "google",
          name: "Google",
          type: "google",
          enabled: false,
          encryptionKey: "arbitrary",
          clientId: "client",
          enabledApis: ["gmail"],
          allowedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          defaultScopes: [],
        },
      },
    };
    expect(serverManifest(manifest, newLock(manifest)).encryptionKeys).toEqual(
      manifest.encryptionKeys,
    );
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
