import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  installationCompleted: vi.fn(),
  publicLoginProviders: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("../src/server/auth/login-service", () => ({
  installationCompleted: mocks.installationCompleted,
  publicLoginProviders: mocks.publicLoginProviders,
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import Login from "../src/app/login/page";

beforeEach(() => {
  mocks.installationCompleted.mockReset().mockResolvedValue(false);
  mocks.publicLoginProviders.mockReset().mockResolvedValue([]);
  mocks.redirect.mockReset().mockImplementation(() => {
    throw new Error("redirect");
  });
});

const redirectFor = async (query: Record<string, string | string[] | undefined>) => {
  await expect(Login({ searchParams: Promise.resolve(query) })).rejects.toThrow("redirect");
  return mocks.redirect.mock.calls[0]?.[0];
};

describe("login page before installation", () => {
  it("sends a visit without a login error to setup", async () => {
    expect(await redirectFor({})).toBe("/setup");
  });

  it.each(["entra_email_unverified", "entra_guest_denied", "entra_claims_missing"])(
    "forwards the allowlisted reason %s to setup",
    async (code) => {
      expect(await redirectFor({ loginError: code })).toBe(`/setup?failed=1&reason=${code}`);
    },
  );

  it.each([
    "setup_email_mismatch",
    "invalid_attempt",
    "<script>",
    "entra_guest_denied&x=1",
    ["entra_guest_denied", "entra_claims_missing"],
  ])("drops any other login error %j to the generic setup failure", async (loginError) => {
    expect(await redirectFor({ loginError })).toBe("/setup?failed=1");
  });
});
