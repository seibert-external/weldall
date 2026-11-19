import type { ResourceRegistryEntry } from "@weldall/sdk";
import { CliError } from "../errors.js";
import { PublishError } from "../publish/errors.js";

/**
 * Git apps: the separate services an organisation registers in Weldall as resources to keep
 * people's app repositories on a Git host (seibert-external/weldall-git-app), one per host. The CLI talks to a Git
 * app like to any registered resource (token exchange at Weldall, downstream token at the Git
 * app, DPoP requests below `<origin>/api/`), and git reaches it at `<origin>/git/`.
 *
 * Trust: the project folder, including `.git/config` and the stored `weldall.*` values, can be
 * written by an agent, while the CLI runs with the person's login. So every origin the CLI sends
 * a token or a git credential to comes from Weldall's resource registry for this person, never
 * from the folder: the folder may only choose among registered Git apps, and a git address it
 * stores must lie below the chosen Git app's `/git/`.
 *
 * Recognition: Weldall's registry does not say which resource is a Git app. A Git app is a
 * registered resource that supports {@link GIT_APP_SCOPES}`.publish` (the Git app's default
 * scope names) and whose authorization server is a bare https origin, which the Git app uses as
 * its public origin. An instance registered with other scope names is not found.
 */
export const GIT_APP_SCOPES = { publish: "git-app:publish", admin: "git-app:admin" } as const;
export type GitAppScope = (typeof GIT_APP_SCOPES)[keyof typeof GIT_APP_SCOPES];

export interface GitApp {
  /** Resource key in Weldall; what `--git-app` names and the folder records. */
  key: string;
  name: string;
  /** The Git app's https origin: its API is below `<origin>/api/`, git below `<origin>/git/`. */
  origin: string;
  /** The registry entry as Weldall listed it. */
  resource: ResourceRegistryEntry;
}

/** Answer of a Git app request: the HTTP status and the parsed body (JSON, text, or null). */
export interface GitAppAnswer {
  status: number;
  body: unknown;
}

export interface GitAppRequest {
  method: "GET" | "POST";
  /** Below `<origin>/api/`, e.g. `apps/<id>/status`. */
  path: string;
  body?: unknown;
  timeoutMs: number;
}

/** One Git app with a downstream token for one scope. */
export interface GitAppClient {
  readonly gitApp: GitApp;
  /** Sends one request; throws only when it cannot ask. */
  send(request: GitAppRequest): Promise<GitAppAnswer>;
}

/**
 * Opens a client for the Git app `choose` picks from the resources Weldall lists for this person.
 * `choose` runs on the registry fetched for this very connection and throws to refuse, so the
 * origin that gets the token is always one Weldall listed. The direct variant uses this device's
 * CLI login; a sandboxed client provides one through its door instead.
 */
export type OpenGitApp = (
  choose: (resources: ResourceRegistryEntry[]) => GitApp,
  scope: GitAppScope,
) => Promise<GitAppClient>;

export type GitAppAccessFailure =
  "login" | "network" | "configuration" | "refused" | "not_registered";

/** A Git app could not be asked: no login, unreachable, refused token, or not registered. */
export class GitAppAccessError extends CliError {
  constructor(
    readonly kind: GitAppAccessFailure,
    message: string,
    options: { cause?: unknown; hint?: string } = {},
  ) {
    super(message, options);
    this.name = "GitAppAccessError";
  }
}

/** The Git app a registered resource stands for, or null when it is none (see the module note). */
export function asGitApp(
  resource: ResourceRegistryEntry,
  scope: GitAppScope = GIT_APP_SCOPES.publish,
): GitApp | null {
  if (!resource.supportedScopes.includes(scope)) return null;
  const origin = httpsOrigin(resource.authorizationServer);
  return origin === null ? null : { key: resource.key, name: resource.name, origin, resource };
}

/** The origin of a bare https origin (`https://host[:port]`, optional `/`), else null. */
export function httpsOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(value === url.origin || value === `${url.origin}/`)
  )
    return null;
  return url.origin;
}

const describe = (app: Pick<GitApp, "key" | "name">) =>
  `${terminalText(app.name)} (${terminalText(app.key)})`;

/** Names from the registry, shown on one line without control characters. */
const terminalText = (value: string) =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 200);

/**
 * Raised when no registered Git app fits, as a `PublishError` with a stable code:
 * `no_git_app`, `git_app_unknown`, `git_app_ambiguous` or `scope_missing`.
 */
const selectionError = (
  code: "no_git_app" | "git_app_unknown" | "git_app_ambiguous" | "scope_missing",
  message: string,
  options: { hint?: string; details?: Record<string, string> } = {},
) => new PublishError(code, message, options);

const ADMIN_HINT =
  "Ask your Weldall administrator; the Git app's README describes how to register it.";

/**
 * Picks the Git app for `scope`: the one `key` names, or else the only one that offers the scope
 * and grants it to this person. Refuses with a clear reason when none or several fit, or when the
 * person lacks the scope.
 */
export function selectGitApp(
  resources: readonly ResourceRegistryEntry[],
  { key, scope }: { key?: string | undefined; scope: GitAppScope },
): GitApp {
  const apps = resources
    .map((resource) => asGitApp(resource, scope))
    .filter((app): app is GitApp => app !== null);
  const available = apps.map(({ key: name }) => name).join(", ");
  let app: GitApp;
  if (key !== undefined) {
    const named = apps.find((candidate) => candidate.key === key);
    if (!named)
      throw selectionError(
        "git_app_unknown",
        resources.some((resource) => resource.key === key)
          ? `"${terminalText(key)}" is registered in Weldall but is not a Git app that offers ${scope}.`
          : `Weldall lists no Git app "${terminalText(key)}" for you.`,
        {
          hint: available
            ? `Git apps you can use: ${terminalText(available)}.`
            : `No Git app is registered. ${ADMIN_HINT}`,
        },
      );
    app = named;
  } else {
    if (!apps.length)
      throw selectionError(
        "no_git_app",
        `No Git app is registered in Weldall, so this Weldall installation cannot ${scope === GIT_APP_SCOPES.admin ? "check a Git host" : "publish apps"} yet.`,
        { hint: ADMIN_HINT },
      );
    const granted = apps.filter((candidate) => candidate.resource.grantedScopes.includes(scope));
    if (granted.length === 1) return granted[0]!;
    if (granted.length > 1)
      throw selectionError(
        "git_app_ambiguous",
        `Several Git apps are registered in Weldall: ${granted.map(describe).join(", ")}. Name the one to use.`,
        {
          hint: "Add `--git-app <key>`; ask the person which Git host the app belongs on.",
          details: { gitApps: granted.map(({ key: name }) => name).join(", ") },
        },
      );
    app = apps[0]!;
    if (apps.length > 1)
      throw selectionError(
        "scope_missing",
        `You lack the permission ${scope} for every Git app registered in Weldall (${apps.map(describe).join(", ")}).`,
        { hint: `Ask your Weldall administrator for ${scope}.` },
      );
  }
  if (!app.resource.grantedScopes.includes(scope))
    throw selectionError(
      "scope_missing",
      `You lack the permission ${scope} for the Git app ${describe(app)}.`,
      { hint: `Ask your Weldall administrator for ${scope}.` },
    );
  return app;
}

/** The registered Git apps (offering `scope`) whose origin is `origin`. */
export const gitAppsAtOrigin = (
  resources: readonly ResourceRegistryEntry[],
  origin: string,
  scope: GitAppScope = GIT_APP_SCOPES.publish,
): GitApp[] =>
  resources
    .map((resource) => asGitApp(resource, scope))
    .filter((app): app is GitApp => app !== null && app.origin === origin);
