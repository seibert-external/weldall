import { expect, it } from "vitest";
import { providerTestResult } from "../src/lib/login-provider-test-result";
const popup = {} as Window;
const origin = "https://weldall.example.com";
const active = { popup, testId: "active", revision: 3 };
const event = {
  origin,
  source: popup,
  data: { type: "weldall-provider-test", testId: "active", passed: true },
} as MessageEvent;
it("accepts pass/fail only from the exact active popup and unchanged form", () => {
  expect(providerTestResult(event, active, origin, 3)).toBe(true);
  expect(
    providerTestResult({ ...event, data: { ...event.data, passed: false } }, active, origin, 3),
  ).toBe(false);
});
it("keeps setup tests separate from post-install provider tests and invalidates stale setup results", () => {
  const setup = { ...event, data: { ...event.data, type: "weldall-setup-test" } };
  expect(providerTestResult(setup, active, origin, 3, "weldall-setup-test")).toBe(true);
  expect(
    providerTestResult(
      { ...setup, data: { ...setup.data, passed: false } },
      active,
      origin,
      3,
      "weldall-setup-test",
    ),
  ).toBe(false);
  expect(providerTestResult(setup, active, origin, 3)).toBeUndefined();
  expect(providerTestResult(event, active, origin, 3, "weldall-setup-test")).toBeUndefined();
  expect(providerTestResult(setup, active, origin, 4, "weldall-setup-test")).toBeUndefined();
  expect(
    providerTestResult({ ...setup, source: {} as Window }, active, origin, 3, "weldall-setup-test"),
  ).toBeUndefined();
  expect(
    providerTestResult(
      { ...setup, origin: "https://evil.example.com" },
      active,
      origin,
      3,
      "weldall-setup-test",
    ),
  ).toBeUndefined();
  expect(providerTestResult(setup, null, origin, 3, "weldall-setup-test")).toBeUndefined();
});
it("ignores foreign origins/windows, stale attempts/forms, malformed results and unsolicited messages", () => {
  for (const changed of [
    { ...event, origin: "https://evil.example.com" },
    { ...event, source: {} as Window },
    { ...event, data: { ...event.data, testId: "old" } },
    { ...event, data: { ...event.data, type: "other" } },
    { ...event, data: { ...event.data, passed: "true" } },
    { ...event, data: null },
  ])
    expect(providerTestResult(changed, active, origin, 3)).toBeUndefined();
  expect(providerTestResult(event, active, origin, 4)).toBeUndefined();
  expect(providerTestResult(event, null, origin, 3)).toBeUndefined();
});
