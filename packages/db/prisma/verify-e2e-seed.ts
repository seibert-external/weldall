/**
 * E2E seed gate.
 *
 * Runs inside the `bootstrap` compose service (docker-compose.e2e.yml) after
 * `migrate deploy`, `seed.ts`, `seed.dev.ts` and the login fixture seed, and
 * *before* the bootstrap readiness marker file is touched. Every check below
 * names a row that a Playwright assertion in apps/e2e/test/system.spec.ts
 * reads back through the UI or the CLI.
 *
 * Without this gate a partially seeded database stays invisible until Playwright
 * fails with "element(s) not found" minutes into a run; with it the stack refuses
 * to become healthy and the log says exactly which required row is missing.
 *
 * Exit 0 = seed complete; exit 1 = one or more required rows are missing.
 */
import { PrismaClient } from "@prisma/client";
import { ADMIN_SCOPE_KEY, LOGIN_SCOPE_KEY } from "../src/system-scopes.js";
import { DEVELOPMENT_SKILL_COUNT } from "./seed.dev-skills.js";

const db = new PrismaClient();

/** Administrator identity installed by the login fixture seed in the same service. */
const ADMIN_EMAIL = process.env.E2E_SEED_ADMIN_EMAIL ?? "alice@example.com";

/** Scopes whose existence the `weldall scopes` assertions in the suite depend on. */
const REQUIRED_BUSINESS_SCOPE_KEYS = [
  "expenses:read",
  "expenses:create",
  "expenses:write",
  "expenses:delete",
] as const;

/** Skill the suite reads back from the public directory: /skill/[slug] renders its title. */
const REQUIRED_SKILL_SLUG = "demo.finance.budget-variance";
const REQUIRED_SKILL_TITLE = "Analyze budget variance";
const REQUIRED_EXPENSE_SKILL_SLUG = "expenses.review";
const REQUIRED_EXPENSE_SKILL_TITLE = "Review expenses";

const EXPENSES_API_PREFIX = "https://expenses.seibert.localdev/api";
const WELDALL_API_IDENTIFIER = "https://weldall.seibert.localdev/api";
const CLI_OAUTH_CLIENT_ID = "weldall-cli";

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const failures: string[] = [];
const check = (requirement: string, satisfied: boolean, detail: () => string = () => "") => {
  if (!satisfied) failures.push(`${requirement}${detail() ? ` (${detail()})` : ""}`);
};

const systemScopes = await db.scope.findMany({
  where: { key: { in: [ADMIN_SCOPE_KEY, LOGIN_SCOPE_KEY] } },
  select: { key: true, isSystem: true },
});
const businessScopes = await db.scope.findMany({
  where: { key: { in: [...REQUIRED_BUSINESS_SCOPE_KEYS] } },
  select: { key: true },
});
const adminAssignment = await db.emailScopeAssignment.findUnique({
  where: { normalizedEmail: normalizeEmail(ADMIN_EMAIL) },
  include: { grants: { include: { scope: { select: { key: true } } } } },
});
const expensesResource = await db.downstreamResource.findUnique({
  where: { key: "expenses" },
  select: {
    enabled: true,
    skillDiscoveryEnabled: true,
    requestPrefixes: { select: { urlPrefix: true } },
  },
});
const weldallApiResource = await db.oauthResource.findUnique({
  where: { identifier: WELDALL_API_IDENTIFIER },
  select: { disabled: true },
});
const cliOAuthClient = await db.oauthClient.findUnique({
  where: { clientId: CLI_OAUTH_CLIENT_ID },
  select: { disabled: true, requirePKCE: true },
});
const skillCount = await db.skill.count();
const requiredSkill = await db.skill.findUnique({
  where: { slug: REQUIRED_SKILL_SLUG },
  select: { title: true },
});
const requiredExpenseSkill = await db.discoveredSkill.findUnique({
  where: { canonicalId: REQUIRED_EXPENSE_SKILL_SLUG },
  select: { title: true, content: true, requiredScopes: true },
});

await db.$disconnect();

const presentSystemScopeKeys = new Set(
  systemScopes.filter((scope) => scope.isSystem).map((scope) => scope.key),
);
for (const key of [ADMIN_SCOPE_KEY, LOGIN_SCOPE_KEY]) {
  check(`bootstrap requires the system scope ${key}`, presentSystemScopeKeys.has(key));
}

const presentBusinessScopeKeys = new Set(businessScopes.map((scope) => scope.key));
for (const key of REQUIRED_BUSINESS_SCOPE_KEYS) {
  check(`seed.dev must provide the scope ${key}`, presentBusinessScopeKeys.has(key));
}

const adminScopeKeys = new Set((adminAssignment?.grants ?? []).map((grant) => grant.scope.key));
check(
  `seed-login-fixture must grant ${ADMIN_EMAIL} the administrator scope`,
  adminScopeKeys.has(ADMIN_SCOPE_KEY),
  () => `assigned scopes: ${[...adminScopeKeys].sort().join(", ") || "none"}`,
);
check(
  `seed-login-fixture must grant ${ADMIN_EMAIL} the CLI login scope`,
  adminScopeKeys.has(LOGIN_SCOPE_KEY),
);

check(
  "seed.dev must enable the expenses resource",
  expensesResource?.enabled === true,
  () => `found: ${expensesResource ? "disabled" : "missing"}`,
);
check(
  "expenses resource must accept the request prefix the CLI calls",
  expensesResource?.requestPrefixes.some((prefix) => prefix.urlPrefix === EXPENSES_API_PREFIX) ===
    true,
  () =>
    `prefixes: ${expensesResource?.requestPrefixes.map((prefix) => prefix.urlPrefix).join(", ") || "none"}`,
);
check(
  "expenses resource must enable skill discovery",
  expensesResource?.skillDiscoveryEnabled === true,
);
check(
  "seed.ts must register the Weldall API resource the CLI calls",
  weldallApiResource?.disabled === false,
  () => `found: ${weldallApiResource ? "disabled" : "missing"}`,
);
check(
  `seed.ts must register the ${CLI_OAUTH_CLIENT_ID} client with PKCE for CLI login`,
  cliOAuthClient?.disabled === false && cliOAuthClient.requirePKCE === true,
  () => `found: ${JSON.stringify(cliOAuthClient ?? null)}`,
);

check(
  "seed.dev must persist the full development skill catalog",
  skillCount === DEVELOPMENT_SKILL_COUNT,
  () => `found ${skillCount}, expected ${DEVELOPMENT_SKILL_COUNT}`,
);
check(
  `seed.dev must include the skill ${REQUIRED_SKILL_SLUG}`,
  requiredSkill?.title === REQUIRED_SKILL_TITLE,
  () => `found title: ${requiredSkill?.title ?? "missing"}`,
);
check(
  `seed.dev must include the executable skill ${REQUIRED_EXPENSE_SKILL_SLUG}`,
  requiredExpenseSkill?.title === REQUIRED_EXPENSE_SKILL_TITLE &&
    requiredExpenseSkill.requiredScopes.includes("expenses:read") &&
    requiredExpenseSkill.content.includes(`${EXPENSES_API_PREFIX}/expenses`),
  () => `found: ${JSON.stringify(requiredExpenseSkill ?? null)}`,
);

if (failures.length > 0) {
  console.error(`E2E seed verification failed with ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "The E2E stack stays unhealthy until the seed provides these rows; no test will be able to read them.",
  );
  process.exitCode = 1;
} else {
  console.log(
    `E2E seed verified: admin ${ADMIN_EMAIL} with ${[...adminScopeKeys].sort().join(",")}, ` +
      `${REQUIRED_BUSINESS_SCOPE_KEYS.length} business scopes, ${skillCount} skills, ` +
      "expenses and Weldall API resources enabled.",
  );
}
