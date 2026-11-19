import type { Prisma } from "@weldall/db";

/** Owners re-confirm a registered app after this many days (INV-183). */
export const APP_REVERIFICATION_DAYS = 90;
/** Within this many days before its expiry an app counts as expiring soon (INV-183). */
export const APP_EXPIRING_SOON_DAYS = 14;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

/** The expiry of an app registered or confirmed at `from`: {@link APP_REVERIFICATION_DAYS} later. */
export const reverificationExpiry = (from: Date = new Date()) =>
  new Date(from.getTime() + APP_REVERIFICATION_DAYS * DAY_IN_MS);

/**
 * Re-verification state of a registered app, derived from its expiry and never stored:
 * `expired` from the expiry instant on, `expiring_soon` within {@link APP_EXPIRING_SOON_DAYS}
 * before it (inclusive), `active` before that. An expired app is only flagged: publishing and
 * the git proxy keep working for it.
 */
export const APP_STATES = ["active", "expiring_soon", "expired"] as const;
export type AppState = (typeof APP_STATES)[number];

export function appState(expiresAt: Date, now: Date = new Date()): AppState {
  const left = expiresAt.getTime() - now.getTime();
  if (left <= 0) return "expired";
  if (left <= APP_EXPIRING_SOON_DAYS * DAY_IN_MS) return "expiring_soon";
  return "active";
}

/** The database filter that selects exactly the apps {@link appState} puts in `state` at `now`. */
export function appStateWhere(state: AppState, now: Date = new Date()): Prisma.AppWhereInput {
  const soon = new Date(now.getTime() + APP_EXPIRING_SOON_DAYS * DAY_IN_MS);
  if (state === "expired") return { expiresAt: { lte: now } };
  if (state === "expiring_soon") return { expiresAt: { gt: now, lte: soon } };
  return { expiresAt: { gt: soon } };
}
