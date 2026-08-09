import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScopeBadges } from "../src/app/(admin)/assignments/scope-badges";
import { sortScopeKeys } from "../src/app/(admin)/assignments/sort-scope-keys";

describe("assignment scope badges", () => {
  it("renders scope keys alphabetically without mutating the assignment data", () => {
    const scopes = ["weldall:administer", "expenses:read", "accounts:read"];

    const html = renderToStaticMarkup(createElement(ScopeBadges, { scopes }));

    expect(extractBadgeLabels(html)).toEqual([
      "accounts:read",
      "expenses:read",
      "weldall:administer",
    ]);
    expect(extractBadgeVariants(html)).toEqual(["neutral", "neutral", "purple"]);
    expect(scopes).toEqual(["weldall:administer", "expenses:read", "accounts:read"]);
  });

  it("sorts scope keys without mutating the assignment data", () => {
    const scopes = ["weldall:administer", "expenses:read", "accounts:read"];

    expect(sortScopeKeys(scopes)).toEqual(["accounts:read", "expenses:read", "weldall:administer"]);
    expect(scopes).toEqual(["weldall:administer", "expenses:read", "accounts:read"]);
  });
});

function extractBadgeLabels(html: string): string[] {
  return [...html.matchAll(/data-variant="[^"]+">([^<]+)<\/span>/g)].map((match) => match[1]);
}

function extractBadgeVariants(html: string): string[] {
  return [...html.matchAll(/data-variant="([^"]+)"/g)].map((match) => match[1]);
}
