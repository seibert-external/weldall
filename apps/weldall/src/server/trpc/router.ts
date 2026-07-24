import { initTRPC, TRPCError } from "@trpc/server";
import { WELDALL_ISSUER } from "@weldall/oauth";
import { z } from "zod";
import {
  AdminDomainError,
  createScope,
  createSkill,
  deleteAssignment,
  deleteScope,
  deleteSkill,
  getCliSettings,
  getSkill,
  listAssignments,
  listScopeOptions,
  listScopes,
  listSkills,
  replaceAssignment,
  requireAdminUser,
  updateCliSettings,
  updateScope,
  updateSkill,
  type AdminActor,
} from "../admin/service";
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
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in is required." });
  }
  assertBrowserRequest(ctx.request);
  const user = await mapDomainErrors(() => requireAdminUser(userId));
  const actor: AdminActor = {
    id: user.id,
    email: user.email,
    requestId: ctx.requestId,
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
        .input(z.object({ key: z.string().max(160), description: z.string().max(500) }).strict())
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
              hidden: z.boolean(),
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
              hidden: z.boolean(),
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
    assignments: trpc.router({
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
    throw new TRPCError({ code: "FORBIDDEN", message: "Invalid request origin." });
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
