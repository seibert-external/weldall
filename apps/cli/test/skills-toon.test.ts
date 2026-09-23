import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import type { SkillDetail, SkillList, SkillSummary } from "../src/services/skills.js";
import { skillDetailToon, skillMatchesToon, skillsToon } from "../src/skills-toon.js";
import type { CachedSkillPreview } from "../src/storage/appendix.js";

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
    // A colon forces quotes; a pipe does not, because tab is the declared delimiter here.
    expect(cells[5]).toBe('"invite:read|invite:write"');
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

  it("round-trips a preview holding a comma, a tab, and a line break", () => {
    const decoded = decode(
      skillsToon(
        list({ items: [skill({ preview: 'Contracts, expenses\tand "invoices"\nfiled' })] }),
      ),
      { delimiter: "\t" },
    ) as { items: { preview: string; available: boolean }[] };
    expect(decoded.items[0].preview).toBe('Contracts, expenses\tand "invoices"\nfiled');
    expect(decoded.items[0].available).toBe(true);
  });
});

const detail = (overrides: Partial<SkillDetail> = {}): SkillDetail => ({
  ...skill(),
  content: "Submitted expenses are reviewed against policy.",
  document: "# Review expenses\n\nSubmitted expenses are reviewed against policy.\n",
  ...overrides,
});

const fields = (output: string) =>
  Object.fromEntries(
    output
      .split("\n")
      .filter((line) => line.includes(":"))
      .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]),
  );

describe("skillDetailToon", () => {
  it("writes one object, because a single skill is not an array", () => {
    const output = skillDetailToon(detail());
    expect(output).not.toContain("skill[1");
    expect(fields(output).slug).toBe("expenses.review");
    expect(fields(output).title).toBe("Review expenses");
  });

  it("escapes the document's line breaks, which keeps the output decodable", () => {
    const output = skillDetailToon(detail({ document: "# Review\n\nBody text.\n" }));
    expect(output).toContain('document: "# Review\\n\\nBody text.\\n"');
    expect(output.split("\n").filter((line) => line !== "")).toHaveLength(7);
  });

  it("omits content, which the document already carries", () => {
    const output = skillDetailToon(detail({ content: "Body only, no heading." }));
    expect(output).not.toContain("content:");
    expect(output).not.toContain("Body only, no heading.");
  });

  it("omits the preview, which the document supersedes", () => {
    const output = skillDetailToon(detail({ preview: "A shortened preview." }));
    expect(output).not.toContain("preview:");
  });

  it("carries tags inline and an empty scope list as `[]`", () => {
    const output = skillDetailToon(detail({ meta: { tags: ["finance", "approvals"] } }));
    expect(output).toContain("tags[2\t]: finance\tapprovals");
    expect(output).toContain("missingScopes: []");
  });

  it("round-trips the document, line breaks and all", () => {
    const document = '# Review\n\nBody "text", with a comma.\n';
    const decoded = decode(skillDetailToon(detail({ document })), { delimiter: "\t" }) as {
      document: string;
      missingScopes: string[];
    };
    expect(decoded.document).toBe(document);
    expect(decoded.missingScopes).toEqual([]);
  });

  it("names the resource a skill came from, and calls an admin skill admin", () => {
    expect(
      skillDetailToon(detail({ source: { type: "resource", key: "expenses", name: "Expenses" } })),
    ).toContain("source: Expenses");
    expect(skillDetailToon(detail({ source: { type: "admin" } }))).toContain("source: admin");
  });
});

const cached = (overrides: Partial<CachedSkillPreview> = {}): CachedSkillPreview => ({
  slug: "expenses.review",
  title: "Review expenses",
  available: true,
  preview: "Review submitted company expenses.",
  tags: ["finance"],
  owner: "Finance",
  sourceKey: "expenses",
  sourceName: "Expenses",
  ...overrides,
});

describe("skillMatchesToon", () => {
  it("declares how many matches follow, so a truncated read is visible", () => {
    const output = skillMatchesToon([cached(), cached({ slug: "expenses.submit" })]);
    expect(output).toContain("items[2\t]{slug\ttitle\tpreview\ttags\tavailable\towner\tsource}:");
    expect(rows(output)).toHaveLength(2);
  });

  it("omits missingScopes, because the cache does not hold it", () => {
    // An empty column here would read as `nothing is missing`, which the cache cannot promise.
    expect(skillMatchesToon([cached()])).not.toContain("missingScopes");
  });

  it("quotes a cached field the catalog never filled, so the columns cannot shift", () => {
    const cells = rows(
      skillMatchesToon([
        cached({ preview: undefined, tags: undefined, owner: undefined, sourceName: undefined }),
      ]),
    )[0].split("\t");
    expect(cells).toHaveLength(7);
    expect(cells[2]).toBe('""');
    expect(cells[6]).toBe("expenses");
  });

  it("says nothing at all when the search matched nothing", () => {
    expect(skillMatchesToon([])).toBe("items: []\n");
  });

  it("round-trips through the reference decoder", () => {
    const decoded = decode(skillMatchesToon([cached()]), { delimiter: "\t" }) as {
      items: { slug: string; source: string }[];
    };
    expect(decoded.items).toHaveLength(1);
    expect(decoded.items[0].slug).toBe("expenses.review");
    expect(decoded.items[0].source).toBe("Expenses");
  });
});
