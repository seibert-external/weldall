import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  filterConnections,
  type ConnectionRow,
} from "../src/app/admin/connections/connection-view";
import { ConnectionSummary } from "../src/app/admin/connections/connection-detail";

const connection: ConnectionRow = {
  id: "connection-1",
  ownerId: "owner-1",
  connectorId: "connector-1",
  connectorKey: "workspace",
  name: "Work calendar",
  accountId: "provider-account",
  accountName: "account@example.com",
  owner: { name: "Alice", email: "alice@example.com" },
  connectorEnabled: true,
  status: "READY",
  version: 1,
  selectedScopes: ["identity", "calendar:read"],
  grantedScopes: ["identity", "calendar:read", "mail:read"],
  scopeLabels: {
    identity: "Identify your account",
    "calendar:read": "Read team calendars",
    "mail:read": "Read team mail",
  },
  requestCount: 42,
  revocationError: null,
  lastUsedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};
const second: ConnectionRow = {
  ...connection,
  id: "connection-2",
  name: "Mail",
  connectorKey: "personal",
  status: "RECONNECT_REQUIRED",
  owner: { name: "Bob", email: "bob@example.com" },
};
const clear = { search: "", status: "", connector: "" };

describe("connection overview filters", () => {
  it.each(["  ALICE  ", "alice@example.com", "Work calendar", "workspace"])(
    "finds metadata by %s",
    (search) => {
      expect(filterConnections([connection, second], { ...clear, search })).toEqual([connection]);
    },
  );
  it("searches the provider account as well as the Weldall owner", () => {
    expect(filterConnections([connection], { ...clear, search: "account@example.com" })).toEqual([
      connection,
    ]);
  });
  it("combines status and connector filters and resets to all rows", () => {
    const rows = [connection, second];
    expect(filterConnections(rows, { ...clear, status: "READY", connector: "workspace" })).toEqual([
      connection,
    ]);
    expect(filterConnections(rows, { ...clear, status: "READY", connector: "personal" })).toEqual(
      [],
    );
    expect(filterConnections(rows, { ...clear, status: "RECONNECT_REQUIRED" })).toEqual([second]);
    expect(filterConnections(rows, clear)).toEqual(rows);
  });
  it("handles missing owner names and unmatched searches", () => {
    const unnamed = { ...connection, owner: { ...connection.owner, name: null } };
    expect(filterConnections([unnamed], { ...clear, search: "alice@example.com" })).toEqual([
      unnamed,
    ]);
    expect(filterConnections([unnamed], { ...clear, search: "absent" })).toEqual([]);
  });
});

describe("connection detail rendering", () => {
  it("shows identity, usage and distinct selected/granted permissions", () => {
    const html = renderToStaticMarkup(<ConnectionSummary connection={connection} />);
    expect(html).toContain("Work calendar");
    expect(html).toContain('href="/admin/users/owner-1"');
    expect(html).toContain("account@example.com");
    expect(html).toContain("Provider account ID");
    expect(html).toContain("Request dispatches");
    expect(html).toContain("42");
    expect(html).toContain("Never");
    expect(html).toContain("Selected permissions (2)");
    expect(html).toContain("Granted permissions (3)");
    expect(html).toContain("Read team calendars");
    expect(html).toContain("Read team mail");
    expect(html).not.toContain("Google");
  });
  it("uses provider-supplied labels even for familiar scope IDs and preserves unlabeled IDs", () => {
    const html = renderToStaticMarkup(
      <ConnectionSummary
        connection={{
          ...connection,
          selectedScopes: ["openid", "custom:permission"],
          grantedScopes: ["openid", "custom:permission"],
          scopeLabels: { openid: "Provider-supplied identity label" },
        }}
      />,
    );
    expect(html).toContain("Provider-supplied identity label");
    expect(html).toContain("custom:permission");
    expect(html).not.toContain("Identify your Google account");
  });
  it("shows unavailable access and disconnect warnings without granting actions", () => {
    const html = renderToStaticMarkup(
      <ConnectionSummary
        connection={{
          ...connection,
          status: "REVOCATION_PENDING",
          connectorEnabled: false,
          revocationError: "Provider revocation unconfirmed",
        }}
      />,
    );
    expect(html).toContain("Disconnect pending");
    expect(html).toContain("Connector disabled");
    expect(html).toContain("No access is currently available");
    expect(html).toContain("Provider revocation unconfirmed");
    expect(html).not.toContain("<button");
  });
});
