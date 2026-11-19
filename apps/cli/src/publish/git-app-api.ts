import { z } from "zod";
import { CliError, errorMessage } from "../errors.js";
import {
  GIT_APP_SCOPES,
  GitAppAccessError,
  type GitApp,
  type GitAppClient,
  type GitAppRequest,
  type OpenGitApp,
} from "../git/git-apps.js";
import { PublishError } from "./errors.js";
import { parseAnswer } from "./weldall-api.js";
import type { ResourceRegistryEntry } from "@weldall/sdk";

/**
 * Creating the repository waits on the Git app until the Git host has copied the template
 * (up to 30 s) and checked the prerequisites; the CLI's usual 30 s would cut that off. A retry
 * after a timeout resumes the same repository.
 */
export const CREATE_APP_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** The checks call the Git host several times; the Git app bounds each call to 15 s. */
export const CHECKLIST_TIMEOUT_MS = 90_000;

const warning = z.object({ code: z.string(), message: z.string() });
const identity = z.object({ name: z.string().min(1).max(200), email: z.string().min(3).max(320) });

const createdApp = z.object({
  created: z.boolean(),
  app: z.object({ id: z.string().min(1).max(64), name: z.string() }),
  repository: z.object({ webUrl: z.string(), defaultBranch: z.string().min(1).max(255) }),
  git: z.object({ remoteUrl: z.string() }),
  warnings: z.array(warning).default([]),
});
export type CreatedApp = z.output<typeof createdApp>;

const appStatus = z.object({
  app: z.object({ id: z.string(), name: z.string() }),
  pullRequest: z
    .object({
      number: z.number().int(),
      webUrl: z.string(),
      state: z.enum(["open", "merged", "closed"]),
      headBranch: z.string(),
      headCommit: z.string(),
      // Written in the customer's Git: the server sanitises and bounds them; they stay data.
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
    protectedPaths: z.array(z.string().min(1).max(500)).max(50),
    commitIdentity: identity.nullable(),
  }),
  warnings: z.array(warning).default([]),
});
export type AppStatus = z.output<typeof appStatus>;

const openedPullRequest = z.object({
  created: z.boolean(),
  pullRequest: z.object({ number: z.number().int(), webUrl: z.string(), headBranch: z.string() }),
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

/** The calls of one Git app a publish needs; tests provide one without DPoP. */
export interface GitAppApi {
  /** The Git app as Weldall's registry lists it; its origin is the only one git may reach. */
  readonly gitApp: GitApp;
  createApp(input: { template: string; name: string; purpose: string }): Promise<CreatedApp>;
  readStatus(appId: string, branch?: string): Promise<AppStatus>;
  openPullRequest(
    appId: string,
    input: { head: string; title: string; body: string },
  ): Promise<OpenedPullRequest>;
  /** The administrator's set-up checklist; `appId` names a ready app for the repository checks. */
  readChecklist(appId?: string): Promise<ChecklistAnswer>;
}

/** Maps a failure to open a Git app (login, network, refused token) to a stable publish code. */
export function openFailure(error: unknown, action = "publish again"): unknown {
  if (!(error instanceof GitAppAccessError)) return error;
  if (error.kind === "login")
    return new PublishError(
      "login",
      `You are not logged in to Weldall, or the login has expired (${error.message}).`,
      {
        cause: error,
        hint: `Run \`weldall login\`, then ${action}.`,
      },
    );
  if (error.kind === "network")
    return new PublishError(
      "network",
      `Could not reach Weldall or the Git app (${error.message}).`,
      {
        cause: error,
      },
    );
  return new PublishError(
    "git_app_access",
    `Getting access to the Git app failed: ${error.message}`,
    {
      cause: error,
      ...(error.hint ? { hint: error.hint } : {}),
    },
  );
}

/** Opens the Git app `choose` picks and returns its publish calls. */
export async function openGitAppApi(
  open: OpenGitApp,
  choose: (resources: ResourceRegistryEntry[]) => GitApp,
  scope: (typeof GIT_APP_SCOPES)[keyof typeof GIT_APP_SCOPES] = GIT_APP_SCOPES.publish,
): Promise<GitAppApi> {
  try {
    return createGitAppApi(await open(choose, scope));
  } catch (error) {
    throw openFailure(
      error,
      scope === GIT_APP_SCOPES.admin ? "run the checklist again" : "publish again",
    );
  }
}

/** The Git app's publish calls over one client. */
export function createGitAppApi(client: GitAppClient): GitAppApi {
  const { gitApp } = client;
  const unsupported = {
    code: "git_app_unsupported",
    message: `the Git app ${gitApp.name} at ${gitApp.origin} does not offer this (it may be an older version).`,
    hint: "Ask your Weldall administrator to update the Git app.",
  };
  const ask = async (label: string, request: GitAppRequest) => {
    try {
      return await client.send(request);
    } catch (error) {
      if (error instanceof GitAppAccessError) throw openFailure(error);
      if (error instanceof CliError) throw error;
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new PublishError(
        timedOut ? "timeout" : "network",
        timedOut
          ? `${label}: the Git app did not answer in time. Run publish again; it continues where it stopped.`
          : `${label}: could not reach ${gitApp.origin} (${errorMessage(error)}).`,
        { cause: error },
      );
    }
  };
  const call = async <T>(schema: z.ZodType<T>, label: string, request: GitAppRequest) =>
    parseAnswer(schema, label, await ask(label, request), unsupported, "The Git app");
  const app = (id: string) => `apps/${encodeURIComponent(id)}`;
  return {
    gitApp,
    createApp: (input) =>
      call(createdApp, "Creating the app's repository", {
        method: "POST",
        path: "apps",
        body: input,
        timeoutMs: CREATE_APP_TIMEOUT_MS,
      }),
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
  };
}
