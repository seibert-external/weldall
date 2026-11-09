import { cli } from "gunshi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mainCommand, policyCommand } from "../src/commands.js";
import * as config from "../src/config.js";

vi.mock("@weldall/sdk", async (original) => ({
  ...(await original<object>()),
  createDpopProof: vi.fn().mockResolvedValue("weldall-proof"),
}));
vi.mock("../src/services/auth.js", async (original) => ({
  ...(await original<object>()),
  withAccess: (_config: unknown, operation: (session: unknown) => unknown) =>
    operation({ accessToken: "weldall-token", credentials: { refreshToken: "weldall-refresh" } }),
}));

const response = {
  version: 1,
  policy: { version: 1, approvalMode: "auto", shell: false },
  updatedAt: "2026-11-09T10:00:00.000Z",
  etag: "etag-1",
};
const runPolicy = (...args: string[]) =>
  cli(["policy", ...args], mainCommand, {
    name: "weldall",
    version: "0.0.0",
    strict: true,
    subCommands: { policy: policyCommand },
    renderHeader: () => "",
    renderValidationErrors: null,
  });

beforeEach(() => {
  vi.spyOn(config, "resolveWeldallConfig").mockResolvedValue({
    issuer: "https://weldall.example.com",
  } as config.WeldallConfig);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("weldall policy", () => {
  it("prints the server's policy as JSON", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(response));
    vi.stubGlobal("fetch", fetcher);
    await runPolicy("--json");
    expect(fetcher.mock.calls[0]![0]).toBe("https://weldall.example.com/api/me/policy");
    expect(fetcher.mock.calls[0]![1].headers.authorization).toBe("DPoP weldall-token");
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual(response);
  });

  it("fails on a server without the endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "not_found" }, { status: 404 })),
    );
    await expect(runPolicy("--json")).rejects.toThrow();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("rejects a response without version 1", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ...response, policy: { version: 2 } })),
    );
    await expect(runPolicy("--json")).rejects.toThrow("Weldall returned an invalid client policy");
    expect(console.log).not.toHaveBeenCalled();
  });
});
