import { randomUUID } from "node:crypto";
import { randomState, randomNonce, randomPKCECodeVerifier } from "openid-client";
import { db, ensureSystemScopes, ADMIN_SCOPE_KEY, LOGIN_SCOPE_KEY, type Prisma } from "@weldall/db";
import { z } from "zod";
import { WELDALL_ISSUER } from "../oauth/constants";
import {
  emailSchema,
  LoginError,
  providerConfigSchema,
  type ProviderConfig,
  type VerifiedIdentity,
} from "./oidc-config";
import { digest, requireSetupToken, seal, unseal } from "./oidc-credentials";
import { authorizationUrl, verifyCallback } from "./oidc-runtime";

/** Builds a provider callback from the configured Weldall origin, never the request Host. */
export const callbackUrl = (id: string) => `${WELDALL_ISSUER}/api/auth/callback/${id}`;
const INITIAL_PROVIDER_ID = "00000000-0000-4000-8000-000000000001";
/**
 * Reads the installation state. Missing records or database failures propagate as errors;
 * they must not be treated as permission to open the installer.
 */
export async function installationCompleted(): Promise<boolean> {
  const installation = await db.loginInstallation.findUniqueOrThrow({
    where: { id: "default" },
    select: { state: true },
  });
  return installation.state === "COMPLETED";
}
/** Returns the fixed first-provider ID so its callback can be registered before setup. */
export function firstProviderId(): string {
  return INITIAL_PROVIDER_ID;
}
/** Returns up to 100 enabled providers' public button details, ordered for the login page. */
export async function publicLoginProviders() {
  return db.loginProvider.findMany({
    where: { enabled: true },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: { id: true, buttonLabel: true, buttonColor: true, sortOrder: true },
    take: 100,
  });
}
/**
 * Loads an enabled provider and decrypts its current configuration.
 * The returned configuration contains the client secret and must remain server-side.
 */
export async function currentProvider(id: string) {
  const row = await db.loginProvider.findUnique({ where: { id } });
  if (!row?.enabled) throw new LoginError("provider_unavailable");
  const config = providerConfigSchema.parse({
    name: row.name,
    buttonLabel: row.buttonLabel,
    buttonColor: row.buttonColor,
    sortOrder: row.sortOrder,
    issuer: row.issuer,
    discoveryUrl: row.discoveryUrl ?? undefined,
    clientId: row.clientId,
    clientSecret: unseal("provider", id, row.encryptedClientSecret),
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    scopes: row.scopes,
    allowedEmailDomains: row.allowedEmailDomains,
  });
  return { row, config };
}
const payloadSchema = z.object({
  config: providerConfigSchema,
  nonce: z.string(),
  verifier: z.string(),
  returnTo: z.string(),
  adminEmail: emailSchema.optional(),
  setupTokenHash: z.string().optional(),
  testAdminId: z.string().optional(),
  testSessionId: z.string().optional(),
  testId: z.string().uuid().optional(),
});
/** Accepts only home or a bounded `/login?...` return path; rejects other redirect targets. */
export function safeReturnTo(value: string): string {
  if (value === "/") return value;
  if (value.length <= 8192 && value.startsWith("/login?") && !/[\r\n\\]/.test(value)) return value;
  throw new LoginError("invalid_return_url");
}
/**
 * Starts login for an enabled provider after installation is complete.
 * Stores a browser-bound attempt with the current provider version and returns its authorization URL.
 */
export async function startLogin(input: { providerId: string; browser: string; returnTo: string }) {
  if (!(await installationCompleted())) throw new LoginError("setup_required");
  const { row, config } = await currentProvider(input.providerId);
  return createAttempt({ ...input, config, mode: "login", providerVersion: row.version });
}
/**
 * Starts installation or an optional setup test using draft provider values and a valid operator token.
 * Stores only a transient attempt; no provider, user, grants or session are created here.
 */
export async function startSetup(
  input: {
    config: ProviderConfig;
    adminEmail: string;
    browser: string;
    token: string;
  } & ({ mode: "setup" } | { mode: "setup-test"; testId: string }),
) {
  if (await installationCompleted()) throw new LoginError("setup_completed");
  requireSetupToken(input.token);
  return createAttempt({
    ...input,
    providerId: firstProviderId(),
    setupTokenHash: digest(input.token),
    returnTo: "/",
    adminEmail: emailSchema.parse(input.adminEmail),
  });
}
/** Rejects attempts authorized by a setup token that has since been changed or removed. */
function assertSetupToken(setupTokenHash: string | undefined) {
  if (setupTokenHash !== digest(process.env.WELDALL_SETUP_TOKEN ?? ""))
    throw new LoginError("setup_unauthorized");
  requireSetupToken(process.env.WELDALL_SETUP_TOKEN ?? "");
}
/** Rechecks that installation is still open and the attempt's operator authorization is current. */
async function assertSetupOpen(attempt: ConsumedAttempt) {
  if (await installationCompleted()) throw new LoginError("setup_completed");
  assertSetupToken(attempt.payload.setupTokenHash);
}
/**
 * Starts a test of possibly unsaved provider values, recording the initiating admin/session IDs.
 * The caller must authorize the admin and recheck that session around callback verification.
 * Only the transient attempt is saved; the provider configuration is not updated.
 */
export async function startProviderTest(input: {
  providerId: string;
  config: ProviderConfig;
  browser: string;
  testAdminId: string;
  testSessionId: string;
  testId: string;
}) {
  if (!(await installationCompleted())) throw new LoginError("setup_required");
  return createAttempt({ ...input, mode: "provider-test", returnTo: "/" });
}
/**
 * Creates fresh state, nonce and PKCE verifier, preflights discovery, then stores a state hash
 * and encrypted payload for a ten-minute, single-use flow. Enforces global/browser limits transactionally
 * and rechecks setup authorization after discovery and lock waits.
 */
async function createAttempt(input: {
  providerId: string;
  config: ProviderConfig;
  browser: string;
  mode: "login" | "setup" | "setup-test" | "provider-test";
  returnTo: string;
  adminEmail?: string;
  setupTokenHash?: string;
  providerVersion?: number;
  testAdminId?: string;
  testSessionId?: string;
  testId?: string;
}) {
  const state = randomState();
  const id = digest(state);
  const nonce = randomNonce();
  const verifier = randomPKCECodeVerifier();
  const returnTo = safeReturnTo(input.returnTo);
  const url = await authorizationUrl(
    input.config,
    callbackUrl(input.providerId),
    state,
    nonce,
    verifier,
  );
  await db.$transaction(async (tx) => {
    if (input.mode === "setup" || input.mode === "setup-test") {
      // Installation precedes attempt locks, matching completion. No setup attempt can commit afterward.
      const installations = await tx.$queryRaw<Array<{ state: string }>>`
        SELECT "state" FROM "LoginInstallation" WHERE "id" = 'default' FOR UPDATE`;
      if (installations[0]?.state !== "UNINITIALIZED") throw new LoginError("setup_completed");
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(181923, 1)`;
    await tx.loginAttempt.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    if (
      (await tx.loginAttempt.count()) >= 10000 ||
      (await tx.loginAttempt.count({ where: { browserHash: digest(input.browser) } })) >= 10
    )
      throw new LoginError("too_many_attempts");
    if (input.mode === "setup" || input.mode === "setup-test")
      assertSetupToken(input.setupTokenHash);
    await tx.loginAttempt.create({
      data: {
        id,
        providerId: input.providerId,
        providerVersion: input.providerVersion ?? null,
        mode: input.mode,
        browserHash: digest(input.browser),
        expiresAt: new Date(Date.now() + 600000),
        encryptedPayload: seal(
          "attempt",
          id,
          JSON.stringify({
            config: input.config,
            nonce,
            verifier,
            returnTo,
            adminEmail: input.adminEmail,
            setupTokenHash: input.setupTokenHash,
            testAdminId: input.testAdminId,
            testSessionId: input.testSessionId,
            testId: input.testId,
          }),
        ),
      },
    });
  });
  return { url };
}
/**
 * Atomically claims and deletes an unexpired attempt matching provider, state and browser binding.
 * The caller must validate the callback state and supply the verified browser cookie first.
 * Only one concurrent callback can succeed; later verification failure does not restore the attempt.
 * Returns authenticated state and decrypted payload for server-side verification.
 */
export async function consumeAttempt(providerId: string, state: string, browser: string) {
  const id = digest(state);
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      providerId: string;
      providerVersion: number | null;
      mode: string;
      encryptedPayload: string;
    }>
  >`
    DELETE FROM "LoginAttempt" WHERE "id" = ${id} AND "providerId" = ${providerId}
      AND "browserHash" = ${digest(browser)} AND "expiresAt" > (${new Date()}::timestamptz AT TIME ZONE 'UTC') RETURNING *`;
  const attempt = rows[0];
  if (!attempt) throw new LoginError("invalid_attempt");
  return {
    ...attempt,
    state,
    payload: payloadSchema.parse(JSON.parse(unseal("attempt", id, attempt.encryptedPayload))),
  };
}
/** A claimed attempt with authenticated state and a secret-bearing decrypted configuration. */
export type ConsumedAttempt = Awaited<ReturnType<typeof consumeAttempt>>;

/** Locks the provider through completion and rejects disabled or changed configurations. */
async function assertCurrent(tx: Prisma.TransactionClient, attempt: ConsumedAttempt) {
  const rows = await tx.$queryRaw<
    Array<{ enabled: boolean; version: number }>
  >`SELECT "enabled", "version" FROM "LoginProvider" WHERE "id" = ${attempt.providerId} FOR UPDATE`;
  if (!rows[0]?.enabled || rows[0].version !== attempt.providerVersion)
    throw new LoginError("provider_changed");
}
/**
 * Links an already-verified identity to a user within the caller's transaction.
 * Matches accounts by issuer/subject and users by normalized email, creating missing records.
 * Rejects unverified local users and changed-email bindings; never merges or reassigns accounts.
 * Serializes linking across providers to prevent concurrent email/identity collisions.
 */
export async function linkIdentity(
  tx: Prisma.TransactionClient,
  identity: VerifiedIdentity,
  providerId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(181923, 2)`;
  const existing = await tx.user.findUnique({ where: { email: identity.email } });
  if (existing && !existing.emailVerified) throw new LoginError("local_identity_conflict");
  const account = await tx.account.findUnique({
    where: {
      issuer_providerAccountId: { issuer: identity.issuer, providerAccountId: identity.subject },
    },
    include: { user: true },
  });
  if (account) {
    if (
      !account.user.emailVerified ||
      account.user.email !== identity.email ||
      existing?.id !== account.userId
    )
      throw new LoginError("identity_email_changed");
    return account.user;
  }
  const user =
    existing ??
    (await tx.user.create({
      data: { id: randomUUID(), email: identity.email, name: identity.name, emailVerified: true },
    }));
  await tx.account.create({
    data: {
      id: randomUUID(),
      issuer: identity.issuer,
      providerAccountId: identity.subject,
      providerId,
      userId: user.id,
    },
  });
  return user;
}
/**
 * Commits a login or installation using an identity the caller has already verified.
 * Login rechecks the provider version and links the identity. Installation additionally creates
 * the first provider, grants admin/login scopes, records an audit, closes setup and removes its attempts.
 * Test modes are rejected. This function does not create a session; the caller may do so only after commit.
 */
export async function completeVerifiedAttempt(
  attempt: ConsumedAttempt,
  identity: VerifiedIdentity,
) {
  if (identity.issuer !== attempt.payload.config.issuer)
    throw new LoginError("identity_issuer_mismatch");
  return db.$transaction(async (tx) => {
    if (attempt.mode === "login") {
      await assertCurrent(tx, attempt);
      const user = await linkIdentity(tx, identity, attempt.providerId);
      return { user, returnTo: attempt.payload.returnTo };
    }
    if (attempt.mode !== "setup" || identity.email !== attempt.payload.adminEmail)
      throw new LoginError("setup_email_mismatch");
    const installations = await tx.$queryRaw<
      Array<{ state: string }>
    >`SELECT "state" FROM "LoginInstallation" WHERE "id" = 'default' FOR UPDATE`;
    if (installations[0]?.state !== "UNINITIALIZED") throw new LoginError("setup_completed");
    if (attempt.providerId !== firstProviderId()) throw new LoginError("invalid_attempt");
    assertSetupToken(attempt.payload.setupTokenHash);
    const user = await linkIdentity(tx, identity, attempt.providerId);
    const { clientSecret, ...config } = attempt.payload.config;
    await tx.loginProvider.create({
      data: {
        ...config,
        discoveryUrl: config.discoveryUrl ?? null,
        id: attempt.providerId,
        encryptedClientSecret: seal("provider", attempt.providerId, clientSecret),
        enabled: true,
        validatedAt: new Date(),
        createdBy: user.id,
        updatedBy: user.id,
      },
    });
    await ensureSystemScopes(tx, user.id);
    const assignment = await tx.emailScopeAssignment.upsert({
      where: { normalizedEmail: identity.email },
      create: { normalizedEmail: identity.email, createdBy: user.id, updatedBy: user.id },
      update: { version: { increment: 1 }, updatedBy: user.id },
    });
    const scopes = await tx.scope.findMany({
      where: { key: { in: [ADMIN_SCOPE_KEY, LOGIN_SCOPE_KEY] } },
    });
    for (const scope of scopes)
      await tx.emailScopeGrant.upsert({
        where: { assignmentId_scopeId: { assignmentId: assignment.id, scopeId: scope.id } },
        create: { assignmentId: assignment.id, scopeId: scope.id, createdBy: user.id },
        update: {},
      });
    await tx.auditEvent.create({
      data: {
        eventType: "login.installation.completed",
        actorType: "user",
        actorId: user.id,
        actorEmail: identity.email,
        requestId: randomUUID(),
        outcome: "success",
        subjectType: "login-provider",
        subjectId: attempt.providerId,
        metadata: { providerId: attempt.providerId, scopes: [ADMIN_SCOPE_KEY, LOGIN_SCOPE_KEY] },
      },
    });
    await tx.loginInstallation.update({
      where: { id: "default" },
      data: { state: "COMPLETED", completedAdminUserId: user.id, completedAt: new Date() },
    });
    assertSetupToken(attempt.payload.setupTokenHash);
    await tx.loginAttempt.deleteMany({ where: { mode: { in: ["setup", "setup-test"] } } });
    return { user, returnTo: "/" };
  });
}
/**
 * Verifies the complete callback query against a previously consumed attempt through the OIDC adapter.
 * Checks provider availability/version before ordinary login exchange, and setup authorization/email
 * around setup exchange. Creates no provider, user, grant or session; tests stop after this step.
 * Admin-test session checks belong to the caller; final login version checks belong to completion.
 *
 * @param query The received URL search string, preserving duplicate parameters.
 */
export async function verifyAttempt(attempt: ConsumedAttempt, query: string) {
  if (attempt.mode === "login") {
    const { row } = await currentProvider(attempt.providerId);
    if (row.version !== attempt.providerVersion) throw new LoginError("provider_changed");
  } else if (attempt.mode === "setup" || attempt.mode === "setup-test")
    await assertSetupOpen(attempt);
  // Only the query is received from the browser; origin/path and expected state are authenticated.
  const callback = new URL(callbackUrl(attempt.providerId));
  callback.search = query;
  const identity = await verifyCallback(
    attempt.payload.config,
    callback,
    attempt.state,
    attempt.payload.nonce,
    attempt.payload.verifier,
  );
  if (attempt.mode === "setup" || attempt.mode === "setup-test") {
    await assertSetupOpen(attempt);
    if (identity.email !== attempt.payload.adminEmail) throw new LoginError("setup_email_mismatch");
  }
  return identity;
}
