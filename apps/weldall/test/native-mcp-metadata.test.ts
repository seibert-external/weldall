import { afterEach, beforeEach, expect, it, vi } from "vitest";

let authorizedNativeResourceKeys: typeof import("../src/server/mcp/native").authorizedNativeResourceKeys;
beforeEach(async () => {
  vi.resetModules();
  ({ authorizedNativeResourceKeys } = await import("../src/server/mcp/native"));
});

const resource = {
  key: "billing",
  name: "Billing",
  resourceIdentifier: "https://billing.example/api",
  authorizationServer: "https://billing.example",
  downstreamClientId: "cli",
  supportedScopes: ["read", "discover"],
  requestPrefixes: ["https://billing.example/api"],
};
const metadata = () => ({
  resource: resource.resourceIdentifier,
  authorization_servers: [resource.authorizationServer],
  weldall_mcp: {
    schemaVersion: 1,
    transport: "streamable-http-stateless",
    endpoint: "https://billing.example/api/mcp",
    description: "Billing",
    discoveryScopes: ["read", "discover"],
    capabilities: ["tools", "resources"],
    revision: "a".repeat(64),
  },
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("requires every discovery scope without fetching tools or executing operations", async () => {
  const fetcher = vi.fn(async () => Response.json(metadata()));
  vi.stubGlobal("fetch", fetcher);
  expect(await authorizedNativeResourceKeys([resource], ["read"])).toEqual([]);
  expect(await authorizedNativeResourceKeys([resource], ["read", "discover"])).toEqual(["billing"]);
  expect(fetcher).toHaveBeenCalledWith(
    "https://billing.example/.well-known/oauth-protected-resource",
    expect.objectContaining({ redirect: "error" }),
  );
});
it("reuses metadata for 60 seconds but evaluates every caller's current grants", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const fetcher = vi.fn(async () => Response.json(metadata()));
  vi.stubGlobal("fetch", fetcher);
  expect(await authorizedNativeResourceKeys([resource], ["read", "discover"])).toEqual(["billing"]);
  expect(await authorizedNativeResourceKeys([resource], ["read"])).toEqual([]);
  now = 59_999;
  expect(await authorizedNativeResourceKeys([resource], ["read", "discover"])).toEqual(["billing"]);
  expect(fetcher).toHaveBeenCalledOnce();
  now = 60_000;
  await authorizedNativeResourceKeys([resource], ["read", "discover"]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("shares concurrent metadata fetches without sharing authorization decisions", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher = vi.fn(async () => {
    await gate;
    return Response.json(metadata());
  });
  vi.stubGlobal("fetch", fetcher);
  const allowed = authorizedNativeResourceKeys([resource], ["read", "discover"]);
  const denied = authorizedNativeResourceKeys([resource], ["read"]);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  release();
  expect(await allowed).toEqual(["billing"]);
  expect(await denied).toEqual([]);
});
it("does not reuse metadata after registration policy changes", async () => {
  const fetcher = vi.fn(async () => Response.json(metadata()));
  vi.stubGlobal("fetch", fetcher);
  await authorizedNativeResourceKeys([resource], ["read", "discover"]);
  expect(
    await authorizedNativeResourceKeys(
      [{ ...resource, requestPrefixes: ["https://billing.example/other"] }],
      ["read", "discover"],
    ),
  ).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("does not cache failed discovery", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementation(async () => Response.json(metadata()));
  vi.stubGlobal("fetch", fetcher);
  expect(await authorizedNativeResourceKeys([resource], ["read", "discover"])).toEqual([]);
  expect(await authorizedNativeResourceKeys([resource], ["read", "discover"])).toEqual(["billing"]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each(["empty", "outside-prefix", "unsupported", "wrong-audience", "oversized"])(
  "fails closed for %s metadata",
  async (failure) => {
    const value = metadata();
    if (failure === "empty") value.weldall_mcp.discoveryScopes = [];
    if (failure === "outside-prefix") value.weldall_mcp.endpoint = "https://billing.example/mcp";
    if (failure === "unsupported") value.weldall_mcp.discoveryScopes = ["unregistered"];
    if (failure === "wrong-audience") value.resource = "https://wrong.example/api";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        failure === "oversized" ? new Response("x".repeat(65_537)) : Response.json(value),
      ),
    );
    expect(await authorizedNativeResourceKeys([resource], ["read", "discover"])).toEqual([]);
  },
);
it("keeps authorized advertisements when more than 100 unrelated resources are registered", async () => {
  const fetcher = vi.fn(async () => Response.json(metadata()));
  vi.stubGlobal("fetch", fetcher);
  const ungranted = Array.from({ length: 100 }, (_, i) => ({
    ...resource,
    key: `ungranted${i}`,
    supportedScopes: ["ungranted"],
  }));
  expect(
    await authorizedNativeResourceKeys([...ungranted, resource], ["read", "discover"]),
  ).toEqual(["billing"]);
  expect(fetcher).toHaveBeenCalledOnce();
});
it("processes more than 100 eligible resources with at most four concurrent requests", async () => {
  let active = 0;
  let maximum = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return Response.json(metadata());
    }),
  );
  const resources = Array.from({ length: 101 }, (_, i) => ({ ...resource, key: `billing${i}` }));
  const keys = await authorizedNativeResourceKeys(resources, ["read", "discover"]);
  expect(new Set(keys)).toEqual(new Set(resources.map((item) => item.key)));
  expect(maximum).toBe(4);
});
it("does not contact a resource when none of its supported scopes are granted", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(await authorizedNativeResourceKeys([resource], [])).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});
