import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@weldall/db";
import type { LoginProvider } from "@prisma/client";
import { LoginError, providerConfigSchema } from "../auth/oidc-config";
import { seal, unseal } from "../auth/oidc-credentials";
import { discover } from "../auth/oidc-runtime";
import {
  loginProviderConfigSchema,
  publicLoginProvider,
  sameLoginAuthority,
} from "./secret-primitive-contracts";
import type { MutationActor } from "./primitive-mutations";

/** Prepared outside DB transactions; configuration and version are bound to the discovery result. */
export async function prepareLoginProviderConfiguration(
  value: unknown,
  row: LoginProvider | null,
  clientSecret?: string,
) {
  const config = loginProviderConfigSchema.parse(value);
  if (row && row.issuer !== config.issuer) throw new LoginError("immutable_issuer");
  const bindingChanged =
    row &&
    (row.clientId !== config.clientId ||
      row.discoveryUrl !== (config.discoveryUrl ?? null) ||
      row.tokenEndpointAuthMethod !== config.tokenEndpointAuthMethod);
  if (row?.encryptedClientSecret && bindingChanged && !clientSecret)
    throw new LoginError("credential_reprovision_required");
  const encryptedClientSecret = clientSecret
    ? seal("provider", config.id, clientSecret)
    : (row?.encryptedClientSecret ?? null);
  if (config.enabled && !encryptedClientSecret) throw new LoginError("MISSING_CREDENTIAL");
  const authorityChanged = !row || !sameLoginAuthority(publicLoginProvider(row), config);
  const preflight =
    encryptedClientSecret &&
    (clientSecret !== undefined || authorityChanged || (!row?.enabled && config.enabled));
  if (preflight) {
    const { id: _id, enabled: _enabled, ...publicConfig } = config;
    await discover(
      providerConfigSchema.parse({
        ...publicConfig,
        clientSecret: clientSecret ?? unseal("provider", config.id, encryptedClientSecret),
      }),
    );
  }
  return {
    config,
    expectedVersion: row?.version ?? null,
    encryptedClientSecret,
    validatedAt: preflight ? new Date() : (row?.validatedAt ?? null),
    secretChanged: clientSecret !== undefined,
  };
}
export type PreparedLoginProvider = Awaited<ReturnType<typeof prepareLoginProviderConfiguration>>;

/** Caller holds configuration + login locks and has independently authorized its UI session or IaC machine. */
export async function saveLoginProviderConfiguration(
  tx: Prisma.TransactionClient,
  prepared: PreparedLoginProvider,
  actor: MutationActor,
  approval: { authority: boolean; allowLastDisable: boolean },
) {
  const { config } = prepared;
  const row = await tx.loginProvider.findUnique({ where: { id: config.id } });
  if ((row?.version ?? null) !== prepared.expectedVersion) throw new LoginError("stale_provider");
  if (row && row.issuer !== config.issuer) throw new LoginError("immutable_issuer");
  if (!row && (await tx.loginProvider.count()) >= 100) throw new LoginError("too_many_providers");
  if (config.enabled && (!prepared.encryptedClientSecret || !prepared.validatedAt))
    throw new LoginError("MISSING_CREDENTIAL");
  const authorityChange =
    config.enabled &&
    (!row?.enabled ||
      !sameLoginAuthority(publicLoginProvider(row), config) ||
      prepared.secretChanged);
  if (authorityChange && !approval.authority)
    throw new LoginError("authority_acknowledgement_required");
  if (
    row?.enabled &&
    !config.enabled &&
    !approval.allowLastDisable &&
    (await tx.loginProvider.count({ where: { enabled: true } })) === 1
  )
    throw new LoginError("last_provider_acknowledgement_required");
  if (row && !prepared.secretChanged && isDeepStrictEqual(publicLoginProvider(row), config))
    return row;
  const { id, ...publicConfig } = config;
  const data = {
    ...publicConfig,
    discoveryUrl: config.discoveryUrl ?? null,
    encryptedClientSecret: prepared.encryptedClientSecret,
    validatedAt: prepared.validatedAt,
    updatedBy: actor.id,
  };
  const saved = row
    ? await tx.loginProvider.update({
        where: { id, version: row.version },
        data: { ...data, version: { increment: 1 } },
      })
    : await tx.loginProvider.create({ data: { ...data, id, createdBy: actor.id } });
  await tx.auditEvent.create({
    data: {
      eventType: "login.provider.saved",
      actorType: actor.type,
      actorId: actor.id,
      ...(actor.email ? { actorEmail: actor.email } : {}),
      requestId: actor.requestId,
      outcome: "success",
      subjectType: "login-provider",
      subjectId: id,
      metadata: {
        providerId: id,
        versionBefore: row?.version ?? 0,
        versionAfter: saved.version,
        enabledBefore: row?.enabled ?? false,
        enabledAfter: saved.enabled,
        secretChanged: prepared.secretChanged,
      },
    },
  });
  return saved;
}
export async function deleteLoginProviderConfiguration(
  tx: Prisma.TransactionClient,
  id: string,
  actor: MutationActor,
) {
  const row = await tx.loginProvider.findUniqueOrThrow({ where: { id } });
  if (row.enabled && (await tx.loginProvider.count({ where: { enabled: true } })) <= 1)
    throw new LoginError("last_provider_acknowledgement_required");
  await tx.loginProvider.delete({ where: { id, version: row.version } });
  await tx.loginAttempt.deleteMany({ where: { providerId: id } });
  await tx.auditEvent.create({
    data: {
      eventType: "login.provider.saved",
      actorType: actor.type,
      actorId: actor.id,
      requestId: actor.requestId,
      outcome: "success",
      subjectType: "login-provider",
      subjectId: id,
      metadata: {
        providerId: id,
        deleted: true,
        versionBefore: row.version,
        enabledBefore: row.enabled,
        enabledAfter: false,
        secretChanged: false,
      },
    },
  });
}
