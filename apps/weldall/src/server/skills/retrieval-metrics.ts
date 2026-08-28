import { db } from "@weldall/db";
import { getVisibleSkill } from "./service";

export const DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS = 7;
export const MAX_SKILL_RETRIEVAL_WINDOW_DAYS = 90;

const DAY_IN_MS = 24 * 60 * 60 * 1000;

export interface SkillRetrievalSummaryEntry {
  id: string;
  displayName: string;
}

export interface SkillRetrievalSummary {
  skillSlug: string;
  windowDays: number;
  uniqueRetrievalCount: number;
  uniqueRetrievers: SkillRetrievalSummaryEntry[];
}

export interface SkillRetrievalEventInput {
  skillSlug: string;
  retrieverId: string;
  retrieverName: string;
  occurredAt?: Date;
}

export function parseSkillRetrievalWindowDays(value: string | null): number | null {
  if (value === null || value.trim() === "") return DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS;
  if (!/^\d+$/u.test(value)) return null;
  const days = Number(value);
  return days >= 1 && days <= MAX_SKILL_RETRIEVAL_WINDOW_DAYS ? days : null;
}

export function normalizeSkillRetrievalWindowDays(
  days = DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS,
): number {
  if (!Number.isFinite(days)) return DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS;
  return Math.min(MAX_SKILL_RETRIEVAL_WINDOW_DAYS, Math.max(1, Math.trunc(days)));
}

export async function recordSkillRetrievalEvent(input: SkillRetrievalEventInput): Promise<void> {
  await db.skillRetrievalEvent.create({
    data: {
      skillSlug: input.skillSlug,
      retrieverId: input.retrieverId,
      retrieverName: input.retrieverName,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    },
  });
}

export async function getSkillRetrievalSummaryBySlug(
  skillSlug: string,
  days = DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS,
): Promise<SkillRetrievalSummary> {
  const windowDays = normalizeSkillRetrievalWindowDays(days);
  const windowStart = new Date(Date.now() - windowDays * DAY_IN_MS);
  const events = await db.skillRetrievalEvent.findMany({
    where: { skillSlug, occurredAt: { gte: windowStart } },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { retrieverId: true, retrieverName: true },
  });
  const retrieverNames = new Map<string, string>();
  for (const event of events) {
    if (!retrieverNames.has(event.retrieverId))
      retrieverNames.set(event.retrieverId, event.retrieverName);
  }

  const retrieverIds = [...retrieverNames.keys()];
  const currentUsers = retrieverIds.length
    ? await db.user.findMany({
        where: { id: { in: retrieverIds } },
        select: { id: true, name: true },
      })
    : [];
  const currentNames = new Map(currentUsers.map((user) => [user.id, user.name.trim()] as const));
  const uniqueRetrievers = retrieverIds
    .map((id) => {
      const displayName = currentNames.get(id) || retrieverNames.get(id) || id;
      return { id, displayName };
    })
    .sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
    );

  return {
    skillSlug,
    windowDays,
    uniqueRetrievalCount: uniqueRetrievers.length,
    uniqueRetrievers,
  };
}

export async function getVisibleSkillRetrievalSummary(
  email: string,
  skillSlug: string,
  days = DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS,
): Promise<SkillRetrievalSummary | null> {
  const skill = await getVisibleSkill(email, skillSlug);
  if (!skill) return null;
  return await getSkillRetrievalSummaryBySlug(skillSlug, days);
}
