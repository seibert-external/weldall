import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { explainScope, formatSkillWarning, printPermissions } from "../src/commands.js";
import {
  appendixFrame,
  brandHeading,
  Card,
  helpHeader,
  FieldList,
  Notice,
  printError,
  renderUi,
  SkillsCard,
  terminalDocument,
  terminalText,
} from "../src/output.js";
import { printFriendlyValidation } from "../src/validation.js";

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

    expect(text).toContain("╭");
    expect(text).toContain("Access");
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
    id: "expenses.review",
    title: "Review expenses",
    available: true,
    missingScopes: [],
  };

  it("renders the skill name, ID, and availability in an Ink panel", () => {
    const output = renderUi(createElement(SkillsCard, { skills: [skill] }));

    expect(output).toContain("╭");
    expect(output).toContain("Skills");
    expect(output).toContain("✓ Review expenses");
    expect(output).toContain("ID: expenses.review");
  });

  it("explains unavailable skills and their missing scopes", () => {
    const output = renderUi(
      createElement(SkillsCard, {
        skills: [
          {
            ...skill,
            available: false,
            missingScopes: ["expenses:read", "expenses:write"],
          },
        ],
      }),
    );

    expect(output).toContain("! Review expenses");
    expect(output).toContain("Not available · missing expenses:read, expenses:write");
  });

  it("turns catalog warnings into user-facing sentences", () => {
    expect(
      formatSkillWarning({ source: "expenses", code: "catalog_temporarily_unavailable" }),
    ).toBe("Skills from expenses may be outdated because the catalog could not be refreshed.");
  });
});

describe("CLI brand", () => {
  it("renders the host and signed-in account in a rounded frame", () => {
    vi.stubEnv("NO_COLOR", "1");
    const heading = brandHeading("https://weldall.example.com", {
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    const lines = heading.split("\n");

    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(heading).toContain("Weldall");
    expect(heading).toMatch(/Host\s+https:\/\/weldall\.example\.com/);
    expect(heading).toMatch(/Name\s+Ada Lovelace/);
    expect(heading).toMatch(/Email\s+ada@example\.com/);
    expect(new Set(lines.map((line) => line.length))).toHaveLength(1);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
    expect(heading).not.toContain("\u001B");
    vi.unstubAllEnvs();
  });

  it("shows when no host or account is configured", () => {
    vi.stubEnv("NO_COLOR", "1");
    const heading = brandHeading(null);
    expect(heading).toContain("Host");
    expect(heading).toContain("Not configured");
    expect(heading).toContain("Account");
    expect(heading).toContain("Not signed in");
    vi.unstubAllEnvs();
  });

  it("stacks the header and capped scope and skill previews vertically", () => {
    vi.stubEnv("NO_COLOR", "1");
    const heading = helpHeader(
      "https://weldall.example.com",
      { name: "Ada Lovelace", email: "ada@example.com" },
      "Use approved skills.",
      ["one:read", "two:read", "three:read", "four:read", "five:read", "six:read"],
      [
        { slug: "one", title: "One", available: true },
        { slug: "two", title: "Two", available: true },
        { slug: "three", title: "Three", available: true },
        { slug: "four", title: "Four", available: true },
        { slug: "five", title: "Five", available: true },
        { slug: "six", title: "Six", available: false },
      ],
      100,
    );
    const lines = heading.split("\n");
    const weldallIndex = lines.findIndex((line) => line.includes("Weldall"));
    const organizationIndex = lines.findIndex((line) => line.includes("Organization instructions"));
    const instructionsIndex = lines.findIndex((line) => line.includes("Use approved skills."));
    const scopesIndex = lines.findIndex((line) => line.includes("Scopes"));
    const skillsIndex = lines.findIndex((line) => line.includes("Skills"));

    expect(organizationIndex).toBeGreaterThan(weldallIndex);
    expect(instructionsIndex).toBeGreaterThan(organizationIndex);
    expect(scopesIndex).toBeGreaterThan(instructionsIndex);
    expect(skillsIndex).toBeGreaterThan(scopesIndex);
    expect(heading).toContain("• five:read");
    expect(heading).not.toContain("• six:read");
    expect(heading).toContain("… 1 more");
    expect(heading).toContain("Run `weldall scopes` to view the complete list.");
    expect(heading).toContain("Run `weldall skills` to view the complete list.");
    expect(heading).toContain("Five (five)");
    expect(heading).not.toContain("Six (six)");
    vi.unstubAllEnvs();
  });
});

describe("responsive Ink layout", () => {
  it.each([1, 4, 7])("never exceeds a %i-column terminal", (columns) => {
    const output = renderUi(createElement(Card, { title: "Weldall" }, "Host"), columns);

    expect(output.split("\n").every((line) => line.length <= columns)).toBe(true);
  });

  it.each([10, 20])("keeps field panels inside a %i-column terminal", (columns) => {
    const output = renderUi(
      createElement(
        Card,
        { title: "Configuration" },
        createElement(FieldList, {
          fields: [
            ["Issuer", "https://weldall.example.com"],
            ["Source", "preferences"],
          ],
        }),
      ),
      columns,
    );

    expect(output.split("\n").every((line) => line.length <= columns)).toBe(true);
    expect(output).toContain("Issuer");
    expect(output).toContain("Source");
  });
});

describe("CLI appendix", () => {
  it("renders organization instructions in a separate prominent frame", () => {
    vi.stubEnv("NO_COLOR", "1");
    const frame = appendixFrame("Use approved skills.\nAsk before deleting data.");
    const lines = frame.split("\n");

    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines[1]).toContain("Organization instructions");
    expect(lines[3]).toContain("Use approved skills.");
    expect(lines[4]).toContain("Ask before deleting data.");
    expect(new Set(lines.map((line) => line.length))).toHaveLength(1);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
    vi.unstubAllEnvs();
  });

  it("wraps lengthy instructions to the terminal width", () => {
    vi.stubEnv("NO_COLOR", "1");
    const frame = appendixFrame(
      "Use this CLI for all company tasks. Access to external services requires centrally managed tokens and approved skills.",
      48,
    );
    const lines = frame.split("\n");
    const content = lines.slice(3, -1).map((line) => line.slice(2, -2));

    expect(lines.every((line) => line.length === 48)).toBe(true);
    expect(content.join(" ").replaceAll(/\s+/g, " ").trim()).toBe(
      "Use this CLI for all company tasks. Access to external services requires centrally managed tokens and approved skills.",
    );
    vi.unstubAllEnvs();
  });

  it("omits the frame for an empty appendix", () => {
    expect(appendixFrame(" \n\t ")).toBe("");
  });
});

describe("validation output", () => {
  it("colors stderr when only stderr is interactive", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    const previousNoColor = process.env.NO_COLOR;
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    delete process.env.NO_COLOR;
    vi.stubEnv("TERM", "xterm-256color");

    try {
      const output = renderUi(
        createElement(Notice, { kind: "error", message: "Invalid command input" }),
        40,
        "stderr",
      );
      expect(output).toContain("\u001B[");
    } finally {
      if (descriptor) Object.defineProperty(process.stderr, "isTTY", descriptor);
      else Reflect.deleteProperty(process.stderr, "isTTY");
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
      vi.unstubAllEnvs();
    }
  });

  it("renders validation failures as Ink errors on stderr", () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    printFriendlyValidation(new AggregateError([new Error("Invalid command input")]));

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join("\n")).toContain("× Error  Invalid command input");
    stderr.mockRestore();
    stdout.mockRestore();
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
    expect(output.mock.calls.flat().join("\n")).toContain("╭");
    expect(output.mock.calls.flat().join("\n")).toContain("failed�]52;c;stolen�");
    expect(output.mock.calls.flat().join("\n")).toContain("retry�[2J");
    output.mockRestore();
  });
});
