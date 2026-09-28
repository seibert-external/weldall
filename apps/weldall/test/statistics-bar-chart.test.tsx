import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatisticsBarChart } from "../src/app/_components/statistics-bar-chart";

function occurrences(html: string, text: string) {
  return html.split(text).length - 1;
}

describe("statistics bar chart", () => {
  it("renders an SVG bar chart during server rendering", () => {
    const html = renderToStaticMarkup(
      <StatisticsBarChart
        ariaLabel="Token exchanges by resource"
        valueLabel="Exchanges"
        rows={[
          { key: "https://expenses.example.com", label: "Expenses", value: 12 },
          { key: "https://travel.example.com", label: "Travel", value: 3 },
        ]}
      />,
    );

    expect(html).toContain("<svg");
    expect(html).toContain("Token exchanges by resource");
    expect(html).toContain("Expenses");
    expect(html).toContain("Travel");
  });

  it("keeps rows apart when two share a label", () => {
    const html = renderToStaticMarkup(
      <StatisticsBarChart
        ariaLabel="Token exchanges by resource"
        valueLabel="Exchanges"
        rows={[
          { key: "https://one.example.com", label: "Expenses", value: 12 },
          { key: "https://two.example.com", label: "Expenses", value: 3 },
        ]}
      />,
    );

    expect(occurrences(html, "Expenses")).toBeGreaterThanOrEqual(2);
  });
});
