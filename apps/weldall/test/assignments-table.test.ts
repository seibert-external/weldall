import { describe, expect, it } from "vitest";
import { sortScopeKeys } from "../src/app/(admin)/assignments/sort-scope-keys";

describe("assignment scope badges", () => {
  it("renders scope keys alphabetically without mutating the assignment data", () => {
    const scopes = ["weldall:administer", "expenses:read", "accounts:read"];

    expect(sortScopeKeys(scopes)).toEqual([
      "accounts:read",
      "expenses:read",
      "weldall:administer",
    ]);
    expect(scopes).toEqual(["weldall:administer", "expenses:read", "accounts:read"]);
  });
});
