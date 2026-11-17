import { createDpopProof } from "@weldall/sdk";
import { z } from "zod";
import type { WeldallConfig } from "../config.js";
import { CliError, errorMessage } from "../errors.js";
import { responseValue } from "../http.js";
import { withAccess } from "../services/auth.js";
import { PublishError } from "./errors.js";

/**
 * Creating the repository waits on the server until the Git host has copied the template
 * (up to 30 s) and checked the prerequisites; the CLI's usual 30 s would cut that off. A retry
 * after a timeout resumes the same repository.
 */
export const CREATE_APP_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface WeldallAnswer {
  status: number;
  body: unknown;
}

/** Sends one request to `/api/me/<path>` and returns status and parsed body; throws only when it cannot ask. */
export type WeldallSend = (request: {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  timeoutMs: number;
}) => Promise<WeldallAnswer>;

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

/** The server calls a publish needs; tests provide one without DPoP. */
export interface PublishApi {
  /** Origin of the Weldall server the CLI talks to (and the git credential helper answers for). */
  readonly issuer: string;
  createApp(input: {
    connector?: string;
    template: string;
    name: string;
    purpose: string;
  }): Promise<CreatedApp>;
  readStatus(appId: string, branch?: string): Promise<AppStatus>;
  openPullRequest(
    appId: string,
    input: { head: string; title: string; body: string },
  ): Promise<OpenedPullRequest>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const UPDATE_HINT =
  "Ask your Weldall administrator to update the server; this CLI needs a Weldall server that supports publishing apps.";

function failure(label: string, answer: WeldallAnswer): PublishError {
  const body = isRecord(answer.body) ? answer.body : {};
  const code = typeof body.error === "string" ? body.error : null;
  const description =
    typeof body.error_description === "string"
      ? body.error_description.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 500)
      : null;
  // An older server answers unknown routes without a Weldall error body.
  if ((answer.status === 404 || answer.status === 405) && code === null)
    return new PublishError(
      "server_unsupported",
      `${label}: this Weldall server cannot publish apps.`,
      {
        hint: UPDATE_HINT,
      },
    );
  if (answer.status === 401)
    return new PublishError("login", `${label}: your Weldall login has expired.`, {
      hint: "Run `weldall login`, then publish again.",
    });
  return new PublishError(
    code ?? `http_${answer.status}`,
    `${label} failed (HTTP ${answer.status})${description ? `: ${description}` : ""}`,
  );
}

function parse<T>(schema: z.ZodType<T>, label: string, answer: WeldallAnswer): T {
  if (answer.status < 200 || answer.status > 299) throw failure(label, answer);
  const parsed = schema.safeParse(answer.body);
  if (!parsed.success)
    throw new PublishError(
      "server_unsupported",
      `${label}: Weldall returned an unexpected answer.`,
      {
        hint: UPDATE_HINT,
      },
    );
  return parsed.data;
}

/** The publish calls over any transport; the direct one below signs with the CLI login. */
export function createPublishApi(issuer: string, send: WeldallSend): PublishApi {
  const ask = async (label: string, request: Parameters<WeldallSend>[0]) => {
    try {
      return await send(request);
    } catch (error) {
      if (error instanceof CliError) throw error;
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new PublishError(
        timedOut ? "timeout" : "network",
        timedOut
          ? `${label}: Weldall did not answer in time. Run publish again; it continues where it stopped.`
          : `${label}: could not reach ${issuer} (${errorMessage(error)}).`,
        { cause: error },
      );
    }
  };
  const app = (id: string) => `apps/${encodeURIComponent(id)}`;
  return {
    issuer,
    async createApp(input) {
      const label = "Creating the app's repository";
      return parse(
        createdApp,
        label,
        await ask(label, {
          method: "POST",
          path: "apps",
          body: input,
          timeoutMs: CREATE_APP_TIMEOUT_MS,
        }),
      );
    },
    async readStatus(appId, branch) {
      const label = "Reading the app's status";
      const query = branch === undefined ? "" : `?branch=${encodeURIComponent(branch)}`;
      return parse(
        appStatus,
        label,
        await ask(label, {
          method: "GET",
          path: `${app(appId)}/status${query}`,
          timeoutMs: REQUEST_TIMEOUT_MS,
        }),
      );
    },
    async openPullRequest(appId, input) {
      const label = "Opening the pull request";
      return parse(
        openedPullRequest,
        label,
        await ask(label, {
          method: "POST",
          path: `${app(appId)}/pull-requests`,
          body: input,
          timeoutMs: REQUEST_TIMEOUT_MS,
        }),
      );
    },
  };
}

/** Signs each request with this device's CLI login (DPoP), like every other `/api/me` call. */
export function directPublishApi(config: WeldallConfig): PublishApi {
  return createPublishApi(config.issuer, async ({ method, path, body, timeoutMs }) => {
    const url = `${config.issuer}/api/me/${path}`;
    return withAccess(config, async (session) => {
      const response = await fetch(url, {
        method,
        headers: {
          accept: "application/json",
          authorization: `DPoP ${session.accessToken}`,
          dpop: await createDpopProof({
            ...session.credentials,
            method,
            url,
            accessToken: session.accessToken,
          }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: response.status, body: await responseValue(response) };
    });
  });
}
