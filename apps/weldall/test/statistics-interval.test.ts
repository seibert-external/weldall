import { describe, expect, it } from "vitest";
import {
  DEFAULT_STATISTICS_INTERVAL,
  STATISTICS_INTERVALS,
  parseStatisticsInterval,
  resolveStatisticsInterval,
  statisticsIntervalDays,
  statisticsIntervalLabel,
  statisticsIntervalMs,
} from "../src/server/statistics/interval.js";

const hourInMs = 60 * 60 * 1000;

describe("statistics intervals", () => {
  it("offers exactly four intervals and defaults to 7d", () => {
    expect(STATISTICS_INTERVALS).toEqual(["24h", "7d", "30d", "90d"]);
    expect(DEFAULT_STATISTICS_INTERVAL).toBe("7d");
  });

  it("parses only the four interval values", () => {
    for (const interval of STATISTICS_INTERVALS) {
      expect(parseStatisticsInterval(interval)).toBe(interval);
    }
    for (const value of ["", "7D", " 7d", "1y", "7", undefined, null, 7, ["7d"]]) {
      expect(parseStatisticsInterval(value)).toBeNull();
    }
  });

  it("prefers the query value, then the cookie, then 7d", () => {
    expect(resolveStatisticsInterval("30d", "90d")).toBe("30d");
    expect(resolveStatisticsInterval(undefined, "90d")).toBe("90d");
    expect(resolveStatisticsInterval(undefined, undefined)).toBe("7d");
  });

  it("ignores repeated and unknown query values", () => {
    expect(resolveStatisticsInterval(["7d", "30d"], "90d")).toBe("90d");
    expect(resolveStatisticsInterval("1y", "24h")).toBe("24h");
    expect(resolveStatisticsInterval("1y", "forever")).toBe("7d");
  });

  it("maps each interval to days, milliseconds and a label", () => {
    expect(STATISTICS_INTERVALS.map(statisticsIntervalDays)).toEqual([1, 7, 30, 90]);
    expect(statisticsIntervalMs("24h")).toBe(24 * hourInMs);
    expect(statisticsIntervalMs("90d")).toBe(90 * 24 * hourInMs);
    expect(STATISTICS_INTERVALS.map(statisticsIntervalLabel)).toEqual([
      "24 hours",
      "7 days",
      "30 days",
      "90 days",
    ]);
  });
});
