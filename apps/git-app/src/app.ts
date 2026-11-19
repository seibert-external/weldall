import { Hono, type Context } from "hono";
import { z } from "zod";
import { createWeldallAppHostClient, inMemory, type AuthContext } from "@weldall/sdk";
import { initWeldall, type WeldallVariables } from "@weldall/sdk/hono";
import { authorizePerson } from "./access.js";
import { createAuditReporter } from "./audit.js";
import type { GitAppConfig } from "./config.js";
import { GitAppError } from "./errors.js";
import { createGitCredentialSigner } from "./git/credentials.js";
import type { GitProxyLimits, TransferLimiter } from "./git/limits.js";
import { gitRemotePath } from "./git/paths.js";
import { createGitProxy } from "./git/proxy.js";
import { openConfiguredHost, type ConfiguredHost } from "./hosts/index.js";
import { errorForLog, jsonLogger, type Logger } from "./log.js";
import { runChecklist } from "./services/checklist.js";
import type { GitAppServices, Person } from "./services/context.js";
import { createAppRepository } from "./services/create-app.js";
import { createIssueLimiter, issueGitCredential } from "./services/git-credentials.js";
import { resolveOwnApp } from "./services/own-app.js";
import { PULL_REQUEST_BODY_LIMIT, PULL_REQUEST_TITLE_LIMIT } from "./services/pull-request-body.js";
import { openPullRequest } from "./services/pull-requests.js";
import { readAppStatus } from "./services/status.js";
import { gitAppSkills } from "./skills.js";
import type { AppHostApi } from "./weldall.js";

const MAX_BODY_BYTES = 32_000;
const privateHeaders = { "cache-control": "no-store", pragma: "no-cache" } as const;

const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\u0000-\u001f\u007f]*$/);
const createAppBody = z
  .object({ template: z.string().max(100), name: z.string().max(100), purpose: text(300) })
  .strict();
const pullRequestBody = z
  .object({
    head: z.string().min(1).max(255),
    title: z.string().min(1).max(PULL_REQUEST_TITLE_LIMIT),
    body: z.string().max(PULL_REQUEST_BODY_LIMIT).default(""),
  })
  .strict();
const gitCredentialBody = z
  .object({
    path: z.string().min(1).max(400),
    // Read unless write is asked for explicitly.
    access: z.enum(["read", "write"]).default("read"),
  })
  .strict();

type Env = { Variables: WeldallVariables };

export interface CreateGitAppOptions {
  config: GitAppConfig;
  /** Weldall's app host API; defaults to the SDK client with the configured machine client. */
  weldall?: AppHostApi;
  /** The opened Git host; defaults to the configured one. */
  host?: ConfiguredHost;
  log?: Logger;
  /** Audit event ids (tests). */
  eventId?: () => string;
  /** Git proxy limits and transfer limiter (tests); defaults to `GIT_PROXY_LIMITS`. */
  gitProxy?: { limits?: Partial<GitProxyLimits>; limiter?: TransferLimiter };
}

/**
 * The Git app: a resource secured with `@weldall/sdk` (its own authorization server for Weldall's
 * ID-JAG exchange, DPoP-protected routes with scope policies) that keeps apps' repositories on
 * one Git host and uses Weldall's app host API for registry, ownership, permissions and audit.
 */
export function createGitApp(options: CreateGitAppOptions) {
  const { config } = options;
  const log = options.log ?? jsonLogger;
  const weldall =
    options.weldall ??
    createWeldallAppHostClient({
      issuer: config.weldall.issuer,
      clientId: config.weldall.machineClientId,
      kid: config.weldall.machineKid,
      key: config.weldall.machineKey,
      resource: config.resource,
    });
  const host =
    options.host ?? openConfiguredHost({ configuration: config.host, secret: config.hostSecret });
  const services: GitAppServices = {
    host,
    weldall,
    audit: createAuditReporter({
      weldall,
      log,
      ...(options.eventId ? { eventId: options.eventId } : {}),
    }),
    log,
    scopes: config.scopes,
  };

  const auth = initWeldall(config.weldall.issuer, {
    resource: config.resource,
    publicOrigin: config.publicOrigin,
    clientId: config.downstreamClientId,
    supportedScopes: [config.scopes.publish, config.scopes.admin],
    signingKey: config.signingKey,
    // One instance per host: proofs are replay-checked in memory. Several replicas need a shared store.
    replayStore: inMemory(),
    // Skill discovery: Weldall fetches the catalog with a signed assertion and shows each skill
    // only to people who hold its scopes.
    skills: { items: gitAppSkills(config) },
  });

  const signer = createGitCredentialSigner({
    keys: config.gitCredentialKeys,
    resource: config.resource,
  });
  const issueLimiter = createIssueLimiter();
  const gitProxy = createGitProxy({ services, signer, ...options.gitProxy });
  /** Where git reaches an app's repository on this instance. */
  const gitRemote = (repository: { owner: string; name: string }) => {
    const remotePath = gitRemotePath(repository);
    return { remotePath, remoteUrl: `${config.publicOrigin}${remotePath}` };
  };

  const app = new Hono<Env>();
  auth.registerRoutes(app);
  app.get("/health", (c) => c.json({ status: "ok" }, 200, privateHeaders));

  /** The person behind the request; apps belong to people, so machine callers are refused. */
  const personOf = (context: Context<Env>): Person => {
    const caller: AuthContext = auth.getAuth(context);
    if (caller.identityType !== "user")
      throw new GitAppError("access_denied", "Apps are owned by people; sign in as a user.", 403);
    return { id: caller.subject };
  };
  const handle =
    (handler: (context: Context<Env>) => Promise<unknown>) => async (context: Context<Env>) => {
      try {
        return context.json(await handler(context), 200, privateHeaders);
      } catch (error) {
        return errorResponse(context, error, log);
      }
    };
  const publish = auth.protect({ scopes: [config.scopes.publish] });
  const admin = auth.protect({ scopes: [config.scopes.admin] });

  /**
   * Creates the repository for the person's new app from a template and registers it in Weldall.
   * Repeating the call resumes with the same repository.
   */
  app.post(
    "/api/apps",
    publish,
    handle(async (c) => {
      const created = await createAppRepository({
        services,
        person: personOf(c),
        input: await jsonBody(c.req.raw, createAppBody),
        signal: c.req.raw.signal,
      });
      return { ...created, git: gitRemote(created.repository) };
    }),
  );
  /** One of the person's apps as Weldall's registry has it. Listing stays in Weldall (`/api/me/apps`). */
  app.get(
    "/api/apps/:id",
    publish,
    handle(async (c) => {
      const person = personOf(c);
      await authorizePerson(weldall, person.id, [config.scopes.publish]);
      const own = await resolveOwnApp(services, person, c.req.param("id") ?? "", {
        requireReady: false,
      });
      return { app: own, git: gitRemote(own.repository) };
    }),
  );
  /** Opens the pull request of one of the person's apps from a publish branch. */
  app.post(
    "/api/apps/:id/pull-requests",
    publish,
    handle(async (c) =>
      openPullRequest({
        services,
        person: personOf(c),
        appId: c.req.param("id") ?? "",
        input: await jsonBody(c.req.raw, pullRequestBody),
        signal: c.req.raw.signal,
      }),
    ),
  );
  /** Pull request state, reviews, checks and links of one of the person's apps. */
  app.get(
    "/api/apps/:id/status",
    publish,
    handle(async (c) =>
      readAppStatus({
        services,
        person: personOf(c),
        appId: c.req.param("id") ?? "",
        branch: c.req.query("branch"),
        signal: c.req.raw.signal,
      }),
    ),
  );
  /** The administrator's set-up checklist of this instance's Git host; `?app=<id>` for repository checks. */
  app.get(
    "/api/admin/checklist",
    admin,
    handle(async (c) =>
      runChecklist({
        services,
        person: personOf(c),
        appId: c.req.query("app"),
        signal: c.req.raw.signal,
      }),
    ),
  );
  /**
   * Issues a short-lived git credential for one of the person's apps:
   * `{ path: "git/<owner>/<repository>.git", access?: "read" | "write" }` returns
   * `{ username, password, expiresAt }` for git's Basic auth, valid only at this instance's
   * `/git/` route.
   */
  app.post(
    "/api/git-credentials",
    publish,
    handle(async (c) =>
      issueGitCredential({
        services,
        signer,
        limiter: issueLimiter,
        person: personOf(c),
        input: await jsonBody(c.req.raw, gitCredentialBody),
      }),
    ),
  );
  /**
   * Git's smart HTTP: `GET /git/<owner>/<repository>.git/info/refs?service=git-upload-pack|
   * git-receive-pack` and `POST /git/<owner>/<repository>.git/git-upload-pack|git-receive-pack`.
   * Basic auth with a git credential, never an access token.
   */
  app.on(["GET", "POST"], "/git/*", (c) => gitProxy(c.req.raw));
  return app;
}

/** Reads a bounded JSON body; any mismatch is `400 invalid_request` without echoing the input. */
async function jsonBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    throw new GitAppError("invalid_request", "JSON required.");
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES)
    throw new GitAppError("invalid_request", "The request body is too large.");
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new GitAppError("invalid_request", "Invalid request body.");
  }
}

/** Fixed error contract `{ error, error_description }`; unknown errors are logged, not shown. */
function errorResponse(context: Context<Env>, error: unknown, log: Logger) {
  if (error instanceof GitAppError)
    return context.json(
      { error: error.code, error_description: error.message },
      error.status as 400,
      privateHeaders,
    );
  if (error instanceof Error && error.name === "AbortError")
    return context.json(
      { error: "request_aborted", error_description: "The request was cancelled." },
      499 as 400,
      privateHeaders,
    );
  log("error", "request failed", errorForLog(error));
  return context.json(
    {
      error: "internal_error",
      error_description: "The Git app could not complete the request. Retry later.",
    },
    500,
    privateHeaders,
  );
}
