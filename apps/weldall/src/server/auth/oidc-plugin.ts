import { randomUUID } from "node:crypto";
import { createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { requireAdminUser } from "../admin/service";
import { errorForLog, logger } from "../observability/logger";
import {
  listLoginProviders,
  loginProviderInput,
  resolveLoginProviderInput,
  saveLoginProvider,
} from "../admin/login-providers";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";
import { WELDALL_ISSUER } from "../oauth/constants";
import { LoginError, providerConfigSchema, emailSchema } from "./oidc-config";
import { randomValue, setupConfigurationIssues } from "./oidc-credentials";
import {
  callbackUrl,
  completeVerifiedAttempt,
  consumeAttempt,
  verifyAttempt,
  startProviderTest,
  type ConsumedAttempt,
  installationCompleted,
  startLogin,
  startSetup,
} from "./login-service";

const setupInput = z
  .object({
    token: z.string().max(128),
    adminEmail: emailSchema,
    acknowledgeAuthority: z.literal(true),
    config: providerConfigSchema,
  })
  .strict();
const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 600,
};
const browserCookie = "__Host-weldall-login-browser";
const adminDraftCookie = "__Host-weldall-admin-provider";
async function adminSession(ctx: Parameters<typeof getSessionFromCtx>[0]) {
  ctx.context.session = null;
  const session = await getSessionFromCtx(ctx, { disableCookieCache: true, disableRefresh: true });
  if (!session) throw new LoginError("admin_required");
  await requireAdminUser(session.user.id);
  return session;
}
function testResultUrl(
  mode: "setup-test" | "provider-test",
  testId: string,
  passed: boolean,
): string {
  const url = new URL("/login/test-result", WELDALL_ISSUER);
  url.searchParams.set("mode", mode);
  url.searchParams.set("testId", testId);
  url.searchParams.set("passed", String(passed));
  return url.toString();
}
export function trustedLoginMutation(request: Request): boolean {
  return (
    request.method === "POST" &&
    request.headers.get("origin") === WELDALL_ISSUER &&
    request.headers.get("x-weldall-csrf") === "1" &&
    (request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json") &&
    (!request.headers.get("sec-fetch-site") ||
      request.headers.get("sec-fetch-site") === "same-origin")
  );
}
export function oidcLoginPlugin(): BetterAuthPlugin {
  return {
    id: "weldall-oidc",
    endpoints: {
      oidcAdminList: createAuthEndpoint(
        "/oidc/admin-providers",
        { method: "GET", requireRequest: true },
        async (ctx) => {
          ctx.setHeader("cache-control", "no-store");
          try {
            const session = await adminSession(ctx);
            return ctx.json({ providers: await listLoginProviders(session.user.id) });
          } catch {
            ctx.setStatus(403);
            return ctx.json({ error: "admin_required" });
          }
        },
      ),
      oidcAdminDraft: createAuthEndpoint(
        "/oidc/admin-draft",
        { method: "POST", requireRequest: true, body: z.object({}).strict() },
        async (ctx) => {
          ctx.setHeader("cache-control", "no-store");
          if (!trustedLoginMutation(ctx.request)) {
            ctx.setStatus(403);
            return ctx.json({ error: "untrusted_request" });
          }
          try {
            const session = await adminSession(ctx);
            if (!(await installationCompleted())) throw new LoginError("setup_required");
            const providerId = randomUUID();
            await ctx.setSignedCookie(
              adminDraftCookie,
              `${session.session.id}:${providerId}`,
              ctx.context.secret,
              cookieOptions,
            );
            return ctx.json({ providerId, callbackUrl: callbackUrl(providerId) });
          } catch {
            ctx.setStatus(403);
            return ctx.json({ error: "admin_required" });
          }
        },
      ),
      oidcAdminSave: createAuthEndpoint(
        "/oidc/admin-save",
        { method: "POST", requireRequest: true, body: loginProviderInput },
        async (ctx) => {
          ctx.setHeader("cache-control", "no-store");
          if (!trustedLoginMutation(ctx.request)) {
            ctx.setStatus(403);
            return ctx.json({ error: "untrusted_request" });
          }
          try {
            const session = await adminSession(ctx);
            if (
              ctx.body.expectedVersion === 0 &&
              (await ctx.getSignedCookie(adminDraftCookie, ctx.context.secret)) !==
                `${session.session.id}:${ctx.body.providerId}`
            )
              throw new LoginError("invalid_admin_draft");
            return ctx.json({
              provider: await saveLoginProvider(
                { userId: session.user.id, sessionId: session.session.id },
                randomUUID(),
                ctx.body,
              ),
            });
          } catch (error) {
            ctx.setStatus(400);
            return ctx.json({
              error: error instanceof LoginError ? error.code : "provider_save_denied",
            });
          }
        },
      ),
      oidcAdminTest: createAuthEndpoint(
        "/oidc/admin-test",
        {
          method: "POST",
          requireRequest: true,
          body: loginProviderInput.extend({ testId: z.string().uuid() }),
        },
        async (ctx) => {
          ctx.setHeader("cache-control", "no-store");
          if (!trustedLoginMutation(ctx.request)) {
            ctx.setStatus(403);
            return ctx.json({ error: "untrusted_request" });
          }
          try {
            const session = await adminSession(ctx);
            if (
              ctx.body.expectedVersion === 0 &&
              (await ctx.getSignedCookie(adminDraftCookie, ctx.context.secret)) !==
                `${session.session.id}:${ctx.body.providerId}`
            )
              throw new LoginError("invalid_admin_draft");
            const { config } = await resolveLoginProviderInput(ctx.body);
            const browser =
              (await ctx.getSignedCookie(browserCookie, ctx.context.secret)) || randomValue();
            const result = await startProviderTest({
              providerId: ctx.body.providerId,
              config,
              browser,
              testAdminId: session.user.id,
              testSessionId: session.session.id,
              testId: ctx.body.testId,
            });
            await ctx.setSignedCookie(browserCookie, browser, ctx.context.secret, cookieOptions);
            return ctx.json(result);
          } catch (error) {
            ctx.setStatus(400);
            return ctx.json({
              error: error instanceof LoginError ? error.code : "provider_test_denied",
            });
          }
        },
      ),
      oidcStart: createAuthEndpoint(
        "/oidc/start",
        {
          method: "POST",
          requireRequest: true,
          body: z
            .object({ providerId: z.string().uuid(), returnTo: z.string().max(8192).default("/") })
            .strict(),
        },
        async (ctx) => {
          ctx.setHeader("cache-control", "no-store");
          if (!trustedLoginMutation(ctx.request)) {
            ctx.setStatus(403);
            return ctx.json({ error: "untrusted_request" });
          }
          try {
            const browser =
              (await ctx.getSignedCookie(browserCookie, ctx.context.secret)) || randomValue();
            const result = await startLogin({ ...ctx.body, browser });
            await ctx.setSignedCookie(browserCookie, browser, ctx.context.secret, cookieOptions);
            return ctx.json(result);
          } catch (error) {
            ctx.setStatus(400);
            return ctx.json({
              error: error instanceof LoginError ? error.code : "login_unavailable",
            });
          }
        },
      ),
      oidcSetup: createAuthEndpoint(
        "/oidc/setup",
        {
          method: "POST",
          requireRequest: true,
          body: z.discriminatedUnion("mode", [
            setupInput.extend({ mode: z.literal("setup") }),
            setupInput.extend({ mode: z.literal("setup-test"), testId: z.string().uuid() }),
          ]),
        },
        async (ctx) => {
          ctx.setHeader("cache-control", "no-store");
          if (!trustedLoginMutation(ctx.request)) {
            ctx.setStatus(403);
            return ctx.json({ error: "untrusted_request" });
          }
          try {
            if (await installationCompleted()) throw new LoginError("setup_completed");
            if (setupConfigurationIssues().length) {
              ctx.setStatus(503);
              return ctx.json({ error: "setup_unavailable" });
            }
            const browser =
              (await ctx.getSignedCookie(browserCookie, ctx.context.secret)) || randomValue();
            const result = await startSetup({ ...ctx.body, browser });
            await ctx.setSignedCookie(browserCookie, browser, ctx.context.secret, cookieOptions);
            return ctx.json(result);
          } catch (error) {
            if (error instanceof LoginError) {
              ctx.setStatus(400);
              return ctx.json({ error: error.code });
            }
            logger.error(
              { event: "login.setup.failed", error: errorForLog(error) },
              "OIDC setup failed",
            );
            ctx.setStatus(500);
            return ctx.json({ error: "setup_failed" });
          }
        },
      ),
      // Same endpoint key intentionally replaces Better Auth's built-in unverified upstream callback.
      callbackOAuth: createAuthEndpoint(
        "/callback/:providerId",
        { method: "GET", requireRequest: true },
        async (ctx) => {
          ctx.setHeader("cache-control", "no-store");
          ctx.setHeader("referrer-policy", "no-referrer");
          let result: Awaited<ReturnType<typeof completeVerifiedAttempt>>;
          let attempt: ConsumedAttempt | undefined;
          try {
            const url = new URL(ctx.request.url);
            if (
              url.search.length > 16384 ||
              !z.string().uuid().safeParse(ctx.params.providerId).success
            )
              throw new LoginError("invalid_callback");
            for (const name of ["state", "code", "iss", "error"])
              if (url.searchParams.getAll(name).length > 1)
                throw new LoginError("invalid_callback");
            const state = url.searchParams.get("state");
            const browser = await ctx.getSignedCookie(browserCookie, ctx.context.secret);
            if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !browser)
              throw new LoginError("invalid_attempt");
            attempt = await consumeAttempt(ctx.params.providerId, state, browser);
            const assertTestAdmin = async () => {
              const session = await adminSession(ctx);
              if (
                session.user.id !== attempt!.payload.testAdminId ||
                session.session.id !== attempt!.payload.testSessionId
              )
                throw new LoginError("invalid_test_session");
            };
            if (attempt.mode === "provider-test") await assertTestAdmin();
            const identity = await verifyAttempt(attempt, {
              code: url.searchParams.get("code") ?? undefined,
              issuer: url.searchParams.get("iss") ?? undefined,
              error: url.searchParams.get("error") ?? undefined,
            });
            if (attempt.mode === "provider-test" || attempt.mode === "setup-test") {
              if (attempt.mode === "provider-test") await assertTestAdmin();
              return ctx.redirect(testResultUrl(attempt.mode, attempt.payload.testId!, true));
            }
            result = await completeVerifiedAttempt(attempt, identity);
          } catch (error) {
            if (
              (attempt?.mode === "provider-test" || attempt?.mode === "setup-test") &&
              attempt.payload.testId
            )
              return ctx.redirect(testResultUrl(attempt.mode, attempt.payload.testId, false));
            const code = error instanceof LoginError ? error.code : "login_unavailable";
            return ctx.redirect(`${WELDALL_ISSUER}/login?loginError=${encodeURIComponent(code)}`);
          }
          // Use Better Auth's own session creation and signed cookies, only after committed completion/linking.
          const session = await ctx.context.internalAdapter.createSession(result.user.id);
          if (!session)
            return ctx.redirect(`${WELDALL_ISSUER}/login?loginError=session_unavailable`);
          await setSessionCookie(ctx, { session, user: result.user });
          return ctx.redirect(`${WELDALL_ISSUER}${result.returnTo}`);
        },
      ),
    },
  };
}
