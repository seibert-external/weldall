import { describe, expect, it } from "vitest";
import { GET } from "../src/app/install.md/route.js";

describe("install guide", () => {
  it("configures the CLI with the host that served the guide", async () => {
    const response = GET(new Request("https://weldall.example.org/install.md"));
    const guide = await response.text();

    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(guide).toContain("weldall config set-issuer https://weldall.example.org");
    expect(guide).not.toContain("https://weldall.example.com");
  });

  it("uses the browser-visible origin behind a reverse proxy", async () => {
    const response = GET(
      new Request("http://localhost:3000/install.md", {
        headers: {
          "x-forwarded-host": "weldall.seibert.localdev",
          "x-forwarded-proto": "https",
        },
      }),
    );
    const guide = await response.text();

    expect(guide).toContain("weldall config set-issuer https://weldall.seibert.localdev");
    expect(guide).not.toContain("http://localhost:3000");
  });
});
