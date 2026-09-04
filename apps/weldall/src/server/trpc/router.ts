import { initTRPC, TRPCError } from "@trpc/server";
import { SKILL_TAG_LENGTH_LIMIT, SKILL_TAG_LIMIT } from "@weldall/sdk";
import { z } from "zod";
import { isTrustedBrowserRequest } from "../auth/browser-request";
import { AUDIT_EVENT_TYPES, getAuditEvent, listAuditEvents } from "../audit/service";
import {
  AdminDomainError,
  createResource,
  createScope,
  createSkill,
  deleteAssignment,
  deleteResource,
  deleteScope,
  deleteSkill,
  getAssignment,
  getChatSettings,
  getCliSettings,
  getResource,
  getSkill,
  getUser,
  listAssignments,
  listResources,
  listScopeOptions,
  listScopes,
  listSkills,
  listSkillSourceOptions,
  listUserAuditEvents,
  listUsers,
  replaceAssignment,
  requireAdminUser,
  updateChatSettings,
  updateCliSettings,
  updateResource,
  updateScope,
  updateSkill,
  type AdminActor,
} from "../admin/service";
import {
  DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS,
  MAX_SKILL_RETRIEVAL_WINDOW_DAYS,
  getVisibleSkillRetrievalSummary,
} from "../skills/retrieval-metrics";
import {
  createGroupAssignments,
  createGroupProvider,
  deleteGroupAssignment,
  deleteGroupProvider,
  getGroupAssignment,
  getGroupProvider,
  getProviderGroups,
  listAssignedProviderGroupIds,
  listGroupAssignments,
  listGroupProviders,
  replaceGroupAssignment,
  searchProviderGroups,
  testGroupProvider,
  updateGroupProvider,
} from "../group-providers/service";
import { refreshResourceCatalog } from "../skills/catalogs";
import { errorForLog, logger } from "../observability/logger";
import {
  createMachineClient,
  getMachineClient,
  listMachineAccessOptions,
  listMachineClients,
  registerMachineKey,
  replaceMachineAccess,
  revokeMachineKey,
  updateMachineClient,
} from "../machines/service";
import type { TrpcContext } from "./context";

const trpc = initTRPC.context<TrpcContext>().create();
const loggedProcedure = trpc.procedure.use(async ({ path, type, next }) => {
  const started = performance.now();
  const result = await next();
  const fields = {
    event: "trpc.procedure.completed",
    procedure: path,
    procedureType: type,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    outcome: result.ok ? "success" : "failure",
    ...(!result.ok ? { error: errorForLog(result.error), errorCode: result.error.code } : {}),
  };
  if (result.ok) logger.info(fields, "tRPC procedure completed");
  else if (result.error.code === "INTERNAL_SERVER_ERROR")
    logger.error(fields, "tRPC procedure failed");
  else logger.warn(fields, "tRPC procedure failed");
  return result;
});
const pageInput = {
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(1).max(200).default(20),
  q: z.string().max(200).optional(),
};
const skillMetaInput = z
  .object({
    tags: z.array(z.string().min(1).max(SKILL_TAG_LENGTH_LIMIT)).max(SKILL_TAG_LIMIT).optional(),
    owner: z.string().optional(),
    appearance: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .optional();
const skillRetrievalSummaryInput = z
  .object({
    slug: z.string().min(1).max(120),
    days: z
      .number()
      .int()
      .min(1)
      .max(MAX_SKILL_RETRIEVAL_WINDOW_DAYS)
      .default(DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS),
  })
  .strict();

const adminProcedure = loggedProcedure.use(async ({ ctx, next }) => {
  const userId = ctx.session?.user.id;
  if (!userId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Sign in is required.",
    });
  }
  assertBrowserRequest(ctx.request);
  const user = await mapDomainErrors(() => requireAdminUser(userId));
  const actor: AdminActor = {
    id: user.id,
    email: user.email,
    requestId: ctx.requestId,
    ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
  };
  return next({ ctx: { ...ctx, adminActor: actor } });
});

export const appRouter = trpc.router({
  status: loggedProcedure.query(({ ctx }) => ({
    authenticated: Boolean(ctx.session),
    email: ctx.session?.user.email ?? null,
  })),
  skillRetrievalMetrics: trpc.router({
    summary: loggedProcedure.input(skillRetrievalSummaryInput).query(async ({ ctx, input }) => {
      const email = ctx.session?.user.email;
      if (!email) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Sign in is required.",
        });
      }
      const summary = await getVisibleSkillRetrievalSummary(email, input.slug, input.days);
      if (!summary) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Skill not found",
        });
      }
      return summary;
    }),
  }),
  admin: trpc.router({
    status: adminProcedure.query(({ ctx }) => ({
      authenticated: true as const,
      email: ctx.adminActor.email ?? null,
    })),
    users: trpc.router({
      list: adminProcedure
        .input(
          z
            .object({
              ...pageInput,
              sort: z
                .enum([
                  "name.asc",
                  "name.desc",
                  "email.asc",
                  "email.desc",
                  "createdAt.asc",
                  "createdAt.desc",
                ])
                .default("createdAt.desc"),
            })
            .strict(),
        )
        .query(({ input }) => mapDomainErrors(() => listUsers(input))),
      get: adminProcedure
        .input(z.object({ id: z.string().min(1).max(191) }).strict())
        .query(({ input }) => mapDomainErrors(() => getUser(input.id))),
    }),
    auditEvents: trpc.router({
      list: adminProcedure
        .input(
          z
            .object({
              page: z.number().int().positive().default(1),
              pageSize: z.number().int().min(1).max(200).default(20),
              from: z
                .string()
                .datetime()
                .transform((value) => new Date(value))
                .optional(),
              to: z
                .string()
                .datetime()
                .transform((value) => new Date(value))
                .optional(),
              eventType: z.enum(AUDIT_EVENT_TYPES).optional(),
              outcome: z.enum(["success", "denied", "failed"]).optional(),
              email: z.string().max(320).optional(),
              userId: z.string().min(1).max(191).optional(),
              sort: z.enum(["occurredAt.asc", "occurredAt.desc"]).default("occurredAt.desc"),
            })
            .strict()
            .refine((input) => !input.from || !input.to || input.from <= input.to, {
              message: "The start of the audit period must precede its end.",
            })
            .refine((input) => !input.email || !input.userId, {
              message: "Choose either an email filter or a user, not both.",
            }),
        )
        .query(({ input }) => {
          const { userId, ...auditInput } = input;
          return mapDomainErrors(() =>
            userId ? listUserAuditEvents(userId, auditInput) : listAuditEvents(auditInput),
          );
        }),
      get: adminProcedure
        .input(z.object({ id: z.string().min(1).max(191) }).strict())
        .query(({ input }) => mapDomainErrors(() => getAuditEvent(input.id))),
    }),
    chat: trpc.router({
      get: adminProcedure.query(() => mapDomainErrors(getChatSettings)),
      update: adminProcedure
        .input(
          z
            .object({
              enabled: z.boolean(),
              baseUrl: z.string().max(2_000),
              model: z.string().max(200),
              apiKey: z.string().max(10_000).optional(),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => updateChatSettings(input, ctx.adminActor)),
        ),
    }),
    cli: trpc.router({
      get: adminProcedure.query(() => mapDomainErrors(getCliSettings)),
      update: adminProcedure
        .input(
          z
            .object({
              appendix: z.string().max(100_000),
              logoUrl: z.string().max(2_000),
              darkLogoUrl: z.string().max(2_000).optional(),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => updateCliSettings(input, ctx.adminActor)),
        ),
    }),
    machineClients: trpc.router({
      list: adminProcedure.query(() => mapDomainErrors(listMachineClients)),
      accessOptions: adminProcedure.query(() => mapDomainErrors(listMachineAccessOptions)),
      get: adminProcedure
        .input(z.object({ id: z.string().min(1).max(191) }).strict())
        .query(({ input }) => mapDomainErrors(() => getMachineClient(input.id))),
      create: adminProcedure
        .input(
          z
            .object({
              clientId: z.string().max(128),
              name: z.string().max(200),
              key: z
                .object({
                  kid: z.string().max(128),
                  publicJwk: z.unknown(),
                })
                .strict(),
              access: z
                .object({
                  resourceIds: z.array(z.string().min(1).max(191)).max(100),
                  scopeIds: z.array(z.string().min(1).max(191)).max(100),
                })
                .strict(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => createMachineClient(input, ctx.adminActor)),
        ),
      update: adminProcedure
        .input(
          z
            .object({
              id: z.string().min(1).max(191),
              name: z.string().max(200),
              enabled: z.boolean(),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => updateMachineClient(input, ctx.adminActor)),
        ),
      registerKey: adminProcedure
        .input(
          z
            .object({
              clientId: z.string().min(1).max(191),
              kid: z.string().max(128),
              publicJwk: z.unknown(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => registerMachineKey(input, ctx.adminActor)),
        ),
      revokeKey: adminProcedure
        .input(
          z
            .object({ clientId: z.string().min(1).max(191), keyId: z.string().min(1).max(191) })
            .strict(),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => revokeMachineKey(input, ctx.adminActor)),
        ),
      replaceAccess: adminProcedure
        .input(
          z
            .object({
              clientId: z.string().min(1).max(191),
              resourceIds: z.array(z.string().min(1).max(191)).max(100),
              scopeIds: z.array(z.string().min(1).max(191)).max(100),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => replaceMachineAccess(input, ctx.adminActor)),
        ),
    }),
    resources: trpc.router({
      list: adminProcedure
        .input(
          z
            .object({
              ...pageInput,
              sort: z
                .enum(["name.asc", "name.desc", "updatedAt.asc", "updatedAt.desc"])
                .default("name.asc"),
            })
            .strict(),
        )
        .query(({ input }) => mapDomainErrors(() => listResources(input))),
      get: adminProcedure
        .input(z.object({ id: z.string().min(1).max(191) }).strict())
        .query(({ input }) => mapDomainErrors(() => getResource(input.id))),
      create: adminProcedure
        .input(
          z
            .object({
              key: z.string().max(120),
              name: z.string().max(200),
              resourceIdentifier: z.string().max(2_000),
              authorizationServer: z.string().max(2_000),
              downstreamClientId: z.string().max(200),
              enabled: z.boolean(),
              skillDiscoveryEnabled: z.boolean(),
              scopeIds: z.array(z.string().min(1).max(191)).max(100),
              requestPrefixes: z.array(z.string().max(2_000)).min(1).max(100),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) => mapDomainErrors(() => createResource(input, ctx.adminActor))),
      update: adminProcedure
        .input(
          z
            .object({
              id: z.string().min(1).max(191),
              name: z.string().max(200),
              authorizationServer: z.string().max(2_000),
              downstreamClientId: z.string().max(200),
              enabled: z.boolean(),
              skillDiscoveryEnabled: z.boolean(),
              scopeIds: z.array(z.string().min(1).max(191)).max(100),
              requestPrefixes: z.array(z.string().max(2_000)).min(1).max(100),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) => mapDomainErrors(() => updateResource(input, ctx.adminActor))),
      refreshSkills: adminProcedure
        .input(z.object({ id: z.string().min(1).max(191) }).strict())
        .mutation(({ input }) => refreshResourceCatalog(input.id)),
      delete: adminProcedure
        .input(
          z
            .object({
              id: z.string().min(1).max(191),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) => mapDomainErrors(() => deleteResource(input, ctx.adminActor))),
    }),
    scopes: trpc.router({
      list: adminProcedure
        .input(
          z
            .object({
              ...pageInput,
              sort: z
                .enum(["key.asc", "key.desc", "updatedAt.asc", "updatedAt.desc"])
                .default("key.asc"),
            })
            .strict(),
        )
        .query(({ input }) => mapDomainErrors(() => listScopes(input))),
      options: adminProcedure.query(() => mapDomainErrors(listScopeOptions)),
      create: adminProcedure
        .input(
          z
            .object({
              key: z.string().max(160),
              description: z.string().max(500),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) => mapDomainErrors(() => createScope(input, ctx.adminActor))),
      update: adminProcedure
        .input(
          z
            .object({
              id: z.string().min(1).max(191),
              description: z.string().max(500),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) => mapDomainErrors(() => updateScope(input, ctx.adminActor))),
      delete: adminProcedure
        .input(
          z
            .object({
              id: z.string().min(1).max(191),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) => mapDomainErrors(() => deleteScope(input, ctx.adminActor))),
    }),
    skills: trpc.router({
      list: adminProcedure
        .input(
          z
            .object({
              ...pageInput,
              source: z.string().min(1).max(191).optional(),
              sort: z
                .enum(["title.asc", "title.desc", "updatedAt.asc", "updatedAt.desc"])
                .default("title.asc"),
            })
            .strict(),
        )
        .query(({ input }) => mapDomainErrors(() => listSkills(input))),
      sources: adminProcedure.query(() => mapDomainErrors(listSkillSourceOptions)),
      get: adminProcedure
        .input(z.object({ id: z.string().min(1).max(191) }).strict())
        .query(({ input }) => mapDomainErrors(() => getSkill(input.id))),
      create: adminProcedure
        .input(
          z
            .object({
              slug: z.string().max(120),
              title: z.string().max(200),
              content: z.string().max(100_000),
              requiredScopes: z.array(z.string().max(160)).max(100),
              visibility: z.enum(["DEFAULT", "HIDDEN_IF_UNALLOWED"]),
              meta: skillMetaInput,
              lastUpdatedAt: z.string().optional(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) => mapDomainErrors(() => createSkill(input, ctx.adminActor))),
      update: adminProcedure
        .input(
          z
            .object({
              id: z.string().min(1).max(191),
              title: z.string().max(200),
              content: z.string().max(100_000),
              requiredScopes: z.array(z.string().max(160)).max(100),
              visibility: z.enum(["DEFAULT", "HIDDEN_IF_UNALLOWED"]),
              meta: skillMetaInput,
              lastUpdatedAt: z.string().optional(),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) => mapDomainErrors(() => updateSkill(input, ctx.adminActor))),
      delete: adminProcedure
        .input(
          z
            .object({
              id: z.string().min(1).max(191),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) => mapDomainErrors(() => deleteSkill(input, ctx.adminActor))),
    }),
    groupProviders: trpc.router({
      list: adminProcedure.query(() => mapDomainErrors(listGroupProviders)),
      get: adminProcedure
        .input(z.object({ id: z.string().min(1).max(191) }).strict())
        .query(({ input }) => mapDomainErrors(() => getGroupProvider(input.id))),
      create: adminProcedure
        .input(
          z
            .object({
              key: z.string().max(120),
              name: z.string().max(200),
              adapterType: z.literal("management-api-v1"),
              baseUrl: z.string().max(2_000),
              token: z.string().min(1).max(10_000),
              enabled: z.boolean(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => createGroupProvider(input, ctx.adminActor)),
        ),
      update: adminProcedure
        .input(
          z
            .object({
              id: z.string().min(1).max(191),
              name: z.string().max(200),
              baseUrl: z.string().max(2_000),
              token: z.string().max(10_000).optional(),
              enabled: z.boolean(),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => updateGroupProvider(input, ctx.adminActor)),
        ),
      test: adminProcedure
        .input(
          z.union([
            z
              .object({
                id: z.string().min(1).max(191),
                baseUrl: z.string().max(2_000).optional(),
                token: z.string().max(10_000).optional(),
              })
              .strict(),
            z
              .object({
                key: z.string().max(120),
                adapterType: z.literal("management-api-v1"),
                baseUrl: z.string().max(2_000),
                token: z.string().min(1).max(10_000),
              })
              .strict(),
          ]),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => testGroupProvider(input, ctx.adminActor)),
        ),
      searchGroups: adminProcedure
        .input(
          z
            .object({
              providerId: z.string().min(1).max(191),
              query: z.string().max(200),
              limit: z.number().int().min(1).max(100).default(20),
            })
            .strict(),
        )
        .query(({ input }) => mapDomainErrors(() => searchProviderGroups(input))),
      getGroups: adminProcedure
        .input(
          z
            .object({
              providerId: z.string().min(1).max(191),
              groupIds: z.array(z.string().min(1).max(191)).min(1).max(100),
            })
            .strict(),
        )
        .query(({ input }) => mapDomainErrors(() => getProviderGroups(input))),
      delete: adminProcedure
        .input(
          z
            .object({
              id: z.string().min(1).max(191),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => deleteGroupProvider(input, ctx.adminActor)),
        ),
    }),
    groupAssignments: trpc.router({
      get: adminProcedure
        .input(z.object({ id: z.string().min(1).max(191) }).strict())
        .query(({ input }) => mapDomainErrors(() => getGroupAssignment(input.id))),
      assignedGroupIds: adminProcedure
        .input(z.object({ providerId: z.string().min(1).max(191) }).strict())
        .query(({ input }) =>
          mapDomainErrors(() => listAssignedProviderGroupIds(input.providerId)),
        ),
      list: adminProcedure
        .input(z.object({ ...pageInput }).strict())
        .query(({ input }) => mapDomainErrors(() => listGroupAssignments(input))),
      createMany: adminProcedure
        .input(
          z
            .object({
              providerId: z.string().min(1).max(191),
              groupIds: z.array(z.string().min(1).max(191)).min(1).max(100),
              scopeKeys: z.array(z.string().max(160)).min(1).max(100),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => createGroupAssignments(input, ctx.adminActor)),
        ),
      replace: adminProcedure
        .input(
          z
            .object({
              id: z.string().min(1).max(191),
              scopeKeys: z.array(z.string().max(160)).min(1).max(100),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => replaceGroupAssignment(input, ctx.adminActor)),
        ),
      delete: adminProcedure
        .input(
          z
            .object({
              id: z.string().min(1).max(191),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => deleteGroupAssignment(input, ctx.adminActor)),
        ),
    }),
    assignments: trpc.router({
      get: adminProcedure
        .input(z.object({ id: z.string().min(1).max(191) }).strict())
        .query(({ input }) => mapDomainErrors(() => getAssignment(input.id))),
      list: adminProcedure
        .input(
          z
            .object({
              ...pageInput,
              exactEmail: z.string().max(320).optional(),
              sort: z
                .enum(["email.asc", "email.desc", "updatedAt.asc", "updatedAt.desc"])
                .default("email.asc"),
            })
            .strict(),
        )
        .query(({ input }) => mapDomainErrors(() => listAssignments(input))),
      replace: adminProcedure
        .input(
          z
            .object({
              email: z.string().max(320),
              scopeKeys: z.array(z.string().max(160)).max(100),
              expectedVersion: z.number().int().positive().nullable(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => replaceAssignment(input, ctx.adminActor)),
        ),
      delete: adminProcedure
        .input(
          z
            .object({
              id: z.string().min(1).max(191),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => deleteAssignment(input, ctx.adminActor)),
        ),
    }),
  }),
});

export type AppRouter = typeof appRouter;

export function assertBrowserRequest(request: Request): void {
  if (!isTrustedBrowserRequest(request)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Invalid request origin.",
    });
  }
}

async function mapDomainErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof AdminDomainError)) throw error;
    const code =
      error.code === "FORBIDDEN"
        ? "FORBIDDEN"
        : error.code === "NOT_FOUND"
          ? "NOT_FOUND"
          : error.code === "CONFLICT" || error.code === "LAST_ADMIN"
            ? "CONFLICT"
            : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message, cause: error });
  }
}
