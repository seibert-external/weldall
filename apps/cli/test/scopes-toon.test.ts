import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { scopesToon } from "../src/scopes-toon.js";
import type { ResourceGrant } from "../src/services/resources.js";

const resource = (overrides: Partial<ResourceGrant> = {}): ResourceGrant => ({
  key: "expenses",
  name: "Expenses",
  resourceIdentifier: "https://expenses.example.com",
  authorizationServer: "https://auth.example.com",
  downstreamClientId: "expenses-cli",
  requestPrefixes: ["https://expenses.example.com/api/"],
  supportedScopes: ["expenses:read", "expenses:write"],
  grantedScopes: ["expenses:read"],
  ...overrides,
});

interface Permissions {
  assignedScopes: string[];
  resources: ResourceGrant[];
}

const permissions = (overrides: Partial<Permissions> = {}): Permissions => ({
  assignedScopes: ["expenses:read"],
  resources: [resource()],
  ...overrides,
});

const rows = (output: string) =>
  output.split("\n").filter((line) => line.startsWith("  ") && line.trim() !== "");

describe("scopesToon", () => {
  it("declares how many scopes the account holds, inline", () => {
    const output = scopesToon(permissions({ assignedScopes: ["expenses:read", "expenses:write"] }));
    // The reference encoder quotes any value holding a colon, so a scope is never bare.
    expect(output).toContain('assignedScopes[2\t]: "expenses:read"\t"expenses:write"');
  });

  it("declares how many resources follow, which is why this output exists", () => {
    const output = scopesToon(
      permissions({ resources: [resource(), resource({ key: "invite", name: "Invites" })] }),
    );
    expect(output).toContain(
      "resources[2\t]{key\tname\tgrantedScopes\tsupportedScopes\trequestPrefixes}:",
    );
    expect(rows(output)).toHaveLength(2);
  });

  it("joins each scope list with a pipe, inside one column", () => {
    const cells = rows(scopesToon(permissions()))[0].split("\t");
    expect(cells).toHaveLength(5);
    expect(cells[2]).toBe('"expenses:read"');
    expect(cells[3]).toBe('"expenses:read|expenses:write"');
  });

  it("drops the OAuth plumbing an agent never acts on", () => {
    const output = scopesToon(permissions());
    expect(output).not.toContain("https://auth.example.com");
    expect(output).not.toContain("expenses-cli");
    expect(output).not.toContain("resourceIdentifier");
  });

  it("emits an empty array as `key: []`, the only form a TOON encoder may write", () => {
    const output = scopesToon({ assignedScopes: [], resources: [] });
    expect(output).toBe("assignedScopes: []\nresources: []\n");
  });

  it("round-trips through the reference decoder, which is what the agent reads with", () => {
    const decoded = decode(scopesToon(permissions()), { delimiter: "\t" }) as {
      assignedScopes: string[];
      resources: { key: string; supportedScopes: string }[];
    };
    expect(decoded.assignedScopes).toEqual(["expenses:read"]);
    expect(decoded.resources).toHaveLength(1);
    expect(decoded.resources[0].key).toBe("expenses");
    expect(decoded.resources[0].supportedScopes).toBe("expenses:read|expenses:write");
  });
});
