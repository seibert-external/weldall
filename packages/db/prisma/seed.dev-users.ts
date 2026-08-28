import type { Prisma, PrismaClient } from "@prisma/client";

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const HOUR_IN_MS = 60 * 60 * 1000;
const MINUTE_IN_MS = 60 * 1000;

/** Prefix owned by this seed. Prefixed users and retrieval events are rebuilt on every run. */
const USER_ID_PREFIX = "dev-user-";

type Retriever = { id: string; name: string };

export type DevelopmentUser = {
  id: string;
  name: string;
  email: string;
};

/** People in the development user directory and the names behind retrieval metrics. */
export const DEVELOPMENT_USERS: readonly DevelopmentUser[] = [
  { id: `${USER_ID_PREFIX}jane-adams`, name: "Jane Adams", email: "jane.adams@example.com" },
  { id: `${USER_ID_PREFIX}omar-haddad`, name: "Omar Haddad", email: "omar.haddad@example.com" },
  {
    id: `${USER_ID_PREFIX}sofia-marchetti`,
    name: "Sofia Marchetti",
    email: "sofia.marchetti@example.com",
  },
  { id: `${USER_ID_PREFIX}liam-oconnor`, name: "Liam O'Connor", email: "liam.oconnor@example.com" },
  { id: `${USER_ID_PREFIX}priya-raman`, name: "Priya Raman", email: "priya.raman@example.com" },
  { id: `${USER_ID_PREFIX}noah-fischer`, name: "Noah Fischer", email: "noah.fischer@example.com" },
  {
    id: `${USER_ID_PREFIX}mia-andersen`,
    name: "Mia Andersen",
    email: "mia.andersen@example.com",
  },
  { id: `${USER_ID_PREFIX}kenji-tanaka`, name: "Kenji Tanaka", email: "kenji.tanaka@example.com" },
  { id: `${USER_ID_PREFIX}laura-gomez`, name: "Laura Gómez", email: "laura.gomez@example.com" },
  { id: `${USER_ID_PREFIX}tomas-novak`, name: "Tomas Novak", email: "tomas.novak@example.com" },
  { id: `${USER_ID_PREFIX}aisha-bello`, name: "Aisha Bello", email: "aisha.bello@example.com" },
  {
    id: `${USER_ID_PREFIX}elena-petrova`,
    name: "Elena Petrova",
    email: "elena.petrova@example.com",
  },
];

/**
 * Retriever ids without a `User` row. Their names live on the event only, which is how a
 * skill page reports people who retrieved a skill and later left the company.
 */
const FORMER_DEVELOPMENT_USER_NAMES = [
  "Nina Roberts",
  "Ada Baker",
  "Ben Okoro",
  "Carla Viet",
  "Derek Lam",
  "Elin Sandberg",
  "Farid Nazari",
  "Gretl Braun",
  "Hassan Yildiz",
  "Ida Kowalski",
  "Jonas Berg",
  "Kavya Menon",
  "Lars Holt",
  "Mara Duarte",
  "Nils Haugen",
  "Olga Mirzoyan",
  "Pablo Serrano",
  "Quinn Fuller",
  "Riya Bose",
  "Stefan Popov",
  "Tara Oyelaran",
  "Ulf Lindqvist",
  "Vera Ndiaye",
  "Wen Zhao",
  "Xavier Engel",
  "Yara Haddad",
  "Zack Abramov",
  "Anke Drews",
  "Bruno Costa",
  "Cleo Marchand",
  "Dario Voss",
  "Esme Whitlock",
  "Fumi Sato",
  "Gabe Medina",
  "Hana Novotna",
  "Ines Rocha",
  "Joris Peeters",
  "Kai Estrup",
  "Lena Brandt",
  "Milo Graber",
  "Nadia Selim",
  "Oskar Wenzel",
  "Petra Ivanova",
  "Rafael Duarte",
  "Sanna Koskinen",
  "Tarek Aziz",
  "Ursula Behr",
  "Viktor Lund",
  "Xia Chen",
  "Yossi Klein",
  "Arjun Rao",
  "Marta Silva",
] as const;

const formerDevelopmentUsers: readonly Retriever[] = FORMER_DEVELOPMENT_USER_NAMES.map((name) => ({
  id: `${USER_ID_PREFIX}former-${name.toLocaleLowerCase().replace(/[^a-z]+/gu, "-")}`,
  name,
}));

/** Everybody a skill can credit with a retrieval: current accounts plus alumni. */
const retrievers: readonly Retriever[] = [...DEVELOPMENT_USERS, ...formerDevelopmentUsers];

/**
 * Distinct retrievers per skill, cycled over skill position: [unique retrievers inside the
 * 90 day window, how many of them are also inside the default 7 day window]. The second
 * number spans every retrieval tier, so all five colorful flames show in the directory's
 * default view and the first number keeps the 90 day window hotter.
 */
const RETRIEVAL_PROFILES: readonly (readonly [total: number, recent: number])[] = [
  [0, 0],
  [1, 1],
  [4, 4],
  [2, 2],
  [64, 64],
  [3, 1],
  [12, 12],
  [1, 1],
  [31, 31],
  [6, 3],
  [8, 8],
  [0, 0],
  [21, 21],
  [2, 1],
  [55, 55],
  [1, 0],
  [61, 61],
  [5, 3],
  [17, 10],
  [4, 2],
];

for (const [total, recent] of RETRIEVAL_PROFILES) {
  if (total > retrievers.length || recent > total) {
    throw new Error(
      `Development retrieval profile [${total}, ${recent}] needs more retrievers than the seed provides.`,
    );
  }
}

/** Development users that exist today; prefixed users outside this list are removed again. */
const SEEDED_USER_IDS = DEVELOPMENT_USERS.map(({ id }) => id);

export async function seedDevelopmentUsers(db: PrismaClient): Promise<void> {
  const now = Date.now();
  for (const [index, user] of DEVELOPMENT_USERS.entries()) {
    await db.user.upsert({
      where: { id: user.id },
      create: {
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: true,
        createdAt: new Date(now - (420 - index * 13) * DAY_IN_MS),
      },
      update: { name: user.name, email: user.email, emailVerified: true },
    });
  }
  await db.user.deleteMany({
    where: { id: { startsWith: USER_ID_PREFIX, notIn: SEEDED_USER_IDS } },
  });
}

/**
 * Records retrievals for every seeded skill, including downstream-discovered ones.
 * Each skill gets its own number of distinct retrievers, split over activity bands so the
 * 7, 30, and 90 day windows on a skill page count different people.
 */
export async function seedDevelopmentSkillRetrievals(db: PrismaClient): Promise<void> {
  const slugs = await retrievalSkillSlugs(db);
  await db.skillRetrievalEvent.deleteMany({
    where: { retrieverId: { startsWith: USER_ID_PREFIX } },
  });

  const events: Prisma.SkillRetrievalEventCreateManyInput[] = [];
  for (const [skillIndex, slug] of slugs.entries()) {
    const [retrieverCount, recentCount] =
      RETRIEVAL_PROFILES[skillIndex % RETRIEVAL_PROFILES.length] ?? [0, 0];
    for (const [position, retriever] of retrieversFor(skillIndex, retrieverCount)) {
      const occurrences = 1 + ((skillIndex * 2 + position) % 3);
      const daysAgo = retrievalDaysAgo(position, retrieverCount, recentCount);
      for (let occurrence = 0; occurrence < occurrences; occurrence += 1) {
        events.push({
          id: `dev-retrieval-${slug}-${retriever.id}-${occurrence}`,
          skillSlug: slug,
          retrieverId: retriever.id,
          retrieverName: retriever.name,
          occurredAt: retrievalOccurredAt(skillIndex, position, daysAgo, occurrence),
        });
      }
    }
  }

  if (events.length) await db.skillRetrievalEvent.createMany({ data: events });
}

async function retrievalSkillSlugs(db: PrismaClient): Promise<string[]> {
  const [skills, discoveredSkills] = await Promise.all([
    db.skill.findMany({
      where: { slug: { startsWith: "demo." } },
      select: { slug: true },
    }),
    db.discoveredSkill.findMany({ select: { canonicalId: true } }),
  ]);
  return [
    ...skills.map(({ slug }) => slug),
    ...discoveredSkills.map(({ canonicalId }) => canonicalId),
  ].sort();
}

/** `count` retrievers starting at a position that shifts with the skill, wrapped around the pool. */
function retrieversFor(skillIndex: number, count: number): [position: number, Retriever][] {
  const firstRetriever = (skillIndex * 5) % retrievers.length;
  return Array.from({ length: count }, (_, position) => {
    const retriever = retrievers[(firstRetriever + position) % retrievers.length];
    return retriever ? ([position, retriever] as [number, Retriever]) : undefined;
  }).filter((entry): entry is [number, Retriever] => entry !== undefined);
}

/**
 * How far back a person's retrievals start. The first `recentCount` retrievers of a skill stay
 * inside the default 7 day window, the rest split between the 30 and 90 day windows, so the
 * three windows count different people and the flame tiers move with the selected window.
 */
function retrievalDaysAgo(position: number, retrieverCount: number, recentCount: number): number {
  const historicCount = retrieverCount - recentCount;
  if (position < recentCount) return 1 + (position % 5); // inside 7 days
  const historicOffset = position - recentCount;
  return historicOffset < Math.ceil(historicCount / 2)
    ? 8 + (historicOffset % 20) // inside 30 days, outside 7
    : 34 + ((historicOffset * 3) % 49); // inside 90 days, outside 30
}

function retrievalOccurredAt(
  skillIndex: number,
  position: number,
  daysAgo: number,
  occurrence: number,
) {
  const hourInDay = (skillIndex + position * 3 + occurrence * 5) % 22;
  const minuteInHour = (position * 7 + occurrence * 13) % 59;
  const ageInMs = daysAgo * DAY_IN_MS + hourInDay * HOUR_IN_MS + minuteInHour * MINUTE_IN_MS;
  return new Date(Date.now() - ageInMs);
}
