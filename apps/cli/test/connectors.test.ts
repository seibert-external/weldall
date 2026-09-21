import { describe, expect, it } from "vitest";
import { assertAllowedTarget } from "../src/services/connectors.js";

const prefixes = [
  "https://gmail.googleapis.com/gmail/v1/",
  "https://www.googleapis.com/calendar/v3/",
];

describe("connection target validation", () => {
  it("accepts exact API bases, descendants, and query strings", () => {
    expect(
      assertAllowedTarget(
        "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=10",
        prefixes,
        "google",
      ).pathname,
    ).toBe("/calendar/v3/users/me/calendarList");
    expect(
      assertAllowedTarget("https://gmail.googleapis.com/gmail/v1", prefixes, "google").pathname,
    ).toBe("/gmail/v1");
  });

  it.each([
    "http://www.googleapis.com/calendar/v3/events",
    "https://www.googleapis.com.evil.example/calendar/v3/events",
    "https://www.googleapis.com/calendar/v30/events",
    "https://www.googleapis.com:444/calendar/v3/events",
    "https://user@www.googleapis.com/calendar/v3/events",
    "https://www.googleapis.com/calendar/v3/events#fragment",
  ])("rejects unsafe targets before credentials are read: %s", (target) => {
    expect(() => assertAllowedTarget(target, prefixes, "google")).toThrow("cannot access");
  });
});
