import { db, Prisma } from "@weldall/db";
import { z } from "zod";
import {
  AUDIT_EVENT_TYPES,
  type AuditActorType,
  type AuditEventDto,
  type AuditEventType,
  type AuditOutcome,
  type AuditReasonCode,
} from "../../lib/audit";
import { requestIdentifiers } from "../observability/http";

export { AUDIT_EVENT_TYPES } from "../../lib/audit";
export type { AuditEventDto, AuditEventType } from "../../lib/audit";

export const AUDIT_SCHEMA_VERSION = 1;

const identifierPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const safeText = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const stringArray = z.array(z.string().min(1).max(2_000)).max(100);
const scopeArray = z.array(z.string().min(1).max(160)).max(100);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const source = z.enum(["admin_api", "weldall_up", "static_manifest_import", "migration"]);
const mutationSource = z.enum(["admin_api", "weldall_up", "static_manifest_import"]);

const idJagRequestedMetadata = {
  audience: z.string().max(2_000).nullable(),
  resource: z.string().max(2_000).nullable(),
  requestedScopes: scopeArray,
};
const idJagIssuedMetadata = z
  .object({
    ...idJagRequestedMetadata,
    audience: z.string().min(1).max(2_000),
    resource: z.string().min(1).max(2_000),
    grantedScopes: scopeArray.min(1),
    targetClientId: z.string().min(1).max(200),
    jti: z.string().min(1).max(128),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    kid: z.string().min(1).max(200),
  })
  .strict();
const idJagDeniedMetadata = z.object(idJagRequestedMetadata).strict();
const idJagFailedMetadata = z.object(idJagRequestedMetadata).strict();

const machineClientMetadata = z
  .object({
    clientId: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    enabled: z.boolean(),
    version: z.number().int().positive(),
    source: mutationSource.optional(),
  })
  .strict();
const machineKeyMetadata = z
  .object({
    clientId: z.string().min(1).max(128),
    kid: z.string().min(1).max(128),
    thumbprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    revokedAt: z.string().datetime().nullable(),
    source: mutationSource.optional(),
  })
  .strict();
const machineAccessMetadata = z
  .object({
    clientId: z.string().min(1).max(128),
    beforeResources: stringArray,
    afterResources: stringArray,
    beforeScopes: scopeArray,
    afterScopes: scopeArray,
    versionBefore: z.number().int().nonnegative(),
    versionAfter: z.number().int().positive(),
    source: mutationSource.optional(),
  })
  .strict();
const machineTokenRequestedMetadata = z
  .object({
    clientId: z.string().min(1).max(128).nullable(),
    kid: z.string().min(1).max(128).nullable(),
    audience: z.string().max(2_000).nullable(),
    requestedScopes: scopeArray,
  })
  .strict();
const machineTokenIssuedMetadata = machineTokenRequestedMetadata.extend({
  clientId: z.string().min(1).max(128),
  kid: z.string().min(1).max(128),
  audience: z.string().min(1).max(2_000),
  grantedScopes: scopeArray.min(1),
  jti: z.string().min(1).max(128),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

const iacMetadata = z.object({}).passthrough();

const userScopesMetadata = z
  .object({
    normalizedEmail: z.string().email().max(320),
    beforeScopes: scopeArray,
    afterScopes: scopeArray,
    addedScopes: scopeArray,
    removedScopes: scopeArray,
    source: z.enum([
      "admin_api",
      "weldall_up",
      "static_manifest_import",
      "scope_delete_cascade",
      "deployment_bootstrap",
    ]),
    versionBefore: z.number().int().nonnegative(),
    versionAfter: z.number().int().positive(),
  })
  .strict();

const resourceSnapshot = z
  .object({
    key: z.string().min(1).max(120),
    resourceIdentifier: z.string().min(1).max(2_000),
    authorizationServer: z.string().min(1).max(2_000),
    downstreamClientId: z.string().min(1).max(200),
    scopeKeys: scopeArray,
    requestPrefixes: stringArray,
    enabled: z.boolean(),
    skillDiscoveryEnabled: z.boolean(),
    ownerId: z.string().min(1).max(320),
    version: z.number().int().positive(),
  })
  .strict();
const scopeSnapshot = z
  .object({
    key: z.string().min(1).max(160),
    description: z.string().min(1).max(500),
    isSystem: z.boolean(),
    version: z.number().int().positive(),
  })
  .strict();
const registeredResourceMetadata = z
  .object({
    entityType: z.literal("registered_resource"),
    source,
    resourceIdentifier: z.string().min(1).max(2_000),
    before: resourceSnapshot.nullable(),
    after: resourceSnapshot.nullable(),
    addedScopes: scopeArray,
    changedScopes: scopeArray,
    removedScopes: scopeArray,
    contentDigest: digest,
  })
  .strict();
const scopeDefinitionMetadata = z
  .object({
    entityType: z.literal("scope_definition"),
    source,
    resourceIdentifier: z.null(),
    before: scopeSnapshot.nullable(),
    after: scopeSnapshot.nullable(),
    addedScopes: scopeArray,
    changedScopes: scopeArray,
    removedScopes: scopeArray,
    contentDigest: digest,
  })
  .strict();
const resourceScopesMetadata = z.discriminatedUnion("entityType", [
  registeredResourceMetadata,
  scopeDefinitionMetadata,
]);

const cliSettingsMetadata = z
  .object({
    before: z
      .object({
        appendixSha256: digest,
        logoUrl: z.union([z.literal(""), z.string().url().max(2_000)]),
        version: z.number().int().positive(),
      })
      .strict(),
    after: z
      .object({
        appendixSha256: digest,
        logoUrl: z.union([z.literal(""), z.string().url().max(2_000)]),
        version: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
const skillVisibility = z.enum(["DEFAULT", "HIDDEN_IF_UNALLOWED"]);
const skillSnapshot = z
  .object({
    title: z.string().min(1).max(200),
    requiredScopes: scopeArray,
    visibility: skillVisibility,
    contentSha256: digest,
    version: z.number().int().positive(),
  })
  .strict();
const skillCreatedMetadata = z
  .object({
    slug: z.string().min(1).max(120),
    title: z.string().min(1).max(200),
    requiredScopes: scopeArray,
    visibility: skillVisibility,
    contentSha256: digest,
    version: z.number().int().positive(),
  })
  .strict();
const skillUpdatedMetadata = z
  .object({
    slug: z.string().min(1).max(120),
    before: skillSnapshot,
    after: skillSnapshot,
  })
  .strict();
const skillDeletedMetadata = skillCreatedMetadata;
const providerMetadata = z
  .object({
    providerKey: z.string().min(1).max(120),
    adapterType: z.literal("management-api-v1"),
    baseUrl: z.string().url().max(2_000),
    enabled: z.boolean(),
    version: z.number().int().positive(),
    credentialChanged: z.boolean(),
  })
  .strict();
const providerTestedMetadata = providerMetadata.extend({
  version: z.number().int().nonnegative(),
  persisted: z.boolean(),
  status: z.enum(["ok", "failed"]),
  latencyMs: z.number().int().nonnegative(),
  groupCount: z.number().int().nonnegative().nullable(),
});
const groupScopesMetadata = z
  .object({
    providerId: z.string().min(1).max(191),
    providerKey: z.string().min(1).max(120),
    groupId: z.string().min(1).max(191),
    beforeScopes: scopeArray,
    afterScopes: scopeArray,
    addedScopes: scopeArray,
    removedScopes: scopeArray,
    source: z.enum(["admin_api", "weldall_up", "static_manifest_import", "scope_delete_cascade"]),
    versionBefore: z.number().int().nonnegative(),
    versionAfter: z.number().int().positive(),
  })
  .strict();

const metadataSchemas = {
  "id_jag.issued": idJagIssuedMetadata,
  "id_jag.denied": idJagDeniedMetadata,
  "id_jag.failed": idJagFailedMetadata,
  "machine_client.created": machineClientMetadata,
  "machine_client.updated": machineClientMetadata,
  "machine_client.deactivated": machineClientMetadata,
  "machine_client.deleted": machineClientMetadata,
  "machine_key.registered": machineKeyMetadata,
  "machine_key.revoked": machineKeyMetadata,
  "machine_access.replaced": machineAccessMetadata,
  "machine_token.issued": machineTokenIssuedMetadata,
  "machine_token.denied": machineTokenRequestedMetadata,
  "machine_token.failed": machineTokenRequestedMetadata,
  "user_scopes.created": userScopesMetadata,
  "user_scopes.replaced": userScopesMetadata,
  "user_scopes.deleted": userScopesMetadata,
  "resource_scopes.created": resourceScopesMetadata,
  "resource_scopes.replaced": resourceScopesMetadata,
  "resource_scopes.deleted": resourceScopesMetadata,
  "cli_settings.updated": cliSettingsMetadata,
  "skill.created": skillCreatedMetadata,
  "skill.updated": skillUpdatedMetadata,
  "skill.deleted": skillDeletedMetadata,
  "group_provider.created": providerMetadata,
  "group_provider.updated": providerMetadata,
  "group_provider.deleted": providerMetadata,
  "group_provider.tested": providerTestedMetadata,
  "group_scopes.created": groupScopesMetadata,
  "group_scopes.replaced": groupScopesMetadata,
  "group_scopes.deleted": groupScopesMetadata,
  "iac.plan.generated": iacMetadata,
  "iac.apply.succeeded": iacMetadata,
  "iac.apply.denied": iacMetadata,
  "iac.apply.failed": iacMetadata,
  "iac.object.imported": iacMetadata,
  "iac.object.unmanaged": iacMetadata,
  "iac.state.moved": iacMetadata,
} satisfies Record<AuditEventType, z.ZodType>;

const auditInputSchema = z
  .object({
    eventType: z.enum(AUDIT_EVENT_TYPES),
    actorType: z.enum(["user", "oauth_client", "machine", "anonymous"]),
    actorId: safeText,
    actorEmail: z.string().email().max(320).optional(),
    clientId: z.string().min(1).max(200).optional(),
    requestId: z.string().regex(identifierPattern),
    correlationId: z.string().regex(identifierPattern).optional(),
    deduplicationKey: z.string().min(1).max(300).optional(),
    outcome: z.enum(["success", "denied", "failed"]),
    reasonCode: z
      .enum([
        "invalid_client",
        "invalid_resource",
        "scope_not_granted",
        "invalid_dpop_proof",
        "replay_detected",
        "invalid_grant",
        "invalid_request",
        "internal_error",
        "audit_store_unavailable",
      ])
      .optional(),
    subjectType: z.string().min(1).max(100).optional(),
    subjectId: safeText.optional(),
    metadata: z.unknown(),
  })
  .strict()
  .superRefine((event, context) => {
    if ((event.subjectType === undefined) !== (event.subjectId === undefined)) {
      context.addIssue({
        code: "custom",
        message: "subjectType and subjectId must be paired",
      });
    }
    if ((event.outcome === "success") !== (event.reasonCode === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Only denied or failed events need a reason",
      });
    }
  });

export interface AuditEventInput {
  eventType: AuditEventType;
  actorType: AuditActorType;
  actorId: string;
  actorEmail?: string;
  clientId?: string;
  requestId: string;
  correlationId?: string;
  deduplicationKey?: string;
  outcome: AuditOutcome;
  reasonCode?: AuditReasonCode;
  subjectType?: string;
  subjectId?: string;
  metadata: unknown;
}

export interface AuditWriter {
  write(event: AuditEventInput, transaction?: Prisma.TransactionClient): Promise<void>;
}

export const prismaAuditWriter: AuditWriter = {
  async write(input, transaction) {
    const event = auditInputSchema.parse(input);
    const metadata = metadataSchemas[event.eventType].parse(event.metadata);
    const client = transaction ?? db;
    await client.auditEvent.create({
      data: {
        schemaVersion: AUDIT_SCHEMA_VERSION,
        eventType: event.eventType,
        actorType: event.actorType,
        actorId: event.actorId,
        ...(event.actorEmail ? { actorEmail: event.actorEmail.trim().toLowerCase() } : {}),
        ...(event.clientId ? { clientId: event.clientId } : {}),
        requestId: event.requestId,
        ...(event.correlationId ? { correlationId: event.correlationId } : {}),
        ...(event.deduplicationKey ? { deduplicationKey: event.deduplicationKey } : {}),
        outcome: event.outcome,
        ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
        ...(event.subjectType ? { subjectType: event.subjectType } : {}),
        ...(event.subjectId ? { subjectId: event.subjectId } : {}),
        metadata: metadata as Prisma.InputJsonObject,
      },
    });
  },
};

export async function listAuditEvents(input: {
  page: number;
  pageSize: number;
  from?: Date | undefined;
  to?: Date | undefined;
  eventType?: AuditEventType | undefined;
  outcome?: AuditOutcome | undefined;
  email?: string | undefined;
  relatedUser?: { actorId: string; assignmentId?: string | undefined } | undefined;
  sort: "occurredAt.asc" | "occurredAt.desc";
}): Promise<{ items: AuditEventDto[]; total: number }> {
  const filters: Prisma.AuditEventWhereInput[] = [];
  if (input.email?.trim()) {
    filters.push({
      OR: [
        { actorEmail: { contains: input.email.trim(), mode: "insensitive" } },
        {
          metadata: {
            path: ["normalizedEmail"],
            string_contains: input.email.trim().toLowerCase(),
          },
        },
      ],
    });
  }
  if (input.relatedUser) {
    filters.push({
      OR: [
        { actorType: "user", actorId: input.relatedUser.actorId },
        ...(input.relatedUser.assignmentId
          ? [
              {
                subjectType: "email_scope_assignment",
                subjectId: input.relatedUser.assignmentId,
              },
            ]
          : []),
      ],
    });
  }
  const where: Prisma.AuditEventWhereInput = {
    ...(input.from || input.to
      ? {
          occurredAt: {
            ...(input.from ? { gte: input.from } : {}),
            ...(input.to ? { lte: input.to } : {}),
          },
        }
      : {}),
    ...(input.eventType ? { eventType: input.eventType } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
    ...(filters.length ? { AND: filters } : {}),
  };
  const direction = input.sort === "occurredAt.asc" ? "asc" : "desc";
  const [items, total] = await Promise.all([
    db.auditEvent.findMany({
      where,
      orderBy: [{ occurredAt: direction }, { id: direction }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    }),
    db.auditEvent.count({ where }),
  ]);
  return { items: items.map(serializeAuditEvent), total };
}

export async function getAuditEvent(id: string): Promise<AuditEventDto | null> {
  const event = await db.auditEvent.findUnique({ where: { id } });
  return event ? serializeAuditEvent(event) : null;
}

export const auditRequestIdentifiers = requestIdentifiers;

function serializeAuditEvent(event: {
  id: string;
  schemaVersion: number;
  eventType: string;
  occurredAt: Date;
  actorType: string;
  actorId: string;
  actorEmail: string | null;
  clientId: string | null;
  requestId: string;
  correlationId: string | null;
  outcome: string;
  reasonCode: string | null;
  subjectType: string | null;
  subjectId: string | null;
  metadata: Prisma.JsonValue;
}): AuditEventDto {
  return {
    ...event,
    eventType: event.eventType as AuditEventType,
    occurredAt: event.occurredAt.toISOString(),
    actorType: event.actorType as AuditActorType,
    outcome: event.outcome as AuditOutcome,
    reasonCode: event.reasonCode as AuditReasonCode | null,
  };
}
