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

  it("encodes connector scope catalogs as compact table cells", () => {
    const output = encodeConnectorsToon([connector()]);
    const decoded = decode(output, { delimiter: "\t" }) as {
      connectors: Array<{ key: string; scopes: string; defaultScopes: string }>;
    };

    expect(decoded.connectors).toEqual([
      {
        key: "google",
        name: "Google Workspace",
        type: "google",
        scopes: "openid|calendar.events",
        defaultScopes: "calendar.events",
      },
    ]);
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
    expect(encodeConnectionsToon({ connections: [], issuer: "https://weldall.example.com" })).toBe(
      "connections: []\n",
    );
    expect(encodeConnectorsToon([])).toBe("connectors: []\n");
  });
});
