import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import {
  encodeConnectionAttemptToon,
  encodeConnectionDetailToon,
  encodeConnectionsToon,
  encodeConnectorsToon,
  encodeDisconnectToon,
} from "../src/connections-toon.js";
import type {
  ConnectionAttempt,
  ConnectionSummary,
  ConnectorSummary,
} from "../src/services/connections.js";

const connection = (overrides: Partial<ConnectionSummary> = {}): ConnectionSummary => ({
  id: "connection-1",
  ownerId: "owner-1",
  connectorId: "connector-database-id",
  name: "my-google",
  accountId: "google-account-1",
  accountName: "ada@example.com",
  selectedScopes: ["openid", "calendar.events"],
  grantedScopes: ["openid", "calendar.events"],
  status: "READY",
  version: 3,
  lastUsedAt: "2026-09-01T12:00:00.000Z",
  requestCount: 12,
  revocationError: null,
  createdAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
  connectorKey: "google",
  connectorEnabled: true,
  ...overrides,
});

const connector = (overrides: Partial<ConnectorSummary> = {}): ConnectorSummary => ({
  key: "google",
  name: "Google Workspace",
  type: "google",
  requiredScopes: ["workspace:google"],
  scopes: [
    {
      id: "openid",
      label: "Identify your Google account",
      description: "Required identity scope.",
      group: "Identity",
      required: true,
    },
    {
      id: "calendar.events",
      label: "Read and edit events",
      description: "Manage calendar events.",
      group: "Calendar",
      required: false,
    },
  ],
  defaultScopes: ["calendar.events"],
  ...overrides,
});

const attempt = (overrides: Partial<ConnectionAttempt> = {}): ConnectionAttempt => ({
  id: "attempt-1",
  status: "COMPLETED",
  connector: { key: "google", name: "Google Workspace", version: 4 },
  scopes: connector().scopes,
  selection: { scopes: ["calendar.events"] },
  expiresAt: "2026-09-01T12:10:00.000Z",
  connection: connection(),
  ...overrides,
});

const rows = (output: string) =>
  output.split("\n").filter((line) => line.startsWith("  ") && line.trim() !== "");

describe("managed connection TOON output", () => {
  it("declares connection counts and includes the fields an agent acts on", () => {
    const output = encodeConnectionsToon({
      connections: [connection(), connection({ id: "connection-2", name: "team-google" })],
      issuer: "https://weldall.example.com",
    });

    expect(output).toContain("connections[2\t]");
    expect(rows(output)).toHaveLength(2);
    expect(output).toContain("openid|calendar.events");
    expect(output).toContain("https://weldall.example.com");
    expect(output).toContain("Provider-specific usage hints");
    expect(output).toContain("showCommand");
    expect(output).not.toContain("requestPrefix");
  });

  it("leaves ownership and database plumbing in --json", () => {
    const output = encodeConnectionsToon({
      connections: [connection()],
      issuer: "https://weldall.example.com",
    });

    expect(output).not.toContain("owner-1");
    expect(output).not.toContain("connector-database-id");
    expect(output).not.toContain("connectorId");
    expect(output).not.toContain("version");
  });

  it("encodes connector scopes, connection states, and usage discovery", () => {
    const output = encodeConnectorsToon({
      connectors: [
        connector(),
        connector({ key: "atlassian", name: "Atlassian", type: "atlassian" }),
        connector({ key: "notion", name: "Notion", type: "notion" }),
      ],
      connections: [
        connection(),
        connection({
          id: "connection-2",
          name: "my-atlassian",
          connectorKey: "atlassian",
          status: "RECONNECT_REQUIRED",
        }),
        connection({
          id: "connection-3",
          name: "old-notion",
          connectorKey: "notion",
          status: "DISCONNECTED",
        }),
      ],
    });
    const decoded = decode(output, { delimiter: "\t" }) as {
      usageHints: string;
      connectors: Array<{
        key: string;
        connectionState: string;
        connections: string;
        scopes: string;
        defaultScopes: string;
      }>;
      connections: Array<{ name: string; status: string; showCommand: string }>;
    };

    expect(decoded.usageHints).toContain("weldall connections show <connection-name> --agentic");
    expect(decoded.connectors).toEqual([
      expect.objectContaining({
        key: "google",
        connectionState: "CONNECTED",
        connections: "my-google",
        scopes: "openid|calendar.events",
        defaultScopes: "calendar.events",
      }),
      expect.objectContaining({
        key: "atlassian",
        connectionState: "NEEDS_ATTENTION",
        connections: "my-atlassian",
      }),
      expect.objectContaining({
        key: "notion",
        connectionState: "NOT_CONNECTED",
        connections: "",
      }),
    ]);
    expect(decoded.connections).toHaveLength(2);
    expect(decoded.connections[1]).toMatchObject({
      name: "my-atlassian",
      status: "RECONNECT_REQUIRED",
      showCommand: "weldall connections show my-atlassian --agentic",
    });
  });

  it("keeps complete scope arrays on a single connection", () => {
    const decoded = decode(
      encodeConnectionDetailToon({
        connection: connection(),
        issuer: "https://weldall.example.com",
      }),
      { delimiter: "\t" },
    ) as { selectedScopes: string[]; grantedScopes: string[] };

    expect(decoded.selectedScopes).toEqual(["openid", "calendar.events"]);
    expect(decoded.grantedScopes).toEqual(["openid", "calendar.events"]);
  });

  it("encodes setup and disconnect results without JSON-only bookkeeping", () => {
    const status = decode(encodeConnectionAttemptToon(attempt()), { delimiter: "\t" }) as {
      id: string;
      status: string;
      connection: string;
    };
    const disconnected = decode(
      encodeDisconnectToon({ status: "DISCONNECTED", revocationConfirmed: true }),
      { delimiter: "\t" },
    ) as { status: string; revocationConfirmed: boolean };

    expect(status).toMatchObject({
      id: "attempt-1",
      status: "COMPLETED",
      connection: "my-google",
    });
    expect(disconnected).toMatchObject({
      status: "DISCONNECTED",
      revocationConfirmed: true,
    });
  });

  it("uses the canonical empty-array representation", () => {
    const connections = decode(
      encodeConnectionsToon({ connections: [], issuer: "https://weldall.example.com" }),
      { delimiter: "\t" },
    ) as { connections: unknown[]; usageHints: string };
    const connectors = decode(encodeConnectorsToon({ connectors: [], connections: [] }), {
      delimiter: "\t",
    }) as { connectors: unknown[]; connections: unknown[]; usageHints: string };

    expect(connections.connections).toEqual([]);
    expect(connections.usageHints).toContain("connections show");
    expect(connectors.connectors).toEqual([]);
    expect(connectors.connections).toEqual([]);
    expect(connectors.usageHints).toContain("connections show");
  });
});
