import { describe, expect, it } from "vitest";
import { connectorCapabilities } from "../src/server/connectors/provider";
import { connectorProviders, getConnectorProvider } from "../src/server/connectors/registry";

describe("provider-derived connector capabilities", () => {
  it("derives capabilities from implementation, not the provider name", () => {
    expect(
      connectorProviders.map((provider) => [provider.type, connectorCapabilities(provider)]),
    ).toEqual([
      ["google", ["http"]],
      ["atlassian", ["http"]],
      ["atlassian-mcp", ["mcp"]],
    ]);
    expect(
      connectorCapabilities({ ...getConnectorProvider("atlassian-mcp"), type: "future-provider" }),
    ).toEqual(["mcp"]);
    expect(
      connectorCapabilities({ ...getConnectorProvider("google"), type: "atlassian-mcp" }),
    ).toEqual(["http"]);
    expect(() => getConnectorProvider("unknown")).toThrow("Unsupported provider");
  });
});
