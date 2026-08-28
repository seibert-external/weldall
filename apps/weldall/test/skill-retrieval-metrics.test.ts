import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import {
  getSkillRetrievalCountsBySlugs,
  getSkillRetrievalSummaryBySlug,
  recordSkillRetrievalEvent,
} from "../src/server/skills/retrieval-metrics.js";

const runId = randomUUID();
const skillSlug = `skill-retrieval-${runId}`;
const otherSkillSlug = `skill-retrieval-other-${runId}`;
const aliceId = `skill-retrieval-alice-${runId}`;
const bobId = `skill-retrieval-bob-${runId}`;
const carolId = `skill-retrieval-carol-${runId}`;
const aliceEmail = `skill-retrieval-alice-${runId}@example.com`;
const bobEmail = `skill-retrieval-bob-${runId}@example.com`;
const carolEmail = `skill-retrieval-carol-${runId}@example.com`;
const dayInMs = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await db.skillRetrievalEvent.deleteMany({
    where: { skillSlug: { in: [skillSlug, otherSkillSlug] } },
  });
});

afterAll(async () => {
  await db.skillRetrievalEvent.deleteMany({
    where: { skillSlug: { in: [skillSlug, otherSkillSlug] } },
  });
  await db.user.deleteMany({ where: { id: { in: [aliceId, bobId, carolId] } } });
});

async function ensureUsers() {
  await db.user.upsert({
    where: { id: aliceId },
    create: { id: aliceId, name: "Alice Analyst", email: aliceEmail, emailVerified: true },
    update: { name: "Alice Analyst", email: aliceEmail, emailVerified: true },
  });
  await db.user.upsert({
    where: { id: bobId },
    create: { id: bobId, name: "Bob Builder", email: bobEmail, emailVerified: true },
    update: { name: "Bob Builder", email: bobEmail, emailVerified: true },
  });
  await db.user.upsert({
    where: { id: carolId },
    create: { id: carolId, name: "Carol Chen", email: carolEmail, emailVerified: true },
    update: { name: "Carol Chen", email: carolEmail, emailVerified: true },
  });
}

describe("skill retrieval metrics", () => {
  it("records raw retrieval events and counts unique retrievers inside the requested window", async () => {
    await ensureUsers();
    const now = Date.now();

    await recordSkillRetrievalEvent({
      skillSlug,
      retrieverId: aliceId,
      retrieverName: "Alice Analyst",
      occurredAt: new Date(now - 2 * dayInMs),
    });
    await recordSkillRetrievalEvent({
      skillSlug,
      retrieverId: aliceId,
      retrieverName: "Alice Analyst",
      occurredAt: new Date(now - 1 * dayInMs),
    });
    await recordSkillRetrievalEvent({
      skillSlug,
      retrieverId: bobId,
      retrieverName: "Bob Builder",
      occurredAt: new Date(now - 8 * dayInMs),
    });
    await recordSkillRetrievalEvent({
      skillSlug: otherSkillSlug,
      retrieverId: aliceId,
      retrieverName: "Alice Analyst",
      occurredAt: new Date(now - 1 * dayInMs),
    });

    await db.user.update({ where: { id: aliceId }, data: { name: "Avery Updated" } });

    await expect(getSkillRetrievalSummaryBySlug(skillSlug)).resolves.toMatchObject({
      skillSlug,
      windowDays: 7,
      uniqueRetrievalCount: 1,
      uniqueRetrievers: [{ id: aliceId, displayName: "Avery Updated" }],
    });

    const summary = await getSkillRetrievalSummaryBySlug(skillSlug, 30);
    expect(summary).toMatchObject({
      skillSlug,
      windowDays: 30,
      uniqueRetrievalCount: 2,
    });
    expect(summary.uniqueRetrievers).toEqual([
      { id: aliceId, displayName: "Avery Updated" },
      { id: bobId, displayName: "Bob Builder" },
    ]);

    await expect(db.skillRetrievalEvent.count({ where: { skillSlug } })).resolves.toBe(3);
  });

  it("counts unique retrievers for many skills in one query", async () => {
    await ensureUsers();
    const now = Date.now();
    const retrievals = [
      [skillSlug, aliceId, "Alice Analyst", 1],
      [skillSlug, aliceId, "Alice Analyst", 3],
      [skillSlug, bobId, "Bob Builder", 5],
      [skillSlug, carolId, "Carol Chen", 9],
      [otherSkillSlug, bobId, "Bob Builder", 6],
    ] as const;
    for (const [slug, retrieverId, retrieverName, daysAgo] of retrievals) {
      await recordSkillRetrievalEvent({
        skillSlug: slug,
        retrieverId,
        retrieverName,
        occurredAt: new Date(now - daysAgo * dayInMs),
      });
    }

    // Skills without retrievals stay out of the record; the list renders them as zero.
    await expect(
      getSkillRetrievalCountsBySlugs([skillSlug, otherSkillSlug, `${skillSlug}-unretrieved`]),
    ).resolves.toEqual({ [skillSlug]: 2, [otherSkillSlug]: 1 });
    await expect(getSkillRetrievalCountsBySlugs([skillSlug], 30)).resolves.toEqual({
      [skillSlug]: 3,
    });
    await expect(getSkillRetrievalCountsBySlugs([])).resolves.toEqual({});
  });
});
