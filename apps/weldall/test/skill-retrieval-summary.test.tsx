import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryOptions: vi.fn(),
  useQuery: vi.fn(),
  useTRPC: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("../src/trpc/react", () => ({ useTRPC: mocks.useTRPC }));

import { SkillRetrievalSummarySection } from "../src/app/_components/skill-retrieval-summary";

const defaultSummary = {
  skillSlug: "expense-review",
  windowDays: 7,
  uniqueRetrievalCount: 5,
  uniqueRetrievers: [
    { id: "user-a", displayName: "Avery Analyst" },
    { id: "user-b", displayName: "Bea Builder" },
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
});
