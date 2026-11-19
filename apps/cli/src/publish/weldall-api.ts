import { createDpopProof } from "@weldall/sdk";
import { z } from "zod";
import type { WeldallConfig } from "../config.js";
import { CliError, errorMessage } from "../errors.js";
import { responseValue } from "../http.js";
import { withAccess } from "../services/auth.js";
import { PublishError } from "./errors.js";

/**
 * The calls that stay in Weldall: the person's entries in the app registry (`GET /api/me/apps`)
 * and their confirmation. Creating apps, pull requests, status and git credentials go to the Git
 * app that keeps the repository (`git-app-api.ts`).
 */
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

export const APP_STATES = ["active", "expiring_soon", "expired"] as const;
const appEntry = z.object({
  id: z.string().min(1).max(64),
  name: z.string(),
  purpose: z.string(),
  repository: z.object({
    /** Null for an app whose repository is kept by a Git app registered as a resource. */
    connector: z.string().nullable(),
    /** Resource key of the Git app that keeps the repository; null for a connector app. */
    resource: z.string().nullable().default(null),
    owner: z.string(),
    name: z.string(),
    webUrl: z.string().nullable(),
  }),
  template: z.string().nullable(),
  links: z.object({ preview: z.string().nullable(), live: z.string().nullable() }),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
  expiresAt: z.string(),
  state: z.enum(APP_STATES),
});
export type AppEntry = z.output<typeof appEntry>;
const appList = z.object({
  apps: z.array(appEntry),
  reverificationDays: z.number().int().positive(),
  expiringSoonDays: z.number().int().nonnegative(),
});
export type AppList = z.output<typeof appList>;
const confirmedApp = z.object({ app: appEntry });

/** The app registry calls in Weldall; tests provide one without DPoP. */
export interface RegistryApi {
  /** Origin of the Weldall server the CLI talks to. */
  readonly issuer: string;
  /** The caller's apps from the app registry with their re-verification state. */
  listApps(): Promise<AppList>;
  /** Confirms that one of the caller's apps is still needed; the server moves its expiry. */
  confirmApp(appId: string): Promise<AppEntry>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const REGISTRY_UPDATE_HINT =
  "Ask your Weldall administrator to update the server; this CLI needs a Weldall server with the app registry.";

/** Turns a failed answer into a `PublishError`; `unsupported` describes a missing route. */
export function answerFailure(
  label: string,
  answer: WeldallAnswer,
  unsupported: { code: string; message: string; hint: string },
  loginHint = "Run `weldall login`, then publish again.",
): PublishError {
  const body = isRecord(answer.body) ? answer.body : {};
  const code = typeof body.error === "string" ? body.error : null;
  const description =
    typeof body.error_description === "string"
      ? body.error_description.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 500)
      : null;
  // An older server answers unknown routes without an OAuth error body.
  if ((answer.status === 404 || answer.status === 405) && code === null)
    return new PublishError(unsupported.code, `${label}: ${unsupported.message}`, {
      hint: unsupported.hint,
    });
  if (answer.status === 401)
    return new PublishError("login", `${label}: your Weldall login has expired.`, {
      hint: loginHint,
    });
  return new PublishError(
    code ?? `http_${answer.status}`,
    `${label} failed (HTTP ${answer.status})${description ? `: ${description}` : ""}`,
  );
}

/** Parses a successful answer with `schema`; anything else is a `PublishError`. */
export function parseAnswer<T>(
  schema: z.ZodType<T>,
  label: string,
  answer: WeldallAnswer,
  unsupported: { code: string; message: string; hint: string },
  source = "Weldall",
): T {
  if (answer.status < 200 || answer.status > 299) throw answerFailure(label, answer, unsupported);
  const parsed = schema.safeParse(answer.body);
  if (!parsed.success)
    throw new PublishError(unsupported.code, `${label}: ${source} returned an unexpected answer.`, {
      hint: unsupported.hint,
    });
  return parsed.data;
}

/** A server without `GET /api/me/apps` or the confirm route predates the app registry. */
const withoutRegistry = {
  code: "server_unsupported",
  message: "this Weldall server has no app registry.",
  hint: REGISTRY_UPDATE_HINT,
};

/** The registry calls over any transport; the direct one below signs with the CLI login. */
export function createRegistryApi(issuer: string, send: WeldallSend): RegistryApi {
  const ask = async (label: string, request: Parameters<WeldallSend>[0]) => {
    try {
      return await send(request);
    } catch (error) {
      if (error instanceof CliError) throw error;
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new PublishError(
        timedOut ? "timeout" : "network",
        timedOut
          ? `${label}: Weldall did not answer in time.`
          : `${label}: could not reach ${issuer} (${errorMessage(error)}).`,
        { cause: error },
      );
    }
  };
  return {
    issuer,
    async listApps() {
      const label = "Listing your apps";
      return parseAnswer(
        appList,
        label,
        await ask(label, { method: "GET", path: "apps", timeoutMs: REQUEST_TIMEOUT_MS }),
        withoutRegistry,
      );
    },
    async confirmApp(appId) {
      const label = "Confirming the app";
      return parseAnswer(
        confirmedApp,
        label,
        await ask(label, {
          method: "POST",
          path: `apps/${encodeURIComponent(appId)}/confirm`,
          timeoutMs: REQUEST_TIMEOUT_MS,
        }),
        withoutRegistry,
      ).app;
    },
  };
}

/** Signs each request with this device's CLI login (DPoP), like every other `/api/me` call. */
export function directRegistryApi(config: WeldallConfig): RegistryApi {
  return createRegistryApi(config.issuer, async ({ method, path, body, timeoutMs }) => {
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
