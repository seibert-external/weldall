import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import {
  getSkillRetrievalSummaryBySlug,
  recordSkillRetrievalEvent,
} from "../src/server/skills/retrieval-metrics.js";

const runId = randomUUID();
const skillSlug = `skill-retrieval-${runId}`;
const otherSkillSlug = `skill-retrieval-other-${runId}`;
const aliceId = `skill-retrieval-alice-${runId}`;
const bobId = `skill-retrieval-bob-${runId}`;
const aliceEmail = `skill-retrieval-alice-${runId}@example.com`;
const bobEmail = `skill-retrieval-bob-${runId}@example.com`;
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
  await db.user.deleteMany({ where: { id: { in: [aliceId, bobId] } } });
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

    await expect(
      db.skillRetrievalEvent.count({ where: { skillSlug } }),
    ).resolves.toBe(3);
  });
});
