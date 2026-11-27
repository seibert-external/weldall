/**
 * Git's credential helper protocol for the git route of a registry (`weldall git-credential get|
 * store|erase`). Git starts the helper per command and talks to it over stdin/stdout, so stdout
 * carries nothing but protocol lines and every message goes to stderr. The helper stores nothing:
 * `store` and `erase` are ignored, and a credential lives only in the git process that asked.
 *
 * Measured with Apple Git 2.39.3: `get` receives `protocol`, `host` and, with
 * `credential.useHttpPath=true`, `path` (no leading slash); unknown keys in the answer are
 * ignored. `quit=1` stops git at once without any prompt, whatever the environment.
 *
 * The helper answers only for `https://<origin>/git/<owner>/<repository>.git` below the git route
 * of a registry Weldall lists for the person in `GET /api/me/apps` (checked by the access, see
 * `weldall-access.ts`): the URL git asks about comes from the folder's config, which an agent can
 * write, and the credential must never reach another host. A resource's own metadata is never
 * read for this. Each run asks Weldall afresh (git starts the helper per request); nothing about
 * that decision is cached on disk.
 */
import { setTimeout as sleepFor } from "node:timers/promises";
import { isRecord } from "../http.js";
import { registryFailure } from "../publish/registry-api.js";
import { RegistryAccessError, type RegistryAnswer } from "./registries.js";
import { printable } from "./printable.js";

export type GitAccess = "read" | "write";

/**
 * Selects the access the helper requests. Git does not tell a helper whether it will push, so
 * the default is `read`; the publish step sets `write` for its push only.
 */
export const GIT_ACCESS_ENV = "WELDALL_GIT_ACCESS";

export interface GitCredentialRequest {
  /** `https://<host>` as git named it; the access answers only for a registry's origin. */
  origin: string;
  /** `git/<owner>/<repository>.git`, as git sends it. */
  path: string;
  access: GitAccess;
}

/**
 * How the helper gets a credential. The direct variant (`weldall-access.ts`) uses this device's
 * CLI login: it reads the registries Weldall lists and Weldall's resource registry, refuses an
 * origin or path that is not below a listed registry's git route (`RegistryAccessError` of kind
 * `not_registered`), obtains a downstream token for the registry and posts to the git credential
 * endpoint Weldall lists for it. A sandboxed agent gets a variant through the
 * sandbox door instead, which must do the same checks outside the sandbox; the protocol
 * code below stays unchanged.
 */
export interface GitCredentialAccess {
  /** Origin of the Weldall server whose login is used; null when none is configured. */
  issuer(): Promise<string | null>;
  /** Asks the registry for a git credential; throws `RegistryAccessError` when it cannot ask. */
  requestCredential(request: GitCredentialRequest): Promise<RegistryAnswer>;
}

interface Input {
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>;
}
interface Output {
  write(chunk: string): unknown;
}

const MAX_INPUT_BYTES = 64 * 1024;
const CREDENTIAL_PREFIX = "wgc_";
const LOGIN_HINT = "Run `weldall login`, then retry the git command.";

/** Reads git's `key=value` lines until a blank line or the end of input. */
export async function readCredentialInput(input: Input): Promise<string> {
  let text = "";
  for await (const chunk of input) {
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const end = text.search(/(^|\n)\n/);
    if (end !== -1) return text.slice(0, end);
    if (text.length > MAX_INPUT_BYTES) break;
  }
  return text;
}

/** Parses git's credential attributes; a repeated key keeps its last value. */
export function parseCredentialAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    attributes.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return attributes;
}

const hostName = /^[A-Za-z0-9._-]{1,100}$/;

/** Whether `path` is a registry's repository path (`git/<owner>/<repository>.git`). */
export function isGitProxyPath(path: string): boolean {
  const segments = (path.startsWith("/") ? path.slice(1) : path).split("/");
  if (segments.length !== 3 || segments[0] !== "git") return false;
  const [, owner = "", repository = ""] = segments;
  if (!repository.endsWith(".git")) return false;
  const name = repository.slice(0, -4);
  return (
    hostName.test(owner) &&
    hostName.test(name) &&
    ![owner, name].some((part) => part === "." || part === "..")
  );
}

/** The https origin of git's `host` attribute (with port when not 443), or null. */
export function originOfGitHost(gitHost: string): string | null {
  if (!/^[A-Za-z0-9.:[\]-]{1,300}$/.test(gitHost)) return null;
  try {
    const url = new URL(`https://${gitHost}`);
    return url.host.toLowerCase() === gitHost.toLowerCase().replace(/:443$/, "")
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** Server text for stderr: one bounded, printable line. */
const detail = (value: unknown): string | null => {
  if (!isRecord(value) || typeof value.error_description !== "string") return null;
  return printable(value.error_description.trim()) || null;
};

const errorCode = (value: unknown) =>
  isRecord(value) && typeof value.error === "string" ? value.error : null;

/** A readable reason for a failed answer; never contains a credential. */
export function describeRejection(answer: RegistryAnswer, origin: string): string {
  const { status, body } = answer;
  const code = errorCode(body);
  if (status === 401)
    return `The registry at ${origin} did not accept your Weldall login; it may have expired or been revoked. ${LOGIN_HINT}`;
  if ((status === 404 || status === 405) && code === null)
    return `${origin} does not issue git credentials: it is not a registry that publishes apps, or an older one. Ask your Weldall administrator.`;
  if (status === 404) {
    const reason = detail(body);
    return `No app of yours uses this repository: it belongs to someone else's app, or the app does not exist${reason ? ` (${reason})` : ""}.`;
  }
  const failure = registryFailure("Getting a git credential", answer);
  return failure.hint ? `${failure.message} ${failure.hint}` : failure.message;
}

/** A `Retry-After` up to this long makes the helper wait and ask once more; git waits meanwhile. */
export const CREDENTIAL_RETRY_WAIT_SECONDS = 10;

/**
 * Git reads credential lines without a length limit. A registry's credential carries its payload in
 * base64url and its verifier accepts a payload of at most 2,000 characters (about 200 in
 * practice; a user id near its 191-character maximum in multi-byte text gives about 1,500), so
 * 4,096 leaves room without passing on anything unbounded.
 */
export const MAX_CREDENTIAL_VALUE_CHARS = 4_096;
const protocolValue = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_CREDENTIAL_VALUE_CHARS &&
  !/[\0\r\n]/.test(value);

/** The credential lines for git, or null when the answer is not a usable credential. */
export function credentialLines(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const { username, password, expiresAt } = body;
  if (!protocolValue(username) || !protocolValue(password)) return null;
  if (!password.startsWith(CREDENTIAL_PREFIX)) return null;
  const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  return [
    `username=${username}`,
    `password=${password}`,
    // Known since Git 2.41; older versions ignore unknown keys.
    ...(Number.isFinite(expiry) ? [`password_expiry_utc=${Math.floor(expiry / 1000)}`] : []),
    "",
  ].join("\n");
}

function accessFrom(environment: NodeJS.ProcessEnv): GitAccess | null {
  const value = environment[GIT_ACCESS_ENV];
  if (value === undefined || value === "" || value === "read") return "read";
  return value === "write" ? "write" : null;
}

export interface GitCredentialHelperOptions {
  operation: string;
  input: Input;
  output: Output;
  errors: Output;
  environment: NodeJS.ProcessEnv;
  weldall: GitCredentialAccess;
  /** Waits before asking again after a short `Retry-After`; tests pass one that does not sleep. */
  sleep?: (milliseconds: number) => Promise<unknown>;
}

/**
 * Runs one helper invocation. For `get` it answers only for an https URL with a registry
 * repository path, and the access answers only when that URL's origin is a registry Weldall lists
 * for the person. For another URL shape it prints nothing, so git asks its other helpers; when the
 * credential cannot or must not be given (also for an origin that is no registry) it
 * prints `quit=1` so git stops without prompting, and says why on stderr. It never throws.
 */
export async function runGitCredentialHelper({
  operation,
  input,
  output,
  errors,
  environment,
  weldall,
  sleep = (milliseconds: number) => sleepFor(milliseconds),
}: GitCredentialHelperOptions): Promise<void> {
  const say = (message: string) => errors.write(`weldall git-credential: ${message}\n`);
  let text: string;
  try {
    text = await readCredentialInput(input);
  } catch {
    say("could not read the request from git.");
    return;
  }
  // `store` and `erase` are ignored: the helper keeps nothing. Unknown operations are ignored too.
  if (operation !== "get") return;

  const attributes = parseCredentialAttributes(text);
  if (attributes.get("protocol") !== "https") return;
  const origin = originOfGitHost(attributes.get("host") ?? "");
  if (!origin) return;

  // Checked before anything is asked, so other hosts' git commands stay offline and silent.
  const path = attributes.get("path");
  if (path === undefined) {
    say(
      "git did not send the repository path, so no credential is given. Set credential.useHttpPath=true for the registry's git URL.",
    );
    return;
  }
  if (!isGitProxyPath(path)) return;

  let issuer: string | null;
  try {
    issuer = await weldall.issuer();
  } catch (error) {
    say(`could not read the Weldall configuration: ${messageOf(error)}`);
    return;
  }
  if (!issuer) {
    say(
      "no Weldall server is configured, so no credential is given. Set WELDALL_ISSUER or run `weldall config set-issuer <https://host>`.",
    );
    return;
  }

  const quit = (message: string) => {
    output.write("quit=1\n");
    say(message);
  };
  const access = accessFrom(environment);
  if (!access) {
    quit(`${GIT_ACCESS_ENV} must be "read" or "write".`);
    return;
  }

  let answer: RegistryAnswer;
  try {
    answer = await weldall.requestCredential({ origin, path, access });
    // A rate limit with a short wait (`429`, or `503` while the Git host is busy): ask once more.
    if (
      (answer.status === 429 || answer.status === 503) &&
      answer.retryAfter !== null &&
      answer.retryAfter <= CREDENTIAL_RETRY_WAIT_SECONDS
    ) {
      await sleep(answer.retryAfter * 1000);
      answer = await weldall.requestCredential({ origin, path, access });
    }
  } catch (error) {
    quit(failureMessage(error, issuer, origin));
    return;
  }
  if (answer.status < 200 || answer.status > 299) {
    quit(describeRejection(answer, origin));
    return;
  }
  const lines = credentialLines(answer.body);
  if (!lines) {
    quit("The registry returned an invalid git credential.");
    return;
  }
  output.write(lines);
}

const messageOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "unexpected failure";

function failureMessage(error: unknown, issuer: string, origin: string): string {
  if (!(error instanceof RegistryAccessError))
    return `Getting a git credential failed: ${messageOf(error)}`;
  switch (error.kind) {
    case "login":
      return `You are not logged in to ${issuer}, or the login has expired (${error.message}). ${LOGIN_HINT}`;
    case "network":
      return `Could not reach Weldall (${issuer}) or the registry at ${origin}: ${error.message}`;
    case "timeout":
      return `Weldall (${issuer}) or the registry at ${origin} did not answer in time. Retry the git command.`;
    case "not_registered":
      return `${error.message} No credential is given for it.`;
    case "refused":
      return `Getting access to the registry at ${origin} failed: ${error.message}`;
    default:
      return `The Weldall configuration is not usable: ${error.message}`;
  }
}
