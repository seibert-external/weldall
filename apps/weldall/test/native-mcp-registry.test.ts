import { beforeEach, expect, it, vi } from "vitest";
import { GET } from "../src/app/api/me/scopes/route";
import { authenticateCliApiRequest } from "../src/server/oauth/cli-api";
import { resourceRegistryFor } from "../src/server/policy/resources";
import { authorizedNativeResources } from "../src/server/mcp/native";

vi.mock("../src/server/oauth/constants", () => ({ WELDALL_ISSUER: "https://weldall.example" }));
vi.mock("../src/server/oauth/cli-api", () => ({ authenticateCliApiRequest: vi.fn() }));
vi.mock("../src/server/oauth/error-response", () => ({
  loggedOauthErrorResponse: () => new Response(null, { status: 401 }),
}));
vi.mock("../src/server/observability/http", () => ({
  withRequestLogging: (_path: string, handler: unknown) => handler,
}));
vi.mock("../src/server/policy/resources", () => ({ resourceRegistryFor: vi.fn() }));
vi.mock("../src/server/mcp/native", () => ({ authorizedNativeResources: vi.fn() }));
const resource = {
  key: "billing",
  name: "Billing",
  resourceIdentifier: "https://billing.example/api",
  authorizationServer: "https://billing.example",
  downstreamClientId: "cli",
  requestPrefixes: ["https://billing.example/api"],
  supportedScopes: ["read"],
  grantedScopes: ["read"],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(authenticateCliApiRequest).mockResolvedValue({ email: "alice@example.com" } as never);
  vi.mocked(resourceRegistryFor).mockResolvedValue([resource]);
});
it("leaves ordinary HTTP registry reads unchanged without contacting resource metadata", async () => {
  const response = await GET(new Request("https://weldall.example/api/me/scopes"));
  expect(await response.json()).toEqual([resource]);
  expect(authorizedNativeResources).not.toHaveBeenCalled();
});
it("adds only authorized SDK-derived advertisements on the opt-in authenticated path", async () => {
  const mcp = {
    schemaVersion: 1 as const,
    transport: "streamable-http-stateless" as const,
    endpoint: "https://billing.example/api/mcp",
    description: "Invoices",
    discoveryScopes: ["read"],
    capabilities: ["tools", "resources"] as ["tools", "resources"],
    revision: "a".repeat(64),
  };
  vi.mocked(authorizedNativeResources).mockResolvedValue(new Map([["billing", mcp]]));
  const response = await GET(new Request("https://weldall.example/api/me/scopes?mcp=1"));
  expect(await response.json()).toEqual([{ ...resource, mcp }]);
  expect(authorizedNativeResources).toHaveBeenCalledWith([resource], ["read"]);
});
it("does not fetch or disclose a registry before authenticating", async () => {
  vi.mocked(authenticateCliApiRequest).mockRejectedValue(new Error("unauthorized"));
  expect((await GET(new Request("https://weldall.example/api/me/scopes?mcp=1"))).status).toBe(401);
  expect(resourceRegistryFor).not.toHaveBeenCalled();
  expect(authorizedNativeResources).not.toHaveBeenCalled();
});
