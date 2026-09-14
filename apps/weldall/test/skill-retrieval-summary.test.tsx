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
  });

  it("renders each retriever with the proxied avatar and an initials fallback", () => {
    const html = renderToStaticMarkup(
      <SkillRetrievalSummarySection
        slug={defaultSummary.skillSlug}
        initialSummary={defaultSummary}
      />,
    );

    expect(html).toContain('src="/api/avatars/user-a"');
    expect(html).not.toContain("/api/avatars/user-b");
    expect(html).toContain("Avery Analyst");
    expect(html).toContain("Bea Builder");
    expect(html).toContain(">BB<");
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

  it("lists at most ten retrievers and summarizes the rest", () => {
    const manySummary = {
      ...defaultSummary,
      uniqueRetrievalCount: 12,
      uniqueRetrievers: Array.from({ length: 12 }, (_, index) => ({
        id: `user-${index}`,
        displayName: `User ${index}`,
        avatarUrl: null,
      })),
    };
    mocks.useQuery.mockReset().mockReturnValue({ data: manySummary, error: null });

    const html = renderToStaticMarkup(
      <SkillRetrievalSummarySection slug={manySummary.skillSlug} initialSummary={manySummary} />,
    );

    expect(html).toContain("User 9");
    expect(html).not.toContain("User 10");
    expect(html).toContain("and 2 more users");
  });
});
