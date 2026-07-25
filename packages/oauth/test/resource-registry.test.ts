import { describe, expect, it } from "vitest";
import {
  normalizeAuthorizationServer,
  normalizeRequestPrefix,
  normalizeRequestTarget,
  requestPrefixAccepts,
  requestPrefixesOverlap,
  resolveResourceForTarget,
} from "../src/resource-registry.js";

describe("resource request URL contract", () => {
  it.each([
    ["https://example.com/api", true],
    ["https://example.com/api/events", true],
    ["https://example.com/api/events?year=2026", true],
    ["https://example.com/api-attacker", false],
    ["https://other.example.com/api/events", false],
    ["https://example.com/other/../api/events", true],
    ["https://example.com:443/api/events", true],
    ["https://example.com/api%2Fevents", false],
  ])("matches %s segment-wise", (target, expected) => {
    expect(requestPrefixAccepts("https://example.com/api", target)).toBe(expected);
  });

  it("normalizes origins and trailing slashes idempotently using WHATWG URL", () => {
    expect(normalizeAuthorizationServer("https://EXAMPLE.com:443")).toBe("https://example.com");
    for (const input of [
      "https://EXAMPLE.com:443/api/",
      "https://EXAMPLE.com:443/api//",
      "https://EXAMPLE.com:443/api///",
    ]) {
      const normalized = normalizeRequestPrefix(input);
      expect(normalized).toBe("https://example.com/api");
      expect(normalizeRequestPrefix(normalized)).toBe(normalized);
    }
    expect(normalizeRequestPrefix("https://example.com///")).toBe("https://example.com/");
    expect(normalizeRequestTarget("https://EXAMPLE.com/api?q=1").toString()).toBe(
      "https://example.com/api?q=1",
    );
  });

  it("detects overlaps and deduplicates matching prefixes by resource", () => {
    expect(
      requestPrefixesOverlap("https://example.com/api", "https://example.com/api/events"),
    ).toBe(true);
    expect(requestPrefixesOverlap("https://example.com/api", "https://example.com/api-v2")).toBe(
      false,
    );
    const resources = [
      {
        key: "one",
        requestPrefixes: ["https://example.com/api", "https://example.com/api/events"],
      },
      { key: "two", requestPrefixes: ["https://other.example.com/api"] },
    ];
    expect(
      resolveResourceForTarget(resources, new URL("https://example.com/api/events/1")),
    ).toEqual([resources[0]]);
  });

  it.each([
    ["http://example.com/api"],
    ["https://user@example.com/api"],
    ["https://example.com/api?x=1"],
    ["https://example.com/api#fragment"],
    ["https://example.com/%61pi"],
    ["https://example.com/api%2Fevents"],
  ])("rejects unsafe request prefix %s", (prefix) => {
    expect(() => normalizeRequestPrefix(prefix)).toThrow();
  });
});
