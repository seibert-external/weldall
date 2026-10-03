import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LoginCompletePage, { metadata } from "../src/app/login/complete/page";

describe("login completion page", () => {
  it("renders the styled success panel", () => {
    const html = renderToStaticMarkup(<LoginCompletePage />);
    expect(html).toContain('class="login-shell"');
    expect(html).toContain('class="login-panel setup-panel login-auth-panel"');
    expect(html).toContain('alt="Weldall"');
    expect(html).toContain("Weldall login complete");
    expect(html).toContain("You may close this window.");
  });

  it("prevents indexing and referrer leakage", () => {
    expect(metadata).toMatchObject({
      robots: { index: false, follow: false },
      referrer: "no-referrer",
    });
  });
});
