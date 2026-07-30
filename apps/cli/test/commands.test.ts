import { describe, expect, it, vi } from "vitest";
import {
  explainScope,
  formatSkillListLine,
  formatSkillWarning,
  printPermissions,
} from "../src/commands.js";
import {
  appendixFrame,
  brandHeading,
  printError,
  terminalDocument,
  terminalText,
} from "../src/output.js";

describe("friendly scope descriptions", () => {
  it.each([
    ["expenses:read", "Read data"],
    ["expenses:create", "Create new data"],
    ["expenses:write", "Create or change data"],
    ["expenses:update", "Change existing data"],
    ["expenses:delete", "Delete data"],
    ["weldall:administer", "Manage access and settings"],
  ])("explains %s", (scope, description) => {
    expect(explainScope(scope)).toBe(description);
  });

  it("keeps unknown permissions understandable without guessing", () => {
    expect(explainScope("documents:publish")).toBe("publish permission");
  });
});

describe("friendly resource output", () => {
  it("shows assigned scopes even when no enabled resource exposes them", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printPermissions([], ["weldall:administer"]);
    const text = output.mock.calls.flat().join("\n");

    expect(text).toContain("weldall:administer");
    expect(text).toContain("No enabled API resource");
    expect(text).not.toContain("No permissions are currently assigned");
    output.mockRestore();
  });

  it("shows only API names without repeating grants or technical registry values", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printPermissions([
      {
        key: "expenses",
        name: "Expenses",
        resourceIdentifier: "https://expenses.example/api",
        authorizationServer: "https://expenses.example",
        downstreamClientId: "private-client-shape",
        requestPrefixes: ["https://expenses.example/api"],
        supportedScopes: ["expenses:read"],
        grantedScopes: ["expenses:read"],
      },
    ]);
    const text = output.mock.calls.flat().join("\n");
    const availableApis = text.split("Available APIs:")[1];
    expect(availableApis).toContain("Expenses");
    expect(availableApis).not.toContain("Read data");
    expect(availableApis).not.toContain("expenses:read");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("private-client-shape");
    output.mockRestore();
  });
});

describe("skill registry output", () => {
  const skill = {
    slug: "expenses.review",
    title: "Review expenses",
    requiredScopes: ["expenses:read"],
    visibility: "DEFAULT" as const,
    available: true,
    missingScopes: [],
    updatedAt: "2026-07-30T09:00:00.000Z",
    source: { type: "resource" as const, key: "expenses", name: "Expenses" },
  };

  it("prints the skill name followed by its ID", () => {
    expect(formatSkillListLine(skill)).toBe("Review expenses (expenses.review)");
  });

  it("explains unavailable skills and their missing scopes", () => {
    expect(
      formatSkillListLine({
        ...skill,
        available: false,
        missingScopes: ["expenses:read", "expenses:write"],
      }),
    ).toBe(
      "Review expenses (expenses.review) (not available, missing scopes: expenses:read, expenses:write)",
    );
  });

  it("turns catalog warnings into user-facing sentences", () => {
    expect(
      formatSkillWarning({ source: "expenses", code: "catalog_temporarily_unavailable" }),
    ).toBe("Skills from expenses may be outdated because the catalog could not be refreshed.");
  });
});

describe("CLI brand", () => {
  it("renders a compact framed header with the configured host", () => {
    vi.stubEnv("NO_COLOR", "1");
    const heading = brandHeading("https://weldall.example.com");
    const lines = heading.split("\n");

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^╔═+╗$/);
    expect(lines[1]).toContain("Weldall");
    expect(lines[2]).toContain("Host  https://weldall.example.com");
    expect(new Set(lines.map((line) => line.length))).toHaveLength(1);
    expect(lines[3]).toMatch(/^╚═+╝$/);
    vi.unstubAllEnvs();
  });

  it("shows when no host is configured", () => {
    vi.stubEnv("NO_COLOR", "1");
    expect(brandHeading(null)).toContain("Host  Not configured");
    vi.unstubAllEnvs();
  });
});

describe("CLI appendix", () => {
  it("renders organization instructions in a separate prominent frame", () => {
    vi.stubEnv("NO_COLOR", "1");
    const frame = appendixFrame("Use approved skills.\nAsk before deleting data.");
    const lines = frame.split("\n");

    expect(lines[0]).toContain("Organization instructions");
    expect(lines[1]).toContain("Use approved skills.");
    expect(lines[2]).toContain("Ask before deleting data.");
    expect(new Set(lines.map((line) => line.length))).toHaveLength(1);
    expect(lines.at(-1)).toMatch(/^╚═+╝$/);
    vi.unstubAllEnvs();
  });

  it("wraps and justifies lengthy instructions to the terminal width", () => {
    vi.stubEnv("NO_COLOR", "1");
    const frame = appendixFrame(
      "Use this CLI for all company tasks. Access to external services requires centrally managed tokens and approved skills.",
      48,
    );
    const lines = frame.split("\n");
    const content = lines.slice(1, -1).map((line) => line.slice(2, -2));

    expect(lines.every((line) => line.length === 48)).toBe(true);
    expect(content[0]).toMatch(/\S +\S/);
    expect(content[0]).not.toMatch(/\s$/);
    expect(content.join(" ").replaceAll(/\s+/g, " ").trim()).toBe(
      "Use this CLI for all company tasks. Access to external services requires centrally managed tokens and approved skills.",
    );
    vi.unstubAllEnvs();
  });

  it("omits the frame for an empty appendix", () => {
    expect(appendixFrame(" \n\t ")).toBe("");
  });
});

describe("terminal output safety", () => {
  it("neutralizes control characters in server-provided labels", () => {
    expect(terminalText("Expenses\u001B]8;;https://attacker.example\u0007spoofed")).toBe(
      "Expenses�]8;;https://attacker.example�spoofed",
    );
  });

  it("preserves Markdown layout while neutralizing terminal escapes", () => {
    expect(terminalDocument("# Skill\r\n\nRun this\u001B]8;;bad\u0007now\n")).toBe(
      "# Skill\n\nRun this�]8;;bad�now\n",
    );
  });

  it("sanitizes untrusted API errors at the terminal sink", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    printError("failed\u001B]52;c;stolen\u0007", "retry\u001B[2J");
    expect(output.mock.calls.flat().join("\n")).not.toContain("\u001B");
    expect(output.mock.calls.flat().join("\n")).toContain("failed�]52;c;stolen�");
    output.mockRestore();
  });
});
