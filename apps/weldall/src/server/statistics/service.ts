import { db } from "@weldall/db";
import { avatarRoutePath } from "../avatars";
import { parseAvatarUrl } from "../group-providers/avatar-url";
import {
  getSkillRetrievalCountsBySlugs,
  type SkillRetrievalSummaryEntry,
} from "../skills/retrieval-metrics";
import { statisticsIntervalDays, statisticsIntervalMs, type StatisticsInterval } from "./interval";

const HUMAN_EXCHANGE_EVENT_TYPES = ["id_jag.issued", "id_jag.denied", "id_jag.failed"];
const MACHINE_TOKEN_EVENT_TYPES = [
  "machine_token.issued",
  "machine_token.denied",
  "machine_token.failed",
];
const MAX_LISTED_HUMANS = 20;
const TOP_ENTRIES = 10;

export interface UsageStatistics {
  interval: StatisticsInterval;
  activeHumans: { count: number; previousCount: number; users: SkillRetrievalSummaryEntry[] };
  machines: { count: number };
  resources: { resource: string; name: string; exchanges: number }[];
  skills: { slug: string; title: string; retrievers: number }[];
}

interface StatisticsWindow {
  from: Date;
  to: Date;
}

/**
 * Org-wide usage for the statistics page. Callers must check `weldall:statistics` first: the
 * numbers are not filtered by what the viewer can see.
 */
export async function getUsageStatistics(
  interval: StatisticsInterval,
  now = new Date(),
): Promise<UsageStatistics> {
  const length = statisticsIntervalMs(interval);
  const current = { from: new Date(now.getTime() - length), to: now };
  const previous = { from: new Date(current.from.getTime() - length), to: current.from };
  const [activeHumans, previousCount, machineCount, resources, skills] = await Promise.all([
    getActiveHumans(current),
    countActiveHumans(previous),
    countMachines(current),
    getTopResources(current),
    getTopSkills(current, statisticsIntervalDays(interval), now),
  ]);
  return {
    interval,
    activeHumans: { ...activeHumans, previousCount },
    machines: { count: machineCount },
    resources,
    skills,
  };
}

function inWindow({ from, to }: StatisticsWindow) {
  return { gte: from, lt: to };
}

/** Distinct user IDs from token exchanges, skill retrievals and CLI logins or refreshes. */
async function activeHumanIds(window: StatisticsWindow): Promise<string[]> {
  const [exchanges, retrievals, cliSessions] = await Promise.all([
    db.auditEvent.groupBy({
      by: ["actorId"],
      where: {
        eventType: { in: HUMAN_EXCHANGE_EVENT_TYPES },
        actorType: "user",
        occurredAt: inWindow(window),
      },
    }),
    db.skillRetrievalEvent.groupBy({
      by: ["retrieverId"],
      where: { occurredAt: inWindow(window) },
    }),
    db.oAuthDeviceRefreshBinding.groupBy({
      by: ["userId"],
      where: { createdAt: inWindow(window) },
    }),
  ]);
  return [
    ...new Set([
      ...exchanges.map(({ actorId }) => actorId),
      ...retrievals.map(({ retrieverId }) => retrieverId),
      ...cliSessions.map(({ userId }) => userId),
    ]),
  ];
}

async function getActiveHumans(
  window: StatisticsWindow,
): Promise<{ count: number; users: SkillRetrievalSummaryEntry[] }> {
  const ids = await activeHumanIds(window);
  if (ids.length === 0) return { count: 0, users: [] };
  // Deleted users drop out here, so the count always matches the people who can be listed.
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, email: true, image: true },
  });
  const entries = users
    .map((user) => ({
      id: user.id,
      displayName: user.name.trim() || user.email,
      avatarUrl: parseAvatarUrl(user.image) ? avatarRoutePath(user.id) : null,
    }))
    .sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
    );
  return { count: entries.length, users: entries.slice(0, MAX_LISTED_HUMANS) };
}

async function countActiveHumans(window: StatisticsWindow): Promise<number> {
  const ids = await activeHumanIds(window);
  if (ids.length === 0) return 0;
  return db.user.count({ where: { id: { in: ids } } });
}

async function countMachines(window: StatisticsWindow): Promise<number> {
  const machines = await db.auditEvent.groupBy({
    by: ["actorId"],
    where: {
      eventType: { in: MACHINE_TOKEN_EVENT_TYPES },
      actorType: "machine",
      occurredAt: inWindow(window),
    },
  });
  return machines.length;
}

async function getTopResources(window: StatisticsWindow): Promise<UsageStatistics["resources"]> {
  // The columns are TIMESTAMP(3) without time zone holding UTC, so the bounds are converted the
  // way login-service.ts does it instead of relying on the session time zone.
  const rows = await db.$queryRaw<Array<{ resource: string; exchanges: bigint }>>`
    SELECT "metadata"->>'resource' AS "resource", count(*) AS "exchanges"
    FROM "AuditEvent"
    WHERE "eventType" = 'id_jag.issued'
      AND "occurredAt" >= (${window.from}::timestamptz AT TIME ZONE 'UTC')
      AND "occurredAt" < (${window.to}::timestamptz AT TIME ZONE 'UTC')
      AND "metadata"->>'resource' IS NOT NULL
    GROUP BY 1
    ORDER BY 2 DESC, 1 ASC
    LIMIT ${TOP_ENTRIES}`;
  if (rows.length === 0) return [];
  const registered = await db.downstreamResource.findMany({
    where: { resourceIdentifier: { in: rows.map(({ resource }) => resource) } },
    select: { resourceIdentifier: true, name: true },
  });
  const names = new Map(registered.map((row) => [row.resourceIdentifier, row.name] as const));
  return rows.map(({ resource, exchanges }) => ({
    resource,
    name: names.get(resource) ?? resource,
    exchanges: Number(exchanges),
  }));
}

async function getTopSkills(
  window: StatisticsWindow,
  days: number,
  now: Date,
): Promise<UsageStatistics["skills"]> {
  // Start from retrieved slugs, because catalog skills are retrieved too and have no Skill row.
  const retrieved = await db.skillRetrievalEvent.groupBy({
    by: ["skillSlug"],
    where: { occurredAt: inWindow(window) },
  });
  const slugs = retrieved.map(({ skillSlug }) => skillSlug);
  if (slugs.length === 0) return [];
  const [counts, skills, discoveredSkills] = await Promise.all([
    getSkillRetrievalCountsBySlugs(slugs, days, now.getTime()),
    db.skill.findMany({ where: { slug: { in: slugs } }, select: { slug: true, title: true } }),
    db.discoveredSkill.findMany({
      where: { canonicalId: { in: slugs } },
      select: { canonicalId: true, title: true },
    }),
  ]);
  const titles = new Map<string, string>([
    ...discoveredSkills.map((skill) => [skill.canonicalId, skill.title] as const),
    ...skills.map((skill) => [skill.slug, skill.title] as const),
  ]);
  return slugs
    .map((slug) => ({ slug, title: titles.get(slug) ?? slug, retrievers: counts[slug] ?? 0 }))
    .filter(({ retrievers }) => retrievers > 0)
    .sort(
      (left, right) => right.retrievers - left.retrievers || left.slug.localeCompare(right.slug),
    )
    .slice(0, TOP_ENTRIES);
}
