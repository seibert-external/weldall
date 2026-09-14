import { db, Prisma } from "@weldall/db";
import type { LoginProvider } from "@prisma/client";
import { z } from "zod";
import { requireAdminUser } from "./service";
import { callbackUrl, installationCompleted } from "../auth/login-service";
import { LoginError, providerConfigSchema } from "../auth/oidc-config";
import { seal, unseal } from "../auth/oidc-credentials";
import { discover } from "../auth/oidc-runtime";

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
export function loginProviderDto(row: LoginProvider) {
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
    validatedAt: row.validatedAt.toISOString(),
    callbackUrl: callbackUrl(row.id),
  };
}
export type LoginProviderDto = ReturnType<typeof loginProviderDto>;
export async function listLoginProviders(userId: string) {
  await requireAdminUser(userId);
  return (
    await db.loginProvider.findMany({ orderBy: [{ sortOrder: "asc" }, { id: "asc" }], take: 100 })
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
      (row ? unseal("provider", row.id, row.encryptedClientSecret) : undefined),
  });
  return { row, config };
}
export async function saveLoginProvider(
  initiatingSession: { userId: string; sessionId: string },
  requestId: string,
  input: LoginProviderInput,
) {
  await requireAdminUser(initiatingSession.userId);
  const { row: original, config } = await resolveLoginProviderInput(input);
  const authorityUnchanged =
    original &&
    config.issuer === original.issuer &&
    (config.discoveryUrl ?? null) === original.discoveryUrl &&
    config.clientId === original.clientId &&
    config.clientSecret === unseal("provider", original.id, original.encryptedClientSecret) &&
    config.tokenEndpointAuthMethod === original.tokenEndpointAuthMethod &&
    JSON.stringify(config.scopes) === JSON.stringify(original.scopes) &&
    JSON.stringify(config.allowedEmailDomains) === JSON.stringify(original.allowedEmailDomains);
  const preflight = !authorityUnchanged || (!original?.enabled && input.enabled);
  if (preflight) await discover(config);
  // Serialize count/last-enabled checks across processes; lock the row used by login finalization too.
  return db.$transaction(
    async (tx) => {
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
      const row = await tx.loginProvider.findUnique({ where: { id: input.providerId } });
      if ((row?.version ?? 0) !== input.expectedVersion) throw new LoginError("stale_provider");
      if (row && row.issuer !== config.issuer) throw new LoginError("immutable_issuer");
      if (!row && (await tx.loginProvider.count()) >= 100)
        throw new LoginError("too_many_providers");
      // A fresh acknowledgement for every enabled save also covers credential/endpoint authority changes.
      if (input.enabled && !input.acknowledgeAuthority)
        throw new LoginError("authority_acknowledgement_required");
      if (
        row?.enabled &&
        !input.enabled &&
        (await tx.loginProvider.count({ where: { enabled: true } })) === 1 &&
        !input.acknowledgeLockout
      )
        throw new LoginError("last_provider_acknowledgement_required");
      const { clientSecret, ...nonsecret } = config;
      const data = {
        ...nonsecret,
        discoveryUrl: config.discoveryUrl ?? null,
        encryptedClientSecret: seal("provider", input.providerId, clientSecret),
        enabled: input.enabled,
        validatedAt: preflight ? new Date() : original!.validatedAt,
        updatedBy: actor.id,
      };
      const saved = row
        ? await tx.loginProvider.update({
            where: { id: row.id },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.loginProvider.create({
            data: { ...data, id: input.providerId, createdBy: actor.id },
          });
      await tx.auditEvent.create({
        data: {
          eventType: "login.provider.saved",
          actorType: "user",
          actorId: actor.id,
          actorEmail: actor.email,
          requestId,
          outcome: "success",
          subjectType: "login-provider",
          subjectId: saved.id,
          metadata: {
            providerId: saved.id,
            versionBefore: row?.version ?? 0,
            versionAfter: saved.version,
            enabledBefore: row?.enabled ?? false,
            enabledAfter: saved.enabled,
            secretChanged: input.config.clientSecret !== undefined,
          },
        },
      });
      return loginProviderDto(saved);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}
