import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionDetail } from "../src/app/admin/connections/connection-detail";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  mutationOptions: vi.fn((options) => options),
  mutate: vi.fn(),
  dialog: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: mocks.query,
  useMutation: () => ({ mutate: mocks.mutate, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../src/trpc/react", () => ({
  useTRPC: () => ({
    admin: {
      managed: {
        connection: { queryOptions: () => ({}), queryKey: () => [] },
        connections: { queryKey: () => [] },
        deleteConnection: { mutationOptions: mocks.mutationOptions },
      },
    },
  }),
}));
vi.mock("../src/app/_components/herocrumbs", () => ({
  HerocrumbsActions: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../src/app/_components/planet-loader", () => ({ PlanetLoader: () => null }));
vi.mock("../src/app/_components/use-operation-toast", () => ({
  useOperationToast: () => ({ error: vi.fn() }),
}));
// Inspect the dialog's confirmation contract without needing a browser portal.
vi.mock("@astryxdesign/core/AlertDialog", () => ({
  AlertDialog: (props: { title: string; description: string }) => {
    mocks.dialog(props);
    return <section aria-label={props.title}>{props.description}</section>;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReturnValue({ isPending: true, data: { name: "Team account" }, error: null });
});

describe("administrative connection deletion", () => {
  it("warns that deletion is local-only and invokes the deletion mutation", () => {
    const html = renderToStaticMarkup(<ConnectionDetail connectionId="connection-id" />);
    expect(html).toContain("Delete connection");
    expect(html).toContain("Team account");
    expect(html).toContain("This does not revoke provider access");
    expect(html).toContain("Ask the owner to disconnect first");
    expect(html).toContain("existing tokens may remain valid");
    expect(html).not.toContain("Weldall will try to revoke");
    expect(html).not.toContain("Google");
    const props = mocks.dialog.mock.calls[0]![0];
    expect(props.actionLabel).toBe("Delete connection");
    props.onAction();
    expect(mocks.mutate).toHaveBeenCalledWith({ id: "connection-id" });
    expect(mocks.mutationOptions).toHaveBeenCalledOnce();
  });
});
