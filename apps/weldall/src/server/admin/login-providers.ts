import { db, Prisma } from "@weldall/db";
import type { LoginProvider } from "@prisma/client";
import { z } from "zod";
import { requireAdminUser } from "./service";
import { callbackUrl, installationCompleted } from "../auth/login-service";
import { LoginError, providerConfigSchema } from "../auth/oidc-config";
import { unseal } from "../auth/oidc-credentials";
import {
  prepareLoginProviderConfiguration,
  saveLoginProviderConfiguration,
} from "../domain/login-provider-configuration";
import {
  lockConfigurationChanges,
  managementBindingInclude,
  managementMetadata,
} from "../domain/configuration";

export const loginProviderInput = z
  .object({
    providerId: z.string().uuid(),
    expectedVersion: z.number().int().min(0).max(2147483646),
    config: providerConfigSchema.extend({ clientSecret: z.string().min(1).max(4096).optional() }),
    enabled: z.boolean(),
    acknowledgeAuthority: z.boolean().default(false),
    acknowledgeLockout: z.boolean().default(false),
  })
  .strict();
export type LoginProviderInput = z.infer<typeof loginProviderInput>;
export function loginProviderDto(
  row: LoginProvider & {
    iacBinding?: { address: string; workspace: { id: string; name: string } } | null;
  },
) {
  return {
    id: row.id,
    name: row.name,
    buttonLabel: row.buttonLabel,
    buttonColor: row.buttonColor,
    sortOrder: row.sortOrder,
    issuer: row.issuer,
    discoveryUrl: row.discoveryUrl,
    clientId: row.clientId,
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    scopes: row.scopes,
    allowedEmailDomains: row.allowedEmailDomains,
    enabled: row.enabled,
    version: row.version,
    hasClientSecret: Boolean(row.encryptedClientSecret),
    validatedAt: row.validatedAt?.toISOString() ?? null,
    readiness: !row.encryptedClientSecret
      ? "MISSING_CREDENTIAL"
      : !row.enabled
        ? "DISABLED"
        : row.validatedAt
          ? "READY"
          : "NOT_VALIDATED",
    management: managementMetadata(row.iacBinding),
    callbackUrl: callbackUrl(row.id),
  };
}
export type LoginProviderDto = ReturnType<typeof loginProviderDto>;
export async function listLoginProviders(userId: string) {
  await requireAdminUser(userId);
  return (
    await db.loginProvider.findMany({
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      take: 100,
      include: { iacBinding: managementBindingInclude },
    })
  ).map(loginProviderDto);
}
export async function resolveLoginProviderInput(input: LoginProviderInput) {
  if (!(await installationCompleted())) throw new LoginError("setup_required");
  const row = await db.loginProvider.findUnique({ where: { id: input.providerId } });
  if ((row?.version ?? 0) !== input.expectedVersion) throw new LoginError("stale_provider");
  if (row && row.issuer !== input.config.issuer) throw new LoginError("immutable_issuer");
  const config = providerConfigSchema.parse({
    ...input.config,
    clientSecret:
      input.config.clientSecret ??
      (row?.encryptedClientSecret
        ? unseal("provider", row.id, row.encryptedClientSecret)
        : undefined),
  });
  return { row, config };
}
export async function saveLoginProvider(
  initiatingSession: { userId: string; sessionId: string },
  requestId: string,
  input: LoginProviderInput,
) {
  await requireAdminUser(initiatingSession.userId);
  if (!(await installationCompleted())) throw new LoginError("setup_required");
  const original = await db.loginProvider.findUnique({ where: { id: input.providerId } });
  if ((original?.version ?? 0) !== input.expectedVersion) throw new LoginError("stale_provider");
  const { clientSecret, ...publicConfig } = input.config;
  const prepared = await prepareLoginProviderConfiguration(
    { ...publicConfig, id: input.providerId, enabled: input.enabled },
    original,
    clientSecret,
  );
  // Serialize count/last-enabled checks across processes; lock the row used by login finalization too.
  return db.$transaction(
    async (tx) => {
      await lockConfigurationChanges(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(181923, 3)`;
      await tx.$queryRaw`SELECT "id" FROM "LoginProvider" WHERE "id" = ${input.providerId} FOR UPDATE`;
      // Discovery and either lock may have waited while authorization was revoked elsewhere.
      // Reuse effective policy (including group grants), reading through this mutation transaction.
      const actor = await requireAdminUser(initiatingSession.userId, tx);
      const session = await tx.session.findUnique({
        where: { id: initiatingSession.sessionId },
        select: { userId: true, expiresAt: true },
      });
      if (session?.userId !== actor.id || session.expiresAt <= new Date())
        throw new LoginError("admin_session_required");
      if (input.enabled && !input.acknowledgeAuthority)
        throw new LoginError("authority_acknowledgement_required");
      const saved = await saveLoginProviderConfiguration(
        tx,
        prepared,
        {
          type: "user",
          id: actor.id,
          email: actor.email,
          requestId,
          source: "admin_api",
        },
        { authority: input.acknowledgeAuthority, allowLastDisable: input.acknowledgeLockout },
      );
      return loginProviderDto(saved);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}
