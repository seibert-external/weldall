import { describe, expect, it } from "vitest";
import { resolveWeldallIssuer } from "../src/server/oauth/constants.js";

describe("Weldall issuer configuration", () => {
  it("keeps the local issuer as the development default", () => {
    expect(resolveWeldallIssuer({ NODE_ENV: "development" })).toBe(
      "https://weldall.seibert.localdev",
    );
  });

  it("requires an explicit issuer for production", () => {
    expect(() => resolveWeldallIssuer({ WELDALL_DEPLOYMENT_MODE: "production" })).toThrow(
      "WELDALL_ISSUER is required in production",
    );
  });

  it("accepts only a canonical HTTPS origin", () => {
    expect(
      resolveWeldallIssuer({
        WELDALL_DEPLOYMENT_MODE: "production",
        WELDALL_ISSUER: "https://weldall.example.com",
      }),
    ).toBe("https://weldall.example.com");
    expect(() =>
      resolveWeldallIssuer({
        WELDALL_DEPLOYMENT_MODE: "production",
        WELDALL_ISSUER: "http://weldall.example.com/path",
      }),
    ).toThrow("must be an HTTPS origin");
  });
});
