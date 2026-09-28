import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/app/consent/consent-options", () => ({ ConsentOptions: () => null }));
import Consent from "../src/app/consent/page";

describe("CLI consent page", () => {
  it("keeps a visible login heading, its accessible panel label and the anti-phishing warning", () => {
    const html = renderToStaticMarkup(<Consent />);
    expect(html).toMatch(/<h1\b[^>]*id="consent-heading"[^>]*>Login to Weldall CLI<\/h1>/);
    expect(html).toContain('aria-labelledby="consent-heading"');
    expect(html).toContain(
      "Only approve if you started this login from the Weldall CLI on this device.",
    );
    expect(html).toContain('alt="Weldall"');
  });
});
