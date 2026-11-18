import { cli } from "gunshi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mainCommand, policyCommand } from "../src/commands.js";
import * as config from "../src/config.js";
import { keychain } from "../src/storage/keychain.js";
import { appendixCache, type CliHeaderSnapshot } from "../src/storage/appendix.js";

vi.mock("@weldall/sdk", async (original) => ({
  ...(await original<object>()),
  createDpopProof: vi.fn().mockResolvedValue("weldall-proof"),
}));
vi.mock("../src/services/auth.js", async (original) => ({
  ...(await original<object>()),
  withAccess: (_config: unknown, operation: (session: unknown) => unknown) =>
    operation({
      accessToken: "weldall-token",
      subject: "user-1",
      credentials: { refreshToken: "weldall-refresh" },
    }),
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
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(appendixCache, "updateSnapshot").mockResolvedValue({} as CliHeaderSnapshot);
  vi.spyOn(appendixCache, "readSnapshotForSubject").mockResolvedValue(null);
  vi.spyOn(keychain, "get").mockResolvedValue({
    version: 2,
    accessSession: { subject: "user-1" },
  } as Awaited<ReturnType<typeof keychain.get>>);
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
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual({
      ...response,
      cached: false,
    });
    expect(appendixCache.updateSnapshot).toHaveBeenCalledWith("https://weldall.example.com", {
      subject: "user-1",
      policy: { policy: response.policy, updatedAt: response.updatedAt, etag: response.etag },
    });
  });

  it("falls back to the signed-in user's cached policy when the live load fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    vi.mocked(appendixCache.readSnapshotForSubject).mockResolvedValue({
      policy: { policy: response.policy, updatedAt: response.updatedAt, etag: response.etag },
    } as CliHeaderSnapshot);
    await runPolicy("--json");
    expect(appendixCache.readSnapshotForSubject).toHaveBeenCalledWith(
      "https://weldall.example.com",
      "user-1",
    );
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual({
      ...response,
      cached: true,
    });
    expect(String(vi.mocked(console.error).mock.calls[0]![0])).toContain("cached client policy");
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
