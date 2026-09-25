export const STATISTICS_INTERVALS = ["24h", "7d", "30d", "90d"] as const;
export type StatisticsInterval = (typeof STATISTICS_INTERVALS)[number];
export const DEFAULT_STATISTICS_INTERVAL: StatisticsInterval = "7d";

/** Remembers the last interval a viewer picked, like the `weldall-theme` cookie. */
export const STATISTICS_INTERVAL_COOKIE = "weldall-statistics-interval";
export const STATISTICS_INTERVAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const INTERVAL_DAYS: Record<StatisticsInterval, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export function parseStatisticsInterval(value: unknown): StatisticsInterval | null {
  return typeof value === "string" && (STATISTICS_INTERVALS as readonly string[]).includes(value)
    ? (value as StatisticsInterval)
    : null;
}

/** The URL wins over the remembered cookie, and anything invalid falls through to the next source. */
export function resolveStatisticsInterval(
  queryValue: string | string[] | undefined,
  cookieValue: string | undefined,
): StatisticsInterval {
  return (
    parseStatisticsInterval(queryValue) ??
    parseStatisticsInterval(cookieValue) ??
    DEFAULT_STATISTICS_INTERVAL
  );
}

export function statisticsIntervalDays(interval: StatisticsInterval): number {
  return INTERVAL_DAYS[interval];
}

export function statisticsIntervalMs(interval: StatisticsInterval): number {
  return INTERVAL_DAYS[interval] * DAY_IN_MS;
}

export function statisticsIntervalLabel(interval: StatisticsInterval): string {
  return interval === "24h" ? "24 hours" : `${INTERVAL_DAYS[interval]} days`;
}
