import { cli } from "gunshi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mainCommand, statusCommand } from "../src/commands.js";
import * as config from "../src/config.js";
import * as auth from "../src/services/auth.js";
import * as resources from "../src/services/resources.js";
import * as settings from "../src/services/settings.js";
import * as connections from "../src/services/connections.js";
import * as policy from "../src/services/policy.js";
import { appendixCache } from "../src/storage/appendix.js";

vi.mock("@weldall/sdk", async (original) => ({
  ...(await original<object>()),
  createDpopProof: vi.fn().mockResolvedValue("weldall-proof"),
}));
vi.mock("../src/services/auth.js", async (original) => ({
  ...(await original<object>()),
  withAccess: (_config: unknown, operation: (session: unknown) => unknown) =>
    operation({ accessToken: "weldall-token", credentials: { refreshToken: "weldall-refresh" } }),
}));

const identity = {
  issuer: "https://weldall.example.com",
  subject: "user-1",
  name: "Test User",
  email: "user@example.com",
};
const organizationInstructions =
  "Example Group's internal revenue is available via its skills.\nUse weldall skills list --agentic before looking elsewhere.";
const clientPolicy = { version: 1, approvalMode: "auto" };
const runStatus = () =>
  cli(["status", "--json"], mainCommand, {
    name: "weldall",
    version: "0.0.0",
    strict: true,
    subCommands: { status: statusCommand },
    renderHeader: () => "",
    renderValidationErrors: null,
  });

beforeEach(() => {
  vi.spyOn(config, "resolveWeldallConfig").mockResolvedValue({
    issuer: identity.issuer,
  } as config.WeldallConfig);
  vi.spyOn(auth, "whoAmI").mockResolvedValue(identity);
  vi.spyOn(resources, "listScopesWithSubject").mockResolvedValue({
    subject: identity.subject,
    result: { assignedScopes: ["reports:read"], resources: [] },
  });
  vi.spyOn(settings, "getCliAppendix").mockResolvedValue(organizationInstructions);
  vi.spyOn(policy, "getClientPolicyWithSubject").mockResolvedValue({
    result: { version: 1, policy: clientPolicy, updatedAt: null, etag: "etag-1" },
    subject: identity.subject,
  });
  // Older servers need not support connectors for status/context to remain usable.
  vi.spyOn(connections, "listConnectors").mockRejectedValue(new Error("Endpoint unavailable"));
  vi.spyOn(connections, "listConnections").mockRejectedValue(new Error("Endpoint unavailable"));
  vi.spyOn(appendixCache, "updateSnapshot").mockResolvedValue({
    appendix: "stale cached organization",
    scopes: [],
    skills: [],
    connectors: [],
    connections: [],
    skillsInitialized: false,
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("status JSON organization context", () => {
  it("adds the live instructions verbatim while retaining existing fields", async () => {
    await runStatus();
    expect(console.log).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual({
      identity,
      assignedScopes: ["reports:read"],
      grants: [],
      organizationInstructions,
      nativeDiscoveryVersion: 1,
      policy: clientPolicy,
    });
    expect(settings.getCliAppendix).toHaveBeenCalledOnce();
    expect(appendixCache.updateSnapshot).toHaveBeenCalledWith(
      identity.issuer,
      expect.objectContaining({
        policy: { policy: clientPolicy, updatedAt: null, etag: "etag-1" },
      }),
    );
  });

  it("distinguishes an explicitly empty configuration from failed loading", async () => {
    vi.mocked(settings.getCliAppendix).mockResolvedValue("");
    await runStatus();
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0]).organizationInstructions).toBe("");
  });

  it.each(["network failure", "older server without CLI settings"])(
    "reports null on %s, never stale cached instructions",
    async (message) => {
      vi.mocked(settings.getCliAppendix).mockRejectedValue(new Error(message));
      await runStatus();
      const output = vi.mocked(console.log).mock.calls[0]![0];
      expect(JSON.parse(output)).toEqual({
        identity,
        assignedScopes: ["reports:read"],
        grants: [],
        organizationInstructions: null,
        nativeDiscoveryVersion: 1,
        policy: clientPolicy,
      });
      expect(output).not.toContain("stale cached organization");
    },
  );

  it("reports policy null against an older server without the policy endpoint", async () => {
    vi.mocked(policy.getClientPolicyWithSubject).mockRestore();
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ error: "not_found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    await runStatus();
    expect(fetcher).toHaveBeenCalledWith(
      "https://weldall.example.com/api/me/policy",
      expect.anything(),
    );
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0]);
    expect(output.organizationInstructions).toBe(organizationInstructions);
    expect(output.policy).toBeNull();
  });

  it("does not publish context when identity and permission subjects differ", async () => {
    vi.mocked(resources.listScopesWithSubject).mockResolvedValue({
      subject: "another-user",
      result: { assignedScopes: [], resources: [] },
    });
    await expect(runStatus()).rejects.toThrow("account changed");
    expect(console.log).not.toHaveBeenCalled();
    expect(appendixCache.updateSnapshot).not.toHaveBeenCalled();
  });
});
