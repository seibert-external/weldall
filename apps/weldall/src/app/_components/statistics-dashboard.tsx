"use client";

import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { useQuery } from "@tanstack/react-query";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useMemo, useState } from "react";
import {
  STATISTICS_INTERVALS,
  STATISTICS_INTERVAL_COOKIE,
  STATISTICS_INTERVAL_COOKIE_MAX_AGE,
  parseStatisticsInterval,
  statisticsIntervalLabel,
  type StatisticsInterval,
} from "@/server/statistics/interval";
import type { UsageStatistics } from "@/server/statistics/service";
import { useTRPC } from "@/trpc/react";
import { SkillRetrieverList } from "./skill-retriever-list";
import { StatisticsBarChart } from "./statistics-bar-chart";

const intervalParser = parseAsStringLiteral(STATISTICS_INTERVALS);

export function StatisticsDashboard({
  initialInterval,
  initialStatistics,
}: {
  initialInterval: StatisticsInterval;
  initialStatistics: UsageStatistics | null;
}) {
  const trpc = useTRPC();
  // The server already resolved URL, cookie and default. Using its answer as the default keeps
  // the client on a cookie-picked interval while the URL stays clean.
  const [interval, setSelectedInterval] = useQueryState(
    "interval",
    intervalParser
      .withDefault(initialInterval)
      .withOptions({ history: "replace", shallow: true, clearOnDefault: false }),
  );
  const query = useQuery({
    ...trpc.statistics.summary.queryOptions({ interval }),
    // initialData belongs to the server's interval only. Handing it to another key would show
    // the wrong numbers as fresh.
    ...(initialStatistics && interval === initialInterval
      ? { initialData: initialStatistics }
      : {}),
  });
  // The last numbers that loaded stay on screen while another interval loads or a refetch fails.
  const [statistics, setStatistics] = useState(initialStatistics);
  if (query.data && query.data !== statistics) setStatistics(query.data);

  const changeInterval = (value: string) => {
    const next = parseStatisticsInterval(value);
    if (!next || next === interval) return;
    document.cookie = `${STATISTICS_INTERVAL_COOKIE}=${next}; Path=/; Max-Age=${STATISTICS_INTERVAL_COOKIE_MAX_AGE}; SameSite=Lax`;
    void setSelectedInterval(next);
  };

  if (query.error?.data?.code === "FORBIDDEN") return <StatisticsAccessDenied />;

  return (
    <div className="statistics-page" aria-busy={query.isFetching || undefined}>
      <div className="statistics-heading">
        <h1>Statistics</h1>
        <SegmentedControl label="Interval" onChange={changeInterval} size="sm" value={interval}>
          {STATISTICS_INTERVALS.map((value) => (
            <SegmentedControlItem key={value} label={value} value={value} />
          ))}
        </SegmentedControl>
      </div>
      {statistics ? (
        <>
          {query.error ? (
            <Banner
              description="Showing the last numbers that loaded."
              status="warning"
              title="Statistics could not be refreshed."
            />
          ) : null}
          <StatisticsPanels statistics={statistics} />
        </>
      ) : (
        <p className="statistics-muted">
          {query.error ? "Statistics unavailable." : "Loading statistics…"}
        </p>
      )}
    </div>
  );
}

export function StatisticsAccessDenied() {
  return (
    <EmptyState
      description="Your verified email does not have the weldall:statistics scope. Ask an administrator to assign it."
      headingLevel={1}
      title="Statistics access required"
    />
  );
}

function StatisticsPanels({ statistics }: { statistics: UsageStatistics }) {
  const period = statisticsIntervalLabel(statistics.interval);
  const { activeHumans, machines } = statistics;
  const remainingHumans = activeHumans.count - activeHumans.users.length;
  const resourceRows = useMemo(
    () =>
      statistics.resources.map((row) => ({
        key: row.resource,
        label: row.name,
        value: row.exchanges,
      })),
    [statistics.resources],
  );
  const skillRows = useMemo(
    () =>
      statistics.skills.map((row) => ({ key: row.slug, label: row.title, value: row.retrievers })),
    [statistics.skills],
  );

  return (
    <>
      <div className="statistics-summary">
        <Card className="statistics-card">
          <h2>Active people</h2>
          {activeHumans.count === 0 ? (
            <EmptyState
              headingLevel={3}
              isCompact
              title={`No active people in the last ${period}.`}
            />
          ) : (
            <div className="statistics-active">
              <div className="statistics-active-total">
                <p className="statistics-count">{activeHumans.count}</p>
                <p className="statistics-muted">
                  {comparisonLabel(activeHumans.count, activeHumans.previousCount, period)}
                </p>
              </div>
              <div className="statistics-people">
                <SkillRetrieverList retrievers={activeHumans.users} />
                {remainingHumans > 0 ? (
                  <p className="statistics-muted">{`and ${remainingHumans} more`}</p>
                ) : null}
              </div>
            </div>
          )}
        </Card>
        <Card className="statistics-card">
          <h2>Machines</h2>
          {machines.count === 0 ? (
            <EmptyState
              headingLevel={3}
              isCompact
              title={`No machine tokens in the last ${period}.`}
            />
          ) : (
            <>
              <p className="statistics-count statistics-count-small">{machines.count}</p>
              <p className="statistics-muted">Machine clients that asked for a token.</p>
            </>
          )}
        </Card>
      </div>
      <div className="statistics-charts">
        <Card className="statistics-card">
          <h2>Resources</h2>
          <p className="statistics-muted">
            Token exchanges by people. Machine tokens are not included.
          </p>
          {resourceRows.length === 0 ? (
            <EmptyState
              headingLevel={3}
              isCompact
              title={`No resource exchanges in the last ${period}.`}
            />
          ) : (
            <StatisticsBarChart
              ariaLabel={`Token exchanges by resource in the last ${period}`}
              rows={resourceRows}
              valueLabel="Exchanges"
            />
          )}
        </Card>
        <Card className="statistics-card">
          <h2>Skills</h2>
          <p className="statistics-muted">
            People who retrieved each skill, including former users.
          </p>
          {skillRows.length === 0 ? (
            <EmptyState
              headingLevel={3}
              isCompact
              title={`No skills retrieved in the last ${period}.`}
            />
          ) : (
            <StatisticsBarChart
              ariaLabel={`People who retrieved each skill in the last ${period}`}
              rows={skillRows}
              valueLabel="People"
            />
          )}
        </Card>
      </div>
    </>
  );
}

function comparisonLabel(count: number, previousCount: number, period: string): string {
  // Without anyone to compare with, a delta would just repeat the count.
  if (previousCount === 0) return `Nobody was active in the previous ${period}.`;
  const delta = count - previousCount;
  if (delta === 0) return `No change compared with the previous ${period}`;
  return `${delta > 0 ? "+" : ""}${delta} compared with the previous ${period}`;
}
