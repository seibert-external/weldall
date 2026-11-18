import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  APP_STATE_LABELS,
  AppStateBadge,
  ExternalLink,
  httpsUrl,
} from "../src/app/admin/apps/apps-table";

describe("app registry admin page", () => {
  it("labels each state with a badge whose colour flags expiring and expired apps", () => {
    const variant = (state: "active" | "expiring_soon" | "expired") =>
      /data-variant="([^"]+)"/.exec(
        renderToStaticMarkup(createElement(AppStateBadge, { state })),
      )?.[1];
    expect(APP_STATE_LABELS).toEqual({
      active: "Active",
      expiring_soon: "Expiring soon",
      expired: "Expired",
    });
    expect([variant("active"), variant("expiring_soon"), variant("expired")]).toEqual([
      "success",
      "warning",
      "error",
    ]);
  });

  it("links only https URLs without credentials and shows them as plain text", () => {
    const link = renderToStaticMarkup(
      createElement(ExternalLink, { href: "https://app.example.com/?a=<b>" }),
    );
    expect(link).toContain('href="https://app.example.com/?a=%3Cb%3E"');
    expect(link).toContain('rel="noopener noreferrer nofollow"');
    expect(link).not.toContain("<b>");
    for (const href of [
      "javascript:alert(1)",
      "http://app.example.com/",
      "https://user:secret@app.example.com/",
      "data:text/html,<script>alert(1)</script>",
      "not a url",
      null,
    ]) {
      expect(httpsUrl(href)).toBeNull();
      const html = renderToStaticMarkup(createElement(ExternalLink, { href }));
      expect(html).not.toContain("<a");
      expect(html).toContain("None");
    }
  });

  it("renders a repository label as text, not markup", () => {
    const html = renderToStaticMarkup(
      createElement(ExternalLink, {
        href: "https://github.com/acme/app",
        label: "<img src=x onerror=alert(1)>",
      }),
    );
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
