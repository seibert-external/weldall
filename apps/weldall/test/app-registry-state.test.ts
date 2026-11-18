import { describe, expect, it } from "vitest";
import {
  APP_EXPIRING_SOON_DAYS,
  APP_STATES,
  appState,
  appStateWhere,
  type AppState,
} from "../src/server/app-registry/state";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-18T12:00:00.000Z");
const at = (offset: number) => new Date(now.getTime() + offset);

/** Evaluates the `{ expiresAt: { gt?, lte? } }` filter the way PostgreSQL would. */
function matches(state: AppState, expiresAt: Date) {
  const { gt, lte } = (appStateWhere(state, now).expiresAt ?? {}) as { gt?: Date; lte?: Date };
  return (!gt || expiresAt > gt) && (!lte || expiresAt <= lte);
}

describe("app re-verification state", () => {
  it.each([
    [-DAY, "expired"],
    [0, "expired"],
    [1, "expiring_soon"],
    [APP_EXPIRING_SOON_DAYS * DAY, "expiring_soon"],
    [APP_EXPIRING_SOON_DAYS * DAY + 1, "active"],
    [90 * DAY, "active"],
  ] as const)("an app expiring %i ms from now is %s", (offset, expected) => {
    expect(appState(at(offset), now)).toBe(expected);
  });

  it("selects in the database exactly the apps the derived state names, at every boundary", () => {
    for (const offset of [-1, 0, 1, APP_EXPIRING_SOON_DAYS * DAY, APP_EXPIRING_SOON_DAYS * DAY + 1])
      for (const state of APP_STATES)
        expect(matches(state, at(offset))).toBe(appState(at(offset), now) === state);
  });

  it("counts fourteen days as expiring soon", () => {
    expect(APP_EXPIRING_SOON_DAYS).toBe(14);
  });
});
