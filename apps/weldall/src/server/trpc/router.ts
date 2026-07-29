import { initTRPC, TRPCError } from "@trpc/server";
import { WELDALL_ISSUER } from "../oauth/constants";
import { z } from "zod";
import { AUDIT_EVENT_TYPES, getAuditEvent, listAuditEvents } from "../audit/service";
import {
  AdminDomainError,
  createResource,
  createScope,
  createSkill,
  deleteAssignment,
  deleteScope,
  deleteSkill,
  getAssignment,
  getCliSettings,
  getResource,
  getSkill,
  getUser,
  listAssignments,
  listResources,
  listScopeOptions,
  listScopes,
  listSkills,
  listUserAuditEvents,
  listUsers,
  replaceAssignment,
  requireAdminUser,
  updateCliSettings,
  updateResource,
  updateScope,
  updateSkill,
  type AdminActor,
} from "../admin/service";
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
import type { TrpcContext } from "./context";

const trpc = initTRPC.context<TrpcContext>().create();
const pageInput = {
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
  q: z.string().max(200).optional(),
};

const adminProcedure = trpc.procedure.use(async ({ ctx, next }) => {
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
  status: trpc.procedure.query(({ ctx }) => ({
    authenticated: Boolean(ctx.session),
    email: ctx.session?.user.email ?? null,
  })),
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
              pageSize: z.number().int().min(1).max(100).default(20),
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
    cli: trpc.router({
      get: adminProcedure.query(() => mapDomainErrors(getCliSettings)),
      update: adminProcedure
        .input(
          z
            .object({
              appendix: z.string().max(100_000),
              expectedVersion: z.number().int().positive(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) =>
          mapDomainErrors(() => updateCliSettings(input, ctx.adminActor)),
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
              sort: z
                .enum(["title.asc", "title.desc", "updatedAt.asc", "updatedAt.desc"])
                .default("title.asc"),
            })
            .strict(),
        )
        .query(({ input }) => mapDomainErrors(() => listSkills(input))),
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
  if (request.method === "GET") return;
  const allowedOrigins = new Set([
    new URL(WELDALL_ISSUER).origin,
    ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:3000"]),
  ]);
  const origin = request.headers.get("origin");
  const contentType = request.headers.get("content-type") ?? "";
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    !origin ||
    !allowedOrigins.has(origin) ||
    request.headers.get("x-weldall-csrf") !== "1" ||
    !contentType.toLowerCase().startsWith("application/json") ||
    (fetchSite && fetchSite !== "same-origin")
  ) {
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
