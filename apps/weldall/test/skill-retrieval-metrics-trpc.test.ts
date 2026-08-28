import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import { WELDALL_ISSUER } from "../src/server/oauth/constants.js";
import { appRouter } from "../src/server/trpc/router.js";
import type { TrpcContext } from "../src/server/trpc/context.js";
import { recordSkillRetrievalEvent } from "../src/server/skills/retrieval-metrics.js";

const runId = randomUUID();
const actorId = `skillmetrics-actor-${runId}`;
const scopeKey = `skillmetrics:read-${runId}`;
const readerEmail = `skillmetrics-reader-${runId}@example.com`;
const outsiderEmail = `skillmetrics-outsider-${runId}@example.com`;
const skillSlug = `skillmetrics.review-${runId}`;
const aliceId = `skillmetrics-alice-${runId}`;
const bobId = `skillmetrics-bob-${runId}`;
const charlieId = `skillmetrics-charlie-${runId}`;
const aliceEmail = `skillmetrics-alice-${runId}@example.com`;
const bobEmail = `skillmetrics-bob-${runId}@example.com`;
const charlieEmail = `skillmetrics-charlie-${runId}@example.com`;
let scopeId: string;

beforeAll(async () => {
  const scope = await db.scope.create({
    data: {
      key: scopeKey,
      description: scopeKey,
      createdBy: actorId,
      updatedBy: actorId,
    },
  });
  scopeId = scope.id;
  await db.skill.create({
    data: {
      slug: skillSlug,
      title: "Skill metrics review",
      content: "Use the metric API.",
      requiredScopes: [scopeKey],
      visibility: "HIDDEN_IF_UNALLOWED",
      createdBy: actorId,
      updatedBy: actorId,
    },
  });
  await db.emailScopeAssignment.create({
    data: {
      normalizedEmail: readerEmail,
      createdBy: actorId,
      updatedBy: actorId,
      grants: {
        create: {
          scopeId,
          createdBy: actorId,
        },
      },
    },
  });
  await db.user.createMany({
    data: [
      { id: aliceId, name: "Alice Analyst", email: aliceEmail, emailVerified: true },
      { id: bobId, name: "Bob Builder", email: bobEmail, emailVerified: true },
      { id: charlieId, name: "Charlie Checker", email: charlieEmail, emailVerified: true },
    ],
  });
  const now = Date.now();
  await recordSkillRetrievalEvent({
    skillSlug,
    retrieverId: aliceId,
    retrieverName: "Alice Analyst",
    occurredAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
  });
  await recordSkillRetrievalEvent({
    skillSlug,
    retrieverId: bobId,
    retrieverName: "Bob Builder",
    occurredAt: new Date(now - 3 * 24 * 60 * 60 * 1000),
  });
  await recordSkillRetrievalEvent({
    skillSlug,
    retrieverId: charlieId,
    retrieverName: "Charlie Checker",
    occurredAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
  });
});

afterAll(async () => {
  await db.skillRetrievalEvent.deleteMany({ where: { skillSlug } });
  await db.skill.deleteMany({ where: { slug: skillSlug } });
  await db.emailScopeAssignment.deleteMany({ where: { normalizedEmail: readerEmail } });
  await db.user.deleteMany({ where: { id: { in: [aliceId, bobId, charlieId] } } });
  await db.scope.deleteMany({ where: { key: scopeKey } });
});

function caller(email?: string) {
  return appRouter.createCaller({
    request: new Request(`${WELDALL_ISSUER}/api/trpc`),
    requestId: randomUUID(),
    session: email ? ({ user: { id: `session-${email}`, email } } as TrpcContext["session"]) : null,
  });
}

describe("skill retrieval metrics tRPC query", () => {
  it("returns the default 7-day window and unique retriever names for authorized callers", async () => {
    await expect(caller(readerEmail).skillRetrievalMetrics.summary({ slug: skillSlug })).resolves.toMatchObject({
      skillSlug,
      windowDays: 7,
      uniqueRetrievalCount: 2,
      uniqueRetrievers: [
        { id: aliceId, displayName: "Alice Analyst" },
        { id: bobId, displayName: "Bob Builder" },
      ],
    });
  });

  it("supports a bounded custom window and hides unauthorized callers", async () => {
    await expect(
      caller(readerEmail).skillRetrievalMetrics.summary({ slug: skillSlug, days: 30 }),
    ).resolves.toMatchObject({
      skillSlug,
      windowDays: 30,
      uniqueRetrievalCount: 3,
      uniqueRetrievers: [
        { id: aliceId, displayName: "Alice Analyst" },
        { id: bobId, displayName: "Bob Builder" },
        { id: charlieId, displayName: "Charlie Checker" },
      ],
    });

    await expect(caller(outsiderEmail).skillRetrievalMetrics.summary({ slug: skillSlug })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(caller().skillRetrievalMetrics.summary({ slug: skillSlug })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller(readerEmail).skillRetrievalMetrics.summary({ slug: skillSlug, days: 0 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
