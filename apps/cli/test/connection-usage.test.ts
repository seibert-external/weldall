import { decode } from "@toon-format/toon";
import { describe, expect, it, vi } from "vitest";
import { connectionUsage, withConnectionUsage } from "../src/connection-usage.js";
import { encodeConnectionDetailToon, encodeConnectionsToon } from "../src/connections-toon.js";
import { printConnectionDetails } from "../src/commands.js";
import {
  isConnectionSummary,
  isConnectionUsage,
  type ConnectionSummary,
} from "../src/services/connections.js";

const connection: ConnectionSummary = {
  id: "connection",
  ownerId: "owner",
  connectorId: "connector",
  name: "my-service",
  accountId: "account",
  accountName: "Owner",
  selectedScopes: ["read"],
  grantedScopes: ["read"],
  status: "READY",
  version: 1,
  lastUsedAt: null,
  requestCount: 0,
  revocationError: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  connectorKey: "service",
  connectorEnabled: true,
  details: [{ label: "Site", value: "Company site" }],
  usage: {
    instructions: ["Use this gateway. Request the next page with the returned cursor."],
    examples: [
      {
        label: "Read items",
        method: "GET",
        url: "https://api.example.com/items?limit=10&fields=name",
      },
    ],
  },
};
const issuer = "https://weldall.example.com";

describe("provider-neutral connection usage", () => {
  it("validates provider metadata and preserves older server responses", () => {
    expect(isConnectionSummary(connection)).toBe(true);
    const { usage: _usage, ...legacy } = connection;
    expect(isConnectionSummary(legacy)).toBe(true);
    expect(withConnectionUsage(legacy)).toBe(legacy);
    expect(connectionUsage(legacy).examples).toEqual([]);
  });
  it.each([
    null,
    { instructions: "text", examples: [] },
    {
      instructions: [],
      examples: [{ label: "Run", method: "GET; echo", url: "https://example.com" }],
    },
    ...[
      "http://example.com",
      "https://user:secret@example.com",
      "https://example.com/#secret",
      "https://example.com/\n",
    ].map((url) => ({ instructions: [], examples: [{ label: "Read", method: "GET", url }] })),
  ])("rejects malformed guidance %j", (usage) => {
    expect(isConnectionUsage(usage)).toBe(false);
    expect(isConnectionSummary({ ...connection, usage })).toBe(false);
  });
  it("constructs commands from the real connection name and safely quotes query strings", () => {
    const usage = connectionUsage(connection);
    expect(usage.examples[0]?.command).toBe(
      "weldall request --connection my-service --method GET 'https://api.example.com/items?limit=10&fields=name'",
    );
    expect(usage.instructions.join(" ")).toContain("do not assume curl flags");
    expect(usage.instructions).toContain(connection.usage!.instructions[0]);
    const malicious = connectionUsage({
      ...connection,
      name: "name;echo",
      usage: {
        instructions: [],
        examples: [
          { label: "Example", method: "GET", url: "https://api.example.com/?q='$(whoami)'" },
        ],
      },
    });
    expect(malicious.examples[0]?.command).toContain("--connection 'name;echo'");
    expect(malicious.examples[0]?.command).toContain(
      "'https://api.example.com/?q='\"'\"'$(whoami)'\"'\"''",
    );
  });
  it("keeps the same guidance in JSON and agent-oriented details", () => {
    const json = JSON.parse(JSON.stringify(withConnectionUsage(connection)));
    const agentic = decode(encodeConnectionDetailToon({ connection, issuer }), {
      delimiter: "\t",
    }) as { usage: unknown; details: unknown };
    expect(agentic.usage).toEqual(json.usage);
    expect(agentic.details).toEqual(connection.details);
    const listed = decode(encodeConnectionsToon({ connections: [connection], issuer }), {
      delimiter: "\t",
    }) as { connections: { showCommand: string }[] };
    expect(listed.connections[0]?.showCommand).toBe(
      "weldall connections show my-service --agentic",
    );
  });
  it("shows provider details, guidance, and commands in human output", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      printConnectionDetails(connection);
      const text = output.mock.calls.flat().join("\n");
      expect(text).toContain("Company site");
      expect(text).toContain("Read items");
      expect(text).toContain("weldall request");
      expect(text).toContain("--connection");
    } finally {
      output.mockRestore();
    }
  });
});
