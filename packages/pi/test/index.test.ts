import { describe, expect, it } from "vitest";
import { commandName } from "../src/index.js";

describe("WeldAll command names", () => {
  it("normalizes unsafe ids and avoids collisions", () => {
    const used = new Set<string>();
    expect(commandName("Finance/Review", used)).toBe("weldall-finance-review");
    expect(commandName("finance review", used)).toBe("weldall-finance-review-2");
    expect(commandName("!!!", used)).toBe("weldall-skill");
  });
});
