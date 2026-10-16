import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConnectorDialog } from "../src/app/admin/connectors/provider-dialog";
import { GoogleConnectorDialog } from "../src/app/admin/connectors/configuration-page";
import { AtlassianConnectorDialog } from "../src/app/admin/connectors/providers/atlassian-dialog";
import { AtlassianMcpConnectorDialog } from "../src/app/admin/connectors/providers/atlassian-mcp-dialog";

// Render dialog content without a portal; this is an SSR unit test, not a browser test.
vi.mock("@astryxdesign/core/Dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}));
vi.mock("@astryxdesign/core/MultiSelector", () => ({
  MultiSelector: ({
    label,
    hasSearch,
    searchPlaceholder,
  }: {
    label: string;
    hasSearch?: boolean;
    searchPlaceholder?: string;
  }) => (
    <div
      data-selector={label}
      data-searchable={hasSearch ? "true" : "false"}
      data-search-placeholder={searchPlaceholder}
    />
  ),
}));
vi.mock("../src/app/_components/use-operation-toast", () => ({
  useOperationToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/trpc/react", () => ({
  useTRPC: () => ({ admin: { managed: { saveConnector: { mutationOptions: () => ({}) } } } }),
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ isPending: false, error: null, mutateAsync: vi.fn() }),
}));
const props = {
  connector: null,
  scopeOptions: [],
  onClose: vi.fn(),
  onDelete: vi.fn(),
  onSaved: vi.fn(),
};

describe("connector dialog presentation", () => {
  it("includes local brand marks with the provider selection buttons", () => {
    const html = renderToStaticMarkup(<ConnectorDialog {...props} googleDialog={() => null} />);
    expect(html).toContain("Google Workspace");
    expect(html).toContain("Atlassian Cloud");
    expect(html).toContain("Atlassian MCP");
    expect(html).toContain('fill="#4285F4"');
    expect(html).toContain('fill="#0052CC"');
    expect(html.match(/<svg/g)).toHaveLength(3);
  });
  it("configures MCP without an endpoint, client ID or client secret", () => {
    const html = renderToStaticMarkup(<AtlassianMcpConnectorDialog {...props} />);
    expect(html).toContain("Add Atlassian MCP connector");
    expect(html).toContain('data-selector="Allowed permissions"');
    expect(html).toContain('data-selector="Required Weldall scopes"');
    expect(html).toContain("Connector key");
    expect(html).toContain("Envelope provider");
    expect(html).not.toContain("OAuth client ID");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("Endpoint URL");
  });
  it.each([GoogleConnectorDialog, AtlassianConnectorDialog])(
    "allows disabled OAuth drafts without a client secret",
    (Component) => {
      const html = renderToStaticMarkup(<Component {...props} />);
      const password = html.match(/<input[^>]*type="password"[^>]*>/)?.[0];
      expect(password).toBeDefined();
      expect(password).not.toContain("required");
      expect(html).toContain("Optional for disabled drafts");
    },
  );
  it("uses the standard labeled textarea without presets or the setup paragraph", () => {
    const html = renderToStaticMarkup(<AtlassianConnectorDialog {...props} />);
    expect(html).toContain("Allowed site cloud IDs");
    expect(html).toContain("Enter one cloud ID per line.");
    expect(html).toContain("<textarea");
    expect(html).toContain('rows="4"');
    expect(html).not.toContain("Cloud preset");
    expect(html).not.toContain("Create a resource-level OAuth");
    expect(html).not.toContain("Register the callback URL");
    expect(html).not.toContain("rounded border p-2");
    expect(html.match(/data-searchable="true"/g)).toHaveLength(2);
    expect(html).toContain('data-selector="Allowed permissions"');
    expect(html).toContain('data-selector="Selected by default"');
    expect(html).toContain('data-search-placeholder="Search permissions..."');
    expect(html).toContain('type="button"');
    expect(html).toContain("Select all");
  });
});
