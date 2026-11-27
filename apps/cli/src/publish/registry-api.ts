import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { CliError, errorMessage } from "../errors.js";
import { printable } from "../git/printable.js";
import {
  RegistryAccessError,
  type FoundRegistries,
  type OpenRegistry,
  type Registry,
  type RegistryAnswer,
  type RegistryClient,
  type RegistryNeed,
  type RegistryRequest,
} from "../git/registries.js";
import { isRecord } from "../http.js";
import { PublishError } from "./errors.js";
import { CONFIG, isStateValue, isTreePath } from "./state.js";

/**
 * Creating an app waits on the registry until the Git host copied the template (up to 30 s) and
 * the reviewer team was checked; the CLI's usual 30 s would cut that off. A repeat after a
 * timeout continues the same creation.
 */
export const CREATE_APP_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** The checks call the Git host several times. */
export const CHECKLIST_TIMEOUT_MS = 90_000;
/** A `Retry-After` up to this long is waited for; a longer one is reported. */
export const MAX_RETRY_WAIT_SECONDS = 30;
/** One request plus at most two repeats. */
const MAX_ATTEMPTS = 3;

/** A full git object id (SHA-1 or SHA-256); git takes it as a revision, never as an option. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const warning = z.object({ code: z.string(), message: z.string() });
const identity = z.object({ name: z.string().min(1).max(200), email: z.string().min(3).max(320) });

/**
 * A pull request as the folder records it (`weldall.prNumber`, `weldall.prUrl`): checked when the
 * answer is read, so a registry's bad value is reported as its answer, never after the push as a
 * value the folder refuses to record.
 */
const pullRequestNumber = z
  .number()
  .int()
  .refine((value) => isStateValue(CONFIG.prNumber, String(value)));
const pullRequestUrl = z.string().refine((value) => isStateValue(CONFIG.prUrl, value));

export const APP_STATES = ["active", "expiring_soon", "expired"] as const;
export type AppState = (typeof APP_STATES)[number];

/** One app as its owner sees it (`GET /api/apps`, `GET /api/apps/{id}`). Dates are ISO 8601. */
const ownedApp = z.object({
  id: z.string().min(1).max(64),
  name: z.string(),
  description: z.string(),
  scopes: z.array(z.string()),
  url: z.string().nullable(),
  repository: z.object({ name: z.string(), url: z.string() }).nullable(),
  template: z.string().nullable(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  confirmedAt: z.string().nullable(),
  expiresAt: z.string(),
  state: z.enum(APP_STATES),
  removedAt: z.string().nullable(),
  removedReason: z.string().nullable(),
});
export type OwnedApp = z.output<typeof ownedApp>;
/** What administrators also see: owners and who did what, as Weldall user ids. */
const administeredApp = ownedApp.extend({
  owner: z.string().nullable(),
  ownerAssignedBy: z.string().nullable(),
  ownerAssignedAt: z.string().nullable(),
  confirmedBy: z.string().nullable(),
});
export type AdministeredApp = z.output<typeof administeredApp>;

const policy = {
  reverificationDays: z.number().int().positive(),
  expiringSoonDays: z.number().int().nonnegative(),
};
const appList = z.object({ apps: z.array(ownedApp), ...policy });
export type OwnedAppList = z.output<typeof appList>;
const adminAppList = z.object({
  apps: z.array(administeredApp),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  ...policy,
});
export type AdminAppList = z.output<typeof adminAppList>;
const oneApp = z.object({ app: ownedApp });
const oneAdministeredApp = z.object({ app: administeredApp });
const createdApp = z.object({ created: z.boolean(), app: ownedApp });
export type CreatedApp = z.output<typeof createdApp>;

const appStatus = z.object({
  app: z.object({ id: z.string(), name: z.string() }),
  pullRequest: z
    .object({
      number: pullRequestNumber,
      webUrl: pullRequestUrl,
      state: z.enum(["open", "merged", "closed"]),
      headBranch: z.string(),
      headCommit: z.string().regex(OBJECT_ID),
      // Written in the organisation's Git: the registry sanitises and bounds them; they stay data.
      reviews: z.array(
        z.object({
          author: z.string(),
          state: z.enum(["approved", "changes_requested", "commented", "dismissed"]),
          body: z.string(),
          submittedAt: z.string().nullable(),
        }),
      ),
      checks: z.array(
        z.object({
          name: z.string(),
          state: z.enum(["pending", "success", "failure", "neutral"]),
          detailsUrl: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  links: z.object({ preview: z.string().nullable(), live: z.string().nullable() }),
  publish: z.object({
    // Replaced by the repository's version before the merge: `.` or `..` would replace everything.
    protectedPaths: z.array(z.string().max(500).refine(isTreePath)).max(50),
    commitIdentity: identity.nullable(),
  }),
  warnings: z.array(warning).default([]),
});
export type AppStatus = z.output<typeof appStatus>;

const openedPullRequest = z.object({
  created: z.boolean(),
  pullRequest: z.object({
    number: pullRequestNumber,
    webUrl: pullRequestUrl,
    headBranch: z.string(),
  }),
  warnings: z.array(warning).default([]),
});
export type OpenedPullRequest = z.output<typeof openedPullRequest>;

const text = (maximum: number) => z.string().max(maximum);
const checklist = z.object({
  host: z.object({ kind: text(100), organization: text(200) }),
  repository: z.object({ owner: text(200), name: text(200) }).nullable(),
  checks: z
    .array(
      z.object({
        id: text(200),
        title: text(200),
        state: z.enum(["pass", "fail", "unverifiable"]),
        required: z.boolean(),
        reason: text(2_000),
        action: text(2_000).nullable(),
      }),
    )
    .max(200),
  summary: z.object({
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    unverifiable: z.number().int().nonnegative(),
  }),
});
export type ChecklistAnswer = z.output<typeof checklist>;

/** An app id as the registry writes them (`app_` and hex digits); never a path. */
export const isAppId = (value: string) => /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** What a person asks for when creating an app (`POST /api/apps`). */
export interface CreateAppInput {
  template: string;
  name: string;
  description: string;
  scopes?: string[];
  url?: string;
}

/** Filters of the administrators' list (`GET /api/admin/apps`). */
export interface AdminListQuery {
  page?: number;
  pageSize?: number;
  state?: AppState;
  ownerless?: boolean;
}

/** The calls of one registry the commands need; tests provide one without DPoP. */
export interface RegistryApi {
  /** The registry as Weldall lists it. */
  readonly registry: Registry;
  createApp(input: CreateAppInput): Promise<CreatedApp>;
  readStatus(appId: string, branch?: string): Promise<AppStatus>;
  openPullRequest(
    appId: string,
    input: { head: string; title: string; body: string },
  ): Promise<OpenedPullRequest>;
  /** The administrator's set-up checklist; `appId` names an app for the repository checks. */
  readChecklist(appId?: string): Promise<ChecklistAnswer>;
  /** The person's own apps with their review state. */
  listApps(): Promise<OwnedAppList>;
  /** One of the person's apps. */
  readApp(appId: string): Promise<OwnedApp>;
  /** Confirms that one of the person's apps is still needed; the registry moves its review date. */
  confirmApp(appId: string): Promise<OwnedApp>;
  /** Administrators: every app, one page. */
  listAllApps(query?: AdminListQuery): Promise<AdminAppList>;
  /** Administrators: assigns or changes an app's owner (a Weldall user id). */
  assignOwner(appId: string, owner: string): Promise<AdministeredApp>;
}

const LOGIN_HINT = "Run `weldall login`, then try again.";
const ADMIN_HINT = "Tell your Weldall administrator; `weldall app checklist` shows what to fix.";
const REPEAT_HINT = "Run the same command again; it continues where it stopped.";

/** What a registry error means for the person, by its code. `{reason}` is the registry's text. */
interface Explanation {
  message: string;
  hint?: string;
}

/**
 * Every error the registry documents, worded for a person without a Git account. Codes stay as
 * the registry sends them, so an agent can branch on `error.code`.
 */
const EXPLANATIONS: Record<string, Explanation> = {
  invalid_request: {
    message: "the registry did not accept the request",
    hint: "Check the values you gave, for example the app's name, description and link.",
  },
  invalid_name: {
    message:
      "the app's name needs at least one Latin letter or digit, because its repository is named after it",
    hint: "Choose another --name.",
  },
  unknown_template: {
    message: "the registry has no template of that name",
    hint: "Use the template the app's folder was made from; your Weldall administrator knows which templates exist.",
  },
  access_denied: { message: "the registry refused the request", hint: LOGIN_HINT },
  scope_not_held: {
    message: "you do not hold a permission this needs, or one you want to share the app with",
    hint: "Share only with permissions you hold (`weldall scopes` lists them), or ask your Weldall administrator.",
  },
  scope_not_checkable: {
    message: "the registry cannot check one of the permissions you want to share the app with",
    hint: "Share with another permission, or ask your Weldall administrator to let the registry check it.",
  },
  not_found: {
    message: "no app of yours has this id",
    hint: "`weldall app list` shows your apps and their ids.",
  },
  app_exists: {
    message:
      "an app with this name already exists (names that differ only in case, accents or punctuation count as the same)",
    hint: "Choose another --name. If the app is yours from an earlier attempt, repeat that attempt with the same template.",
  },
  repository_exists: {
    message:
      "a repository with this app's name already exists in your organisation's Git, and this app did not make it",
    hint: "Choose another --name, or ask your Weldall administrator to make you the owner of the existing app.",
  },
  repository_gone: {
    message: "the repository made for this app is gone from your organisation's Git",
    hint: "Run the same command again; it starts over with a new repository.",
  },
  repository_unconfirmed: {
    message:
      "the registry cannot yet confirm that the new repository belongs to this app; nothing is lost",
    hint: REPEAT_HINT,
  },
  repository_not_ready: {
    message: "your organisation's Git is still preparing the app's repository",
    hint: REPEAT_HINT,
  },
  repository_not_private: {
    message:
      "the registry made the app's repository, but it is not private, so the registry stopped; an administrator must look at it",
    hint: "Tell your Weldall administrator.",
  },
  template_unavailable: {
    message: "the template is not available to the registry right now",
    hint: ADMIN_HINT,
  },
  app_limit_reached: {
    message: "the registry holds as many apps as it can",
    hint: "Tell your Weldall administrator; once there is room, run the same command again.",
  },
  app_changed: {
    message: "the app changed at the same time",
    hint: "Run the same command again.",
  },
  owner_not_allowed: {
    message: "that person cannot own the app",
    hint: "Use the person's Weldall user id (they see it with `weldall whoami --json`), and give them the permission to publish apps in Weldall first.",
  },
  publishing_not_configured: {
    message: "this registry does not create apps or publish changes yet",
    hint: "Ask your Weldall administrator to set up publishing apps.",
  },
  not_auditable: { message: "this change cannot be recorded in Weldall's audit log" },
  creation_limit_reached: {
    message: "you have five apps whose creation is not finished yet",
    hint: "Finish one of them first: run the command you started it with again. If one waits for an administrator, tell them.",
  },
  reviewer_team_access_missing: {
    message:
      "the app's repository exists, but the team that reviews changes has no write access to it yet; an administrator must give it access",
    hint: "Tell your Weldall administrator. Once it is fixed, run the same command again to finish.",
  },
  reviewer_team_unverifiable: {
    message:
      "the registry could not check yet whether the team that reviews changes may review this app",
    hint: "Tell your Weldall administrator (`weldall app checklist`). Once it is fixed, run the same command again to finish.",
  },
  not_publishable: {
    message: "this app has no repository that changes can be published to",
  },
  app_removed: {
    message:
      "this app's repository is archived, disabled or out of the registry's reach, so it takes no changes",
    hint: "Tell your Weldall administrator.",
  },
  invalid_target: {
    message: "this app's repository is not in the organisation the registry publishes to",
    hint: "Tell your Weldall administrator.",
  },
  repository_moved: {
    message: "this app's repository was renamed or replaced, so the registry no longer finds it",
    hint: "Wait a few minutes until the registry notices, then try again; otherwise tell your Weldall administrator.",
  },
  branch_not_found: { message: "the publish branch is missing in the app's repository" },
  nothing_to_publish: { message: "the publish branch has no changes compared with the app" },
  rate_limit: { message: "too many requests in a short time" },
  git_host_rate_limited: { message: "your organisation's Git is busy for the moment" },
  audit_unavailable: {
    message: "Weldall's audit log is unavailable, so nothing was changed",
    hint: "Try again later.",
  },
  weldall_unavailable: {
    message: "the registry could not reach Weldall to check your permissions",
    hint: "Try again later.",
  },
  weldall_refused: {
    message: "Weldall refused the registry's permission check",
    hint: "Tell your Weldall administrator.",
  },
  registry_unavailable: {
    message: "the registry's storage is unavailable",
    hint: "Try again later; for a new app, run the same command again.",
  },
  upstream_unavailable: {
    message: "your organisation's Git cannot be reached right now",
    hint: "Try again later.",
  },
  request_too_large: { message: "the request is too large for the registry" },
  internal_error: { message: "the registry failed", hint: "Try again later." },
};

/** Codes after which repeating the same request is safe and often succeeds. */
const REPEATABLE = new Set([
  "app_changed",
  "repository_unconfirmed",
  "repository_not_ready",
  "registry_unavailable",
  "upstream_unavailable",
]);

const errorFields = (body: unknown) => {
  const record = isRecord(body) ? body : {};
  return {
    code: typeof record.error === "string" ? printable(record.error, 100) : null,
    description:
      typeof record.error_description === "string"
        ? printable(record.error_description.trim(), 1_000)
        : null,
  };
};

/** Waiting in words: "about 20 seconds", "about 3 minutes". */
const waitText = (seconds: number) =>
  seconds < 90
    ? `about ${Math.max(1, seconds)} second${seconds === 1 ? "" : "s"}`
    : `about ${Math.ceil(seconds / 60)} minutes`;

/**
 * Turns a failed answer into a `PublishError` whose code is the registry's and whose message a
 * person can act on; `label` says what was being done. A missing route (404/405 without an error
 * body) is `registry_unsupported`.
 */
export function registryFailure(label: string, answer: RegistryAnswer): PublishError {
  const { code, description } = errorFields(answer.body);
  const status = answer.status;
  if ((status === 404 || status === 405) && code === null)
    return new PublishError(
      "registry_unsupported",
      `${label}: the registry does not offer this (it may be an older version).`,
      { hint: "Ask your Weldall administrator to update the registry." },
    );
  if (status === 401)
    return new PublishError("login", `${label}: your Weldall login has expired.`, {
      hint: LOGIN_HINT,
    });
  const details: Record<string, string> = { status: String(status) };
  if (answer.retryAfter !== null) details.retryAfter = String(answer.retryAfter);
  const known = code === null ? undefined : EXPLANATIONS[code];
  const reason = description && description !== known?.message ? ` (${description})` : "";
  const wait =
    answer.retryAfter !== null && (status === 429 || status === 503)
      ? `Wait ${waitText(answer.retryAfter)}, then try again.`
      : undefined;
  if (known) {
    const hint = wait ?? known.hint;
    return new PublishError(code!, `${label}: ${known.message}${reason}.`, {
      ...(hint ? { hint } : {}),
      details,
    });
  }
  if (status === 502)
    return new PublishError(
      code ?? "git_host_refused",
      `${label}: your organisation's Git refused the registry${reason}.`,
      { hint: ADMIN_HINT, details },
    );
  const text = `${label} failed (HTTP ${status})${description ? `: ${description}` : ""}`;
  return new PublishError(code ?? `http_${status}`, /[.!?]$/.test(text) ? text : `${text}.`, {
    ...(wait ? { hint: wait } : {}),
    details,
  });
}

/** Parses a successful answer with `schema`; anything else is a `PublishError`. */
export function parseAnswer<T>(schema: z.ZodType<T>, label: string, answer: RegistryAnswer): T {
  if (answer.status < 200 || answer.status > 299) throw registryFailure(label, answer);
  const parsed = schema.safeParse(answer.body);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.map(String).join(".");
    throw new PublishError(
      "registry_unsupported",
      `${label}: the registry returned an unexpected answer${field ? ` (${printable(field, 200)})` : ""}.`,
      { hint: "Ask your Weldall administrator to update or check the registry." },
    );
  }
  return parsed.data;
}

/** Maps a failure to open a registry (login, network, refused token) to a stable code. */
export function openFailure(error: unknown, action = "try again"): unknown {
  if (!(error instanceof RegistryAccessError)) return error;
  if (error.kind === "login")
    return new PublishError(
      "login",
      `You are not logged in to Weldall, or the login has expired (${error.message}).`,
      { cause: error, hint: `Run \`weldall login\`, then ${action}.` },
    );
  if (error.kind === "network")
    return new PublishError(
      "network",
      `Could not reach Weldall or the registry (${error.message}).`,
      {
        cause: error,
      },
    );
  if (error.kind === "timeout")
    return new PublishError("timeout", "Weldall or the registry did not answer in time.", {
      cause: error,
      hint: REPEAT_HINT,
    });
  return new PublishError(
    "registry_access",
    `Getting access to the registry failed: ${error.message}`,
    {
      cause: error,
      ...(error.hint ? { hint: error.hint } : {}),
    },
  );
}

/** How long to wait before repeating `answer`, or null when it must not be repeated. */
export function repeatDelaySeconds(answer: RegistryAnswer, resumable: boolean): number | null {
  const { status } = answer;
  const { code } = errorFields(answer.body);
  if ((status === 429 || status === 503) && answer.retryAfter !== null)
    return answer.retryAfter <= MAX_RETRY_WAIT_SECONDS ? answer.retryAfter : null;
  if (code === "app_changed") return 1;
  // A resumable request (creating an app) is meant to be repeated after these.
  if (resumable && (status === 503 || status === 504) && code !== null && REPEATABLE.has(code))
    return 2;
  return null;
}

export interface RegistryApiOptions {
  /** Waits between repeats; tests pass one that does not sleep. */
  sleep?: (milliseconds: number) => Promise<unknown>;
}

/** Opens the registry `choose` picks and returns its calls. */
export async function openRegistryApi(
  open: OpenRegistry,
  choose: (found: FoundRegistries) => Registry,
  need: RegistryNeed = "changes",
  options: RegistryApiOptions = {},
): Promise<RegistryApi> {
  try {
    return createRegistryApi(await open(choose, need), options);
  } catch (error) {
    throw openFailure(error);
  }
}

/**
 * The registry's calls over one client. Every call here is safe to repeat (creating an app is
 * resumable, opening a pull request answers the open one, confirming and assigning set a state),
 * so a rate limit with a short `Retry-After` is waited for and the request repeated, at most twice.
 * The direct client also repeats a request once with a fresh downstream token after a 401
 * (`directOpenRegistry`); a 401 after that is reported as an expired login.
 */
export function createRegistryApi(
  client: RegistryClient,
  options: RegistryApiOptions = {},
): RegistryApi {
  const { registry } = client;
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const ask = async (label: string, request: RegistryRequest, resumable = false) => {
    for (let attempt = 1; ; attempt += 1) {
      let answer: RegistryAnswer;
      try {
        answer = await client.send(request);
      } catch (error) {
        const timedOut =
          error instanceof RegistryAccessError
            ? error.kind === "timeout"
            : error instanceof Error && error.name === "TimeoutError";
        if (timedOut)
          throw new PublishError("timeout", `${label}: the registry did not answer in time.`, {
            cause: error,
            hint: REPEAT_HINT,
          });
        if (error instanceof RegistryAccessError) throw openFailure(error);
        if (error instanceof CliError) throw error;
        throw new PublishError(
          "network",
          `${label}: could not reach ${registry.origin} (${errorMessage(error)}).`,
          { cause: error },
        );
      }
      const wait = attempt < MAX_ATTEMPTS ? repeatDelaySeconds(answer, resumable) : null;
      if (wait === null) return answer;
      await sleep(wait * 1000);
    }
  };
  const call = async <T>(
    schema: z.ZodType<T>,
    label: string,
    request: Omit<RegistryRequest, "url"> & { path: string },
    resumable = false,
  ) => {
    const { path, ...rest } = request;
    return parseAnswer(
      schema,
      label,
      await ask(label, { ...rest, url: new URL(path, registry.api).href }, resumable),
    );
  };
  const app = (id: string) => {
    if (!isAppId(id))
      throw new PublishError("invalid_app_id", `"${printable(id, 100)}" is not an app id.`, {
        hint: "`weldall app list` shows your apps and their ids.",
      });
    return `apps/${id}`;
  };
  return {
    registry,
    createApp: (input) =>
      call(
        createdApp,
        "Creating the app",
        { method: "POST", path: "apps", body: input, timeoutMs: CREATE_APP_TIMEOUT_MS },
        true,
      ),
    readStatus: (appId, branch) =>
      call(appStatus, "Reading the app's status", {
        method: "GET",
        path: `${app(appId)}/status${branch === undefined ? "" : `?branch=${encodeURIComponent(branch)}`}`,
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
    openPullRequest: (appId, input) =>
      call(openedPullRequest, "Opening the pull request", {
        method: "POST",
        path: `${app(appId)}/pull-requests`,
        body: input,
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
    readChecklist: (appId) =>
      call(checklist, "Running the set-up checklist", {
        method: "GET",
        path: `admin/checklist${appId === undefined ? "" : `?app=${encodeURIComponent(appId)}`}`,
        timeoutMs: CHECKLIST_TIMEOUT_MS,
      }),
    listApps: () =>
      call(appList, "Listing your apps", {
        method: "GET",
        path: "apps",
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
    readApp: async (appId) =>
      (
        await call(oneApp, "Reading the app", {
          method: "GET",
          path: app(appId),
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
      ).app,
    confirmApp: async (appId) =>
      (
        await call(oneApp, "Confirming the app", {
          method: "POST",
          path: `${app(appId)}/confirm`,
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
      ).app,
    listAllApps: (query = {}) => {
      const parameters = new URLSearchParams();
      if (query.page !== undefined) parameters.set("page", String(query.page));
      if (query.pageSize !== undefined) parameters.set("pageSize", String(query.pageSize));
      if (query.state !== undefined) parameters.set("state", query.state);
      if (query.ownerless) parameters.set("owner", "none");
      const search = parameters.size ? `?${parameters}` : "";
      return call(adminAppList, "Listing all apps", {
        method: "GET",
        path: `admin/apps${search}`,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    },
    assignOwner: async (appId, owner) =>
      (
        await call(oneAdministeredApp, "Assigning the app's owner", {
          method: "PUT",
          path: `admin/${app(appId)}/owner`,
          body: { owner },
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
      ).app,
  };
}
