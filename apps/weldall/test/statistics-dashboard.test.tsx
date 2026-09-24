import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageStatistics } from "../src/server/statistics/service";

const mocks = vi.hoisted(() => ({
  queryOptions: vi.fn(),
  useQuery: vi.fn(),
  useTRPC: vi.fn(),
  useQueryState: vi.fn(),
  withDefault: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("../src/trpc/react", () => ({ useTRPC: mocks.useTRPC }));
vi.mock("nuqs", () => ({
  parseAsStringLiteral: () => ({
    withDefault: (value: string) => {
      mocks.withDefault(value);
      return { withOptions: () => ({}) };
    },
  }),
  useQueryState: mocks.useQueryState,
}));
// The chart has its own test. Here it only has to show which rows it received.
vi.mock("../src/app/_components/statistics-bar-chart", () => ({
  StatisticsBarChart: ({
    ariaLabel,
    rows,
  }: {
    ariaLabel: string;
    rows: { key: string; label: string; value: number }[];
  }) => (
    <ol aria-label={ariaLabel}>
      {rows.map((row) => (
        <li key={row.key}>{`${row.label}: ${row.value}`}</li>
      ))}
    </ol>
  ),
}));

import { StatisticsDashboard } from "../src/app/_components/statistics-dashboard";

const statistics: UsageStatistics = {
  interval: "7d",
  activeHumans: {
    count: 23,
    previousCount: 20,
    users: Array.from({ length: 20 }, (_, index) => ({
      id: `user-${index}`,
      displayName: `Person ${index}`,
      avatarUrl: null,
    })),
  },
  machines: { count: 2 },
  resources: [{ resource: "https://expenses.example.com", name: "Expenses", exchanges: 12 }],
  skills: [{ slug: "expense-review", title: "Expense review", retrievers: 4 }],
};

const emptyStatistics: UsageStatistics = {
  interval: "7d",
  activeHumans: { count: 0, previousCount: 0, users: [] },
  machines: { count: 0 },
  resources: [],
  skills: [],
};

function render(initialStatistics: UsageStatistics | null, initialInterval = "7d" as const) {
  return renderToStaticMarkup(
    <StatisticsDashboard initialInterval={initialInterval} initialStatistics={initialStatistics} />,
  );
}

describe("statistics dashboard", () => {
  beforeEach(() => {
    mocks.queryOptions.mockReset().mockImplementation((input: unknown) => ({
      queryKey: ["statistics.summary", input],
    }));
    mocks.useTRPC.mockReset().mockReturnValue({
      statistics: { summary: { queryOptions: mocks.queryOptions } },
    });
    mocks.useQuery
      .mockReset()
      .mockReturnValue({ data: statistics, error: null, isFetching: false });
    mocks.useQueryState.mockReset().mockReturnValue(["7d", vi.fn()]);
    mocks.withDefault.mockReset();
  });

  it("renders every widget from the initial statistics", () => {
    const html = render(statistics);

    expect(mocks.queryOptions).toHaveBeenCalledWith({ interval: "7d" });
    expect(mocks.useQuery).toHaveBeenCalledWith(
      expect.objectContaining({ initialData: statistics }),
    );
    expect(html).toContain(">23<");
    expect(html).toContain("+3 compared with the previous 7 days");
    expect(html).toContain("Person 0");
    expect(html).toContain("and 3 more");
    expect(html).toContain("Expenses: 12");
    expect(html).toContain("Expense review: 4");
    expect(html).toContain("Machine tokens are not included.");
    expect(html).toContain(">2<");
  });

  it("uses the resolved interval as the URL default", () => {
    const monthly = { ...statistics, interval: "30d" as const };
    mocks.useQueryState.mockReturnValue(["30d", vi.fn()]);
    mocks.useQuery.mockReturnValue({ data: monthly, error: null, isFetching: false });

    const html = renderToStaticMarkup(
      <StatisticsDashboard initialInterval="30d" initialStatistics={monthly} />,
    );

    expect(mocks.withDefault).toHaveBeenCalledWith("30d");
    expect(mocks.queryOptions).toHaveBeenCalledWith({ interval: "30d" });
    expect(mocks.useQuery).toHaveBeenCalledWith(expect.objectContaining({ initialData: monthly }));
    expect(html).toContain("compared with the previous 30 days");
  });

  it("does not seed another interval with the initial data", () => {
    mocks.useQueryState.mockReturnValue(["30d", vi.fn()]);
    mocks.useQuery.mockReturnValue({ data: undefined, error: null, isFetching: true });

    const html = render(statistics);

    expect(mocks.queryOptions).toHaveBeenCalledWith({ interval: "30d" });
    expect(mocks.useQuery.mock.calls[0]?.[0]).not.toHaveProperty("initialData");
    // The 7-day numbers stay on screen, labelled as 7 days, until the 30-day ones arrive.
    expect(html).toContain("Person 0");
    expect(html).toContain("compared with the previous 7 days");
  });

  it("shows one empty state per widget", () => {
    mocks.useQuery.mockReturnValue({ data: emptyStatistics, error: null, isFetching: false });

    const html = render(emptyStatistics);

    expect(html).toContain("No active people in the last 7 days.");
    expect(html).toContain("No resource exchanges in the last 7 days.");
    expect(html).toContain("No skills retrieved in the last 7 days.");
    expect(html).toContain("No machine tokens in the last 7 days.");
    expect(html).not.toContain("compared with");
  });

  it("hides the comparison when the previous period had nobody", () => {
    const fresh = {
      ...statistics,
      activeHumans: { ...statistics.activeHumans, previousCount: 0 },
    };
    mocks.useQuery.mockReturnValue({ data: fresh, error: null, isFetching: false });

    expect(render(fresh)).not.toContain("compared with");
  });

  it("keeps the last numbers when a refetch fails", () => {
    mocks.useQuery.mockReturnValue({
      data: undefined,
      error: { message: "boom", data: { code: "INTERNAL_SERVER_ERROR" } },
      isFetching: false,
    });

    const html = render(statistics);

    expect(html).toContain("Statistics could not be refreshed.");
    expect(html).toContain("Person 0");
  });

  it("says statistics are unavailable when nothing ever loaded", () => {
    mocks.useQuery.mockReturnValue({
      data: undefined,
      error: { message: "boom", data: { code: "INTERNAL_SERVER_ERROR" } },
      isFetching: false,
    });

    expect(render(null)).toContain("Statistics unavailable.");
  });

  it("shows access denied when the scope was removed", () => {
    mocks.useQuery.mockReturnValue({
      data: undefined,
      error: { message: "Statistics access is required.", data: { code: "FORBIDDEN" } },
      isFetching: false,
    });

    const html = render(statistics);

    expect(html).toContain("Statistics access required");
    expect(html).not.toContain("Person 0");
  });
});
