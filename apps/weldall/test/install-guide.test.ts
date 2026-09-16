import { describe, expect, it } from "vitest";
import { GET } from "../src/app/install.md/route.js";
import { WELDALL_ISSUER } from "../src/server/oauth/constants.js";

describe("install guide", () => {
  it("configures the CLI with the configured issuer", async () => {
    const response = GET();
    const guide = await response.text();

    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(guide).toContain(`weldall config set-issuer ${WELDALL_ISSUER}`);
  });
});
