import { describe, expect, it, vi } from "vitest";
import { explainScope, printPermissions } from "../src/commands.js";
import { brandHeading, printError, terminalDocument, terminalText } from "../src/output.js";

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
  it("shows names and grants without technical registry URLs", () => {
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
    expect(text).toContain("Expenses");
    expect(text).toContain("expenses:read");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("private-client-shape");
    output.mockRestore();
  });
});

describe("CLI brand", () => {
  it("centers the Weldall wordmark", () => {
    expect(brandHeading(21)).toBe("       Weldall");
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
