import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("not found");
  }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));

import ConnectionResultPage, { metadata } from "../src/app/connections/result/[outcome]/page";

describe("connection result page", () => {
  it.each([
    ["success", "Connection ready", "Your account is connected"],
    ["cancelled", "Authorization cancelled", "No connection was created"],
    ["failed", "Authorization failed", "required cleanup"],
  ] as const)("renders the %s outcome", async (outcome, heading, message) => {
    const html = renderToStaticMarkup(
      await ConnectionResultPage({ params: Promise.resolve({ outcome }) }),
    );
    expect(html).toContain('class="login-shell"');
    expect(html).toContain('class="login-panel setup-panel login-auth-panel"');
    expect(html).toContain('alt="Weldall"');
    expect(html).toContain(`<h1`);
    expect(html).toContain(heading);
    expect(html).toContain(message);
    expect(html).toContain("You can close this tab after returning to the CLI.");
  });

  it("rejects unknown outcomes", async () => {
    await expect(
      ConnectionResultPage({ params: Promise.resolve({ outcome: "unknown" }) }),
    ).rejects.toThrow("not found");
    expect(mocks.notFound).toHaveBeenCalled();
  });

  it("prevents indexing and referrer leakage", () => {
    expect(metadata).toMatchObject({
      robots: { index: false, follow: false },
      referrer: "no-referrer",
    });
  });
});
