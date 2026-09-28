import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import { avatarRoutePath } from "../src/server/avatars.js";
import { getUsageStatistics } from "../src/server/statistics/service.js";

const runId = randomUUID();
const actor = `statistics-service-${runId}`;
const hourInMs = 60 * 60 * 1000;
const dayInMs = 24 * hourInMs;
// Fixed instants far in the past keep org-wide numbers free of seed data and other tests' rows.
const now = new Date("2001-02-03T12:00:00.000Z");
const crowdNow = new Date("2001-08-03T12:00:00.000Z");
const fixtureEnd = new Date("2002-01-01T00:00:00.000Z");
const ago = (ms: number, from = now) => new Date(from.getTime() - ms);
const id = (name: string) => `statistics-${name}-${runId}`;

const alice = id("alice");
const bob = id("bob");
const carol = id("carol");
const dave = id("dave");
const erin = id("erin");
const frank = id("frank");
const ghost = id("ghost");
const crowd = Array.from({ length: 22 }, (_, index) =>
  id(`crowd-${String(index).padStart(2, "0")}`),
);
const userIds = [alice, bob, carol, dave, erin, frank, ...crowd];
const resourceA = `https://statistics-a-${runId}.example.com`;
const resourceB = `https://statistics-b-${runId}.example.com`;
const skillSlug = id("skill");
const catalogSlug = `statistics-catalog-${runId}.review`;
const machineOne = id("machine-one");
const machineTwo = id("machine-two");
const machineOld = id("machine-old");

async function clearFixtureWindow() {
  await db.auditEvent.deleteMany({ where: { occurredAt: { lt: fixtureEnd } } });
  await db.skillRetrievalEvent.deleteMany({ where: { occurredAt: { lt: fixtureEnd } } });
  await db.oAuthDeviceRefreshBinding.deleteMany({ where: { createdAt: { lt: fixtureEnd } } });
}

function auditEvent(
  eventType: string,
  actorType: string,
  actorId: string,
  occurredAt: Date,
  resource?: string,
) {
  return {
    eventType,
    actorType,
    actorId,
    occurredAt,
    requestId: randomUUID(),
    // A check constraint requires a reason code on every denied row.
    ...(eventType.endsWith(".issued")
      ? { outcome: "success" }
      : { outcome: "denied", reasonCode: "scope_not_granted" }),
    metadata: resource ? { resource } : {},
  };
}

function cliBinding(userId: string, createdAt: Date) {
  return {
    tokenHash: randomUUID(),
    familyId: randomUUID(),
    clientId: "weldall-cli",
    userId,
    dpopJkt: randomUUID(),
    expiresAt: new Date(createdAt.getTime() + 30 * dayInMs),
    createdAt,
  };
}

beforeAll(async () => {
  await clearFixtureWindow();
  await db.user.createMany({
    data: [
      {
        id: alice,
        name: "Alice Stats",
        email: `${alice}@example.com`,
        emailVerified: true,
        image: "https://avatars.example.com/alice.png",
      },
      { id: bob, name: "Bob Stats", email: `${bob}@example.com`, emailVerified: true },
      { id: carol, name: "   ", email: `${carol}@example.com`, emailVerified: true },
      { id: dave, name: "Dave Stats", email: `${dave}@example.com`, emailVerified: true },
      { id: erin, name: "Erin Stats", email: `${erin}@example.com`, emailVerified: true },
      { id: frank, name: "Frank Stats", email: `${frank}@example.com`, emailVerified: true },
      ...crowd.map((userId, index) => ({
        id: userId,
        name: `Crowd ${String(index).padStart(2, "0")}`,
        email: `${userId}@example.com`,
        emailVerified: true,
      })),
    ],
  });
  await db.downstreamResource.create({
    data: {
      key: id("resource-a"),
      name: "Statistics resource A",
      resourceIdentifier: resourceA,
      authorizationServer: "https://auth.example.com",
      downstreamClientId: id("downstream-client"),
      createdBy: actor,
      updatedBy: actor,
    },
  });
  await db.skill.create({
    data: {
      slug: skillSlug,
      title: "Statistics skill",
      content: "Count things.",
      createdBy: actor,
      updatedBy: actor,
    },
  });
  await db.auditEvent.createMany({
    data: [
      auditEvent("id_jag.denied", "user", alice, ago(hourInMs), resourceA),
      auditEvent("id_jag.issued", "user", alice, ago(hourInMs), resourceB),
      auditEvent("id_jag.issued", "user", ghost, ago(hourInMs), resourceA),
      auditEvent("id_jag.issued", "user", carol, ago(4 * dayInMs), resourceA),
      auditEvent("id_jag.issued", "user", erin, ago(7 * dayInMs), resourceA),
      auditEvent("id_jag.issued", "user", frank, now, resourceB),
      auditEvent("id_jag.denied", "anonymous", "anonymous", ago(hourInMs), resourceA),
      auditEvent("machine_token.issued", "machine", machineOne, ago(hourInMs)),
      auditEvent("machine_token.issued", "machine", machineOne, ago(2 * dayInMs)),
      auditEvent("machine_token.denied", "machine", machineTwo, ago(5 * dayInMs)),
      auditEvent("machine_token.issued", "machine", machineOld, ago(10 * dayInMs)),
      auditEvent("machine_token.denied", "anonymous", "anonymous", ago(hourInMs)),
    ],
  });
  await db.skillRetrievalEvent.createMany({
    data: [
      { skillSlug, retrieverId: alice, retrieverName: "Alice Stats", occurredAt: ago(hourInMs) },
      { skillSlug, retrieverId: bob, retrieverName: "Bob Stats", occurredAt: ago(3 * dayInMs) },
      {
        skillSlug: catalogSlug,
        retrieverId: bob,
        retrieverName: "Bob Stats",
        occurredAt: ago(3 * dayInMs),
      },
      // After `now`, so no window ending at `now` may count it.
      { skillSlug, retrieverId: dave, retrieverName: "Dave Stats", occurredAt: ago(-hourInMs) },
    ],
  });
  await db.oAuthDeviceRefreshBinding.createMany({
    data: [
      cliBinding(carol, ago(4 * dayInMs)),
      cliBinding(dave, ago(8 * dayInMs)),
      ...crowd.map((userId) => cliBinding(userId, ago(hourInMs, crowdNow))),
    ],
  });
});

afterAll(async () => {
  await clearFixtureWindow();
  await db.skill.deleteMany({ where: { slug: skillSlug } });
  await db.downstreamResource.deleteMany({ where: { resourceIdentifier: resourceA } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("usage statistics service", () => {
  it("counts active humans across all three sources", async () => {
    const statistics = await getUsageStatistics("7d", now);

    // Alice through a denied exchange, Bob through a retrieval, Carol through the CLI and an
    // exchange, Erin exactly on the window start. Frank sits on `now`, which is excluded, and
    // the ghost exchanged tokens but no longer exists as a user.
    expect(statistics.interval).toBe("7d");
    expect(statistics.activeHumans.count).toBe(4);
    expect(statistics.activeHumans.users).toEqual([
      { id: alice, displayName: "Alice Stats", avatarUrl: avatarRoutePath(alice) },
      { id: bob, displayName: "Bob Stats", avatarUrl: null },
      { id: erin, displayName: "Erin Stats", avatarUrl: null },
      { id: carol, displayName: `${carol}@example.com`, avatarUrl: null },
    ]);
    // Dave's CLI login 8 days ago falls into the previous 7 days.
    expect(statistics.activeHumans.previousCount).toBe(1);
  });

  it("counts machines, resources and skills in the same window", async () => {
    const statistics = await getUsageStatistics("7d", now);

    expect(statistics.machines).toEqual({ count: 2 });
    // Denied exchanges are not resource usage. The ghost's exchange still counts, and the
    // unregistered resource shows its identifier.
    expect(statistics.resources).toEqual([
      { resource: resourceA, name: "Statistics resource A", exchanges: 3 },
      { resource: resourceB, name: resourceB, exchanges: 1 },
    ]);
    expect(statistics.skills).toEqual([
      { slug: skillSlug, title: "Statistics skill", retrievers: 2 },
      { slug: catalogSlug, title: catalogSlug, retrievers: 1 },
    ]);
  });

  it("narrows every widget to the last 24 hours", async () => {
    const statistics = await getUsageStatistics("24h", now);

    expect(statistics.activeHumans).toEqual({
      count: 1,
      previousCount: 0,
      users: [{ id: alice, displayName: "Alice Stats", avatarUrl: avatarRoutePath(alice) }],
    });
    expect(statistics.machines).toEqual({ count: 1 });
    expect(statistics.resources).toEqual([
      { resource: resourceA, name: "Statistics resource A", exchanges: 1 },
      { resource: resourceB, name: resourceB, exchanges: 1 },
    ]);
    expect(statistics.skills).toEqual([
      { slug: skillSlug, title: "Statistics skill", retrievers: 1 },
    ]);
  });

  it("lists at most 20 people sorted by name but counts all of them", async () => {
    const statistics = await getUsageStatistics("24h", crowdNow);

    expect(statistics.activeHumans.count).toBe(22);
    expect(statistics.activeHumans.users.map(({ displayName }) => displayName)).toEqual(
      Array.from({ length: 20 }, (_, index) => `Crowd ${String(index).padStart(2, "0")}`),
    );
  });

  it("returns empty widgets for a window without events", async () => {
    await expect(getUsageStatistics("90d", new Date("2000-01-01T00:00:00.000Z"))).resolves.toEqual({
      interval: "90d",
      activeHumans: { count: 0, previousCount: 0, users: [] },
      machines: { count: 0 },
      resources: [],
      skills: [],
    });
  });
});
