import { describe, expect, it } from "vitest";
import type { SkillList, SkillSummary } from "../src/services/skills.js";
import { skillsToon } from "../src/skills-toon.js";

const skill = (overrides: Partial<SkillSummary> = {}): SkillSummary => ({
  slug: "expenses.review",
  title: "Review expenses",
  preview: "Review submitted company expenses.",
  requiredScopes: ["expenses:read"],
  visibility: "DEFAULT",
  available: true,
  missingScopes: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
  source: { type: "admin" },
  ...overrides,
});

const list = (overrides: Partial<SkillList> = {}): SkillList => ({
  items: [skill()],
  warnings: [],
  ...overrides,
});

const rows = (output: string) =>
  output.split("\n").filter((line) => line.startsWith("  ") && line.trim() !== "");

describe("skillsToon", () => {
  it("declares how many rows follow, which is the whole reason for this output", () => {
    const output = skillsToon(list({ items: [skill(), skill({ slug: "expenses.submit" })] }));
    expect(output).toContain(
      "items[2\t]{slug\ttitle\tpreview\ttags\tavailable\tmissingScopes\tsource}:",
    );
    expect(rows(output)).toHaveLength(2);
  });

  it("declares the tab delimiter in the bracket segment", () => {
    // Comma is TOON's default. A reader that misses this reads seven columns as one.
    expect(skillsToon(list())).toMatch(/items\[1\t\]\{/u);
  });

  it("leaves a comma in a preview unquoted, which is why the delimiter is tab", () => {
    const output = skillsToon(
      list({ items: [skill({ preview: "Contracts, expenses, invoices" })] }),
    );
    expect(rows(output)[0]).toContain("Contracts, expenses, invoices");
    expect(output).not.toContain('"Contracts, expenses, invoices"');
  });

  it("quotes and escapes a value that would otherwise forge a column or a row", () => {
    const output = skillsToon(
      list({ items: [skill({ title: "Review\texpenses", preview: 'He said "no"\nthen left' })] }),
    );
    const [row] = rows(output);
    expect(row).toContain('"Review\\texpenses"');
    expect(row).toContain('"He said \\"no\\"\\nthen left"');
    expect(rows(output)).toHaveLength(1);
  });

  it("quotes an empty cell so a missing value cannot shift the columns", () => {
    const output = skillsToon(list({ items: [skill({ missingScopes: [] })] }));
    expect(rows(output)[0].split("\t")).toHaveLength(7);
    expect(rows(output)[0]).toContain('""');
  });

  it("joins tags and missing scopes with a pipe, inside one column each", () => {
    const output = skillsToon(
      list({
        items: [
          skill({
            available: false,
            missingScopes: ["invite:read", "invite:write"],
            meta: { tags: ["invite", "events"] },
          }),
        ],
      }),
    );
    const cells = rows(output)[0].split("\t");
    expect(cells).toHaveLength(7);
    expect(cells[3]).toBe("invite|events");
    expect(cells[4]).toBe("false");
    expect(cells[5]).toBe("invite:read|invite:write");
  });

  it("names the resource a skill came from, and calls an admin skill admin", () => {
    const output = skillsToon(
      list({
        items: [
          skill({ source: { type: "resource", key: "templates", name: "Contract Templates" } }),
          skill({ slug: "merch-shop", source: { type: "admin" } }),
        ],
      }),
    );
    expect(rows(output)[0].split("\t")[6]).toBe("Contract Templates");
    expect(rows(output)[1].split("\t")[6]).toBe("admin");
  });

  it("emits an empty array as `key: []`, the only form a TOON encoder may write", () => {
    const output = skillsToon(list());
    expect(output).toContain("warnings: []");
    expect(output).not.toContain("warnings[0");
  });

  it("carries warnings as their own counted block, because the agent branches on them", () => {
    const output = skillsToon(
      list({ warnings: [{ source: "contracts", code: "catalog_expired" }] }),
    );
    expect(output).toContain("warnings[1\t]{source\tcode}:");
    expect(output).toContain("  contracts\tcatalog_expired");
  });

  it("says nothing at all when the catalog is empty, without losing either field", () => {
    const output = skillsToon(list({ items: [] }));
    expect(output).toBe("items: []\nwarnings: []\n");
  });
});
