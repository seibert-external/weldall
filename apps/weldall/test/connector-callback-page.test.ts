import { describe, expect, it } from "vitest";
import { connectorCallbackPage } from "../src/server/connectors/callback-page.js";

describe("connector callback result page", () => {
  it("renders a branded success result with escaped connection details", async () => {
    const response = connectorCallbackPage({
      kind: "success",
      connectionName: '<script>alert("connection")</script>',
      accountDisplayName: "person@example.com",
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(body).toContain("Weldall");
    expect(body).toContain("Google connected");
    expect(body).toContain("Close this window and return to the CLI.");
    expect(body).toContain("&lt;script&gt;alert(&quot;connection&quot;)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert");
    expect(body).toContain("person@example.com");
  });

  it.each([
    ["cancelled", "Connection cancelled"],
    ["invalid", "Invalid authorization response"],
    ["failure", "Connection could not be completed"],
  ] as const)("renders a distinct %s failure result", async (kind, title) => {
    const response = connectorCallbackPage({ kind });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain(`data-kind="${kind}"`);
    expect(body).toContain(title);
    expect(body).toContain("return to the CLI");
  });
});
