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
