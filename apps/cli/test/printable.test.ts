import { describe, expect, it } from "vitest";
import { printable } from "../src/git/printable.js";

describe("printable", () => {
  it("keeps letters of any script, umlauts included", () => {
    expect(printable("Git-App Übersicht für Größen")).toBe("Git-App Übersicht für Größen");
  });

  it("replaces control, bidirectional, zero-width and line-separator characters", () => {
    expect(printable("a\u001b[31mb\nc‮d​e f")).toBe("a?[31mb?c?d?e?f");
  });

  it("bounds the length", () => {
    expect(printable("x".repeat(10), 4)).toBe("xxxx");
  });
});
