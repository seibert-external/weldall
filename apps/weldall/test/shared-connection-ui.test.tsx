import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsTable } from "../src/app/admin/connections/connections-table";
import { SharedConnectionForm } from "../src/app/admin/connections/shared-connection-form";
import type { ConnectionRow } from "../src/app/admin/connections/connection-view";

const mocks = vi.hoisted(() => ({ connections: [] as unknown[] }));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof React>();
  return { ...react, useState: vi.fn(react.useState) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("nuqs", () => ({
  parseAsString: { withDefault: () => ({}) },
  useQueryStates: () => [{ search: "", status: "", connector: "", access: "" }, vi.fn()],
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data:
      queryKey[0] === "configuration"
        ? { connectors: [] }
        : queryKey[0] === "connections"
          ? mocks.connections
          : [],
    isPending: false,
  }),
  useMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../src/trpc/react", () => ({
  useTRPC: () => ({
    admin: {
      managed: {
        configuration: { queryOptions: () => ({ queryKey: ["configuration"] }) },
        connections: { queryOptions: () => ({ queryKey: ["connections"] }) },
        createSharedConnection: { mutationOptions: vi.fn() },
        updateSharedAccess: { mutationOptions: vi.fn() },
        rotateSharedCredential: { mutationOptions: vi.fn() },
        setSharedConnectionEnabled: { mutationOptions: vi.fn() },
      },
      scopes: { options: { queryOptions: () => ({ queryKey: ["scopes"] }) } },
    },
  }),
}));
vi.mock("../src/app/_components/herocrumbs", () => ({
  HerocrumbsActions: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(() => {
  vi.clearAllMocks();
  mocks.connections = [];
});

describe("shared connection form", () => {
  it("distinguishes the identifier from the token without permission or organization checkboxes", () => {
    const html = renderToStaticMarkup(<SharedConnectionForm />);
    expect(html).toContain("Connection identifier (not the API token)");
    expect(html).toContain("Atlassian API token (secret)");
    expect(html).toContain("Display name");
    expect(html).not.toContain("Service-account label");
    expect(html).toContain('type="password"');
    expect(html).toContain("This is not a secret.");
    expect(html).toContain("Weldall use scopes control who can use this connection");
    expect(html).not.toContain("Configured Atlassian permissions");
    expect(html).not.toContain("API-token authentication is enabled in my Atlassian organization");
  });

  it.each(["READY", "DISABLED", "RECONNECT_REQUIRED"] as const)(
    "offers activation only for the appropriate state: %s",
    (status) => {
      const connection: ConnectionRow = {
        id: "shared",
        accessMode: "SCOPED",
        key: "bot",
        useScopes: ["jira:shared"],
        capabilities: ["mcp"],
        ownerId: "owner",
        connectorId: "connector",
        connectorKey: "atlassian",
        name: "Bot",
        accountId: "bot",
        accountName: "Bot",
        owner: { name: "Alice", email: "alice@example.com" },
        connectorEnabled: true,
        status,
        version: 3,
        selectedScopes: [],
        grantedScopes: [],
        scopeLabels: {},
        requestCount: 0,
        revocationError: null,
        lastUsedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      const html = renderToStaticMarkup(<SharedConnectionForm connection={connection} />);
      const label = status === "DISABLED" ? "Enable connection" : "Disable connection";
      const button = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find((match) =>
        match[0].includes(label),
      )?.[0];
      expect(button).toBeDefined();
      expect(button!.includes("disabled=")).toBe(status === "RECONNECT_REQUIRED");
      expect(html).not.toContain(
        status === "DISABLED" ? "Disable connection" : "Enable connection",
      );
    },
  );

  it("replaces the table and filters with the creation view and a way back", () => {
    vi.mocked(React.useState).mockReturnValueOnce([true, vi.fn()]);
    const html = renderToStaticMarkup(<ConnectionsTable />);
    expect(html).toContain("Create shared connection");
    expect(html).toContain("Back to connections");
    expect(html).not.toContain("Managed connections table");
    expect(html).not.toContain("Connection filters");
    expect(html).not.toContain("Find connections");
    expect(html).not.toContain("connections shown");
  });

  it.each(["SCOPED", "OWNER_ONLY"])(
    "shows a separate account label only for personal connections: %s",
    (accessMode) => {
      mocks.connections = [
        {
          id: "connection-1",
          name: "Team connection",
          accountName: "provider-account-label",
          accessMode,
          key: accessMode === "SCOPED" ? "team-bot" : null,
          owner: { name: "Alice", email: "alice@example.com" },
          connectorKey: "workspace",
          status: "READY",
          connectorEnabled: true,
          lastUsedAt: null,
        },
      ];
      const html = renderToStaticMarkup(<ConnectionsTable />);
      expect(html).toContain("Team connection");
      expect(html.includes("provider-account-label")).toBe(accessMode === "OWNER_ONLY");
      const cells = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((match) => match[1]!);
      const type = accessMode === "SCOPED" ? "Shared" : "Personal";
      const detail = accessMode === "SCOPED" ? "team-bot" : "provider-account-label";
      expect(cells[0]).toContain('class="flex w-max gap-2 whitespace-nowrap"');
      expect(cells[0]).toContain(
        `<span>Team connection</span><span class="text-secondary">${detail}</span>`,
      );
      expect(cells[0]).not.toContain(type);
      expect(cells[0]).not.toMatch(/text-xs|font-medium|<code/);
      expect(cells[1]).toBe(type);
    },
  );

  it("keeps the table and filters in the normal overview", () => {
    const html = renderToStaticMarkup(<ConnectionsTable />);
    expect(html).toContain("Managed connections table");
    expect(html).toContain("Connection filters");
    expect(html).toContain("Add shared connection");
    expect(html).not.toContain("Create shared connection");
  });
});
