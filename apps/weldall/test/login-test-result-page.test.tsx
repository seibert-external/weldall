import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("not found");
  }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));

import LoginTestResultPage, { metadata } from "../src/app/login/test-result/page";

const testId = "00000000-0000-4000-8000-000000000001";

describe("OIDC login test result page", () => {
  it.each([
    ["setup-test", "true", "Login test passed", "Nothing was saved"],
    ["provider-test", "true", "Login test passed", "save explicitly"],
    ["provider-test", "false", "Login test failed", "try again"],
  ] as const)("renders %s passed=%s", async (mode, passed, heading, copy) => {
    const html = renderToStaticMarkup(
      await LoginTestResultPage({ searchParams: Promise.resolve({ mode, testId, passed }) }),
    );
    expect(html).toContain(heading);
    expect(html).toContain(copy);
    expect(html).toContain('alt="Weldall"');
  });

  it.each([
    ["entra_email_unverified", "did not confirm a verified email address"],
    ["entra_guest_denied", "Guest accounts cannot sign in."],
    ["entra_claims_missing", "did not send the acct claim"],
  ])("explains the allowlisted failure reason %s", async (reason, copy) => {
    for (const mode of ["setup-test", "provider-test"] as const) {
      const html = renderToStaticMarkup(
        await LoginTestResultPage({
          searchParams: Promise.resolve({ mode, testId, passed: "false", reason }),
        }),
      );
      expect(html).toContain("Login test failed");
      expect(html).toContain(copy);
      expect(html).not.toContain("review the provider settings");
    }
  });

  it.each([
    "setup_email_mismatch",
    "unverified_identity",
    "",
    "ENTRA_GUEST_DENIED",
    "<script>alert(1)</script>",
    ["entra_guest_denied", "entra_claims_missing"],
  ])("ignores a non-allowlisted reason %j and keeps the generic failure", async (reason) => {
    const html = renderToStaticMarkup(
      await LoginTestResultPage({
        searchParams: Promise.resolve({ mode: "provider-test", testId, passed: "false", reason }),
      }),
    );
    expect(html).toContain("Login test failed");
    expect(html).toContain("review the provider settings, and try again");
    expect(html).not.toContain("script");
  });

  it("ignores a reason on a passed test", async () => {
    const html = renderToStaticMarkup(
      await LoginTestResultPage({
        searchParams: Promise.resolve({
          mode: "provider-test",
          testId,
          passed: "true",
          reason: "entra_guest_denied",
        }),
      }),
    );
    expect(html).toContain("Login test passed");
    expect(html).not.toContain("Guest accounts");
  });

  it.each([
    {},
    { mode: "login", testId, passed: "true" },
    { mode: "setup-test", testId: "not-a-uuid", passed: "true" },
    { mode: "setup-test", testId, passed: "yes" },
    { mode: "setup-test", testId, passed: "true", extra: "value" },
    { mode: ["setup-test", "provider-test"], testId, passed: "true" },
  ])("rejects malformed result parameters %#", async (searchParams) => {
    await expect(
      LoginTestResultPage({ searchParams: Promise.resolve(searchParams) }),
    ).rejects.toThrow("not found");
  });

  it("prevents indexing and referrer leakage", () => {
    expect(metadata).toMatchObject({
      robots: { index: false, follow: false },
      referrer: "no-referrer",
    });
  });
});
