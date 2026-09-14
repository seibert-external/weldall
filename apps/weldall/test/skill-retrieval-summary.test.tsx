import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryOptions: vi.fn(),
  useQuery: vi.fn(),
  useTRPC: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("../src/trpc/react", () => ({ useTRPC: mocks.useTRPC }));
// The real popover renders its content into a layer only while it is open, so the test renders the
// content inline to assert the full retriever list the trigger hands to it.
vi.mock("@astryxdesign/core/Popover", () => ({
  Popover: (props: {
    children?: ReactNode;
    content?: ReactNode;
    hasCloseButton?: boolean;
    label?: string;
  }) => (
    <div data-has-close-button={String(props.hasCloseButton)} data-popover-label={props.label}>
      {props.children}
      {props.content}
    </div>
  ),
}));

import { SkillRetrievalSummarySection } from "../src/app/_components/skill-retrieval-summary";

const defaultSummary = {
  skillSlug: "expense-review",
  windowDays: 7,
  uniqueRetrievalCount: 5,
  uniqueRetrievers: [
    { id: "user-a", displayName: "Avery Analyst", avatarUrl: "/api/avatars/user-a" },
    { id: "user-b", displayName: "Bea Builder", avatarUrl: null },
  ],
};

describe("skill retrieval summary section", () => {
  beforeEach(() => {
    mocks.queryOptions.mockReset().mockReturnValue({
      queryKey: ["skillRetrievalMetrics.summary", defaultSummary.skillSlug, 7],
    });
    mocks.useTRPC.mockReset().mockReturnValue({
      skillRetrievalMetrics: {
        summary: {
          queryOptions: mocks.queryOptions,
        },
      },
    });
    mocks.useQuery.mockReset().mockReturnValue({
      data: defaultSummary,
      error: null,
    });
  });

  it("derives a tRPC query and renders the default 7-day metric", () => {
    const html = renderToStaticMarkup(
      <SkillRetrievalSummarySection
        slug={defaultSummary.skillSlug}
        initialSummary={defaultSummary}
      />,
    );

    expect(mocks.queryOptions).toHaveBeenCalledWith({
      slug: defaultSummary.skillSlug,
      days: 7,
    });
    expect(mocks.useQuery).toHaveBeenCalledWith(
      expect.objectContaining({ initialData: defaultSummary }),
    );
    expect(html).toContain("Retrievals");
    expect(html).toContain("5 unique retrievals in the last 7 days");
    expect(html).toContain("Avery Analyst");
    expect(html).not.toContain("skill-retriever-more");
  });

  it("supports a custom window", () => {
    const customSummary = {
      ...defaultSummary,
      windowDays: 14,
      uniqueRetrievalCount: 2,
    };
    mocks.useQuery.mockReset().mockReturnValue({ data: customSummary, error: null });

    const html = renderToStaticMarkup(
      <SkillRetrievalSummarySection
        days={14}
        initialSummary={customSummary}
        slug={customSummary.skillSlug}
      />,
    );

    expect(mocks.queryOptions).toHaveBeenCalledWith({
      slug: customSummary.skillSlug,
      days: 14,
    });
    expect(html).toContain("2 unique retrievals in the last 14 days");
  });

  it("lists ten retrievers in the sidebar and opens the full list in a popover", () => {
    const manySummary = {
      ...defaultSummary,
      uniqueRetrievalCount: 12,
      uniqueRetrievers: Array.from({ length: 12 }, (_, index) => ({
        id: `user-${index}`,
        displayName: `Retriever ${index}`,
        avatarUrl: null,
      })),
    };
    mocks.useQuery.mockReset().mockReturnValue({ data: manySummary, error: null });

    const html = renderToStaticMarkup(
      <SkillRetrievalSummarySection slug={manySummary.skillSlug} initialSummary={manySummary} />,
    );

    expect(html).toContain("and 2 more users");
    expect(html).toContain('data-has-close-button="false"');
    expect(html).toContain(
      'data-popover-label="Users who retrieved this skill in the last 7 days"',
    );
    // Ten rows in the sidebar plus every row in the popover.
    expect(html.match(/<li/g)).toHaveLength(10 + manySummary.uniqueRetrievers.length);
  });
});
