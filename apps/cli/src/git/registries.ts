import { resolveResourceForTarget, type ResourceRegistryEntry } from "@weldall/sdk";
import { CliError } from "../errors.js";
import { PublishError } from "../publish/errors.js";
import type { AppRegistryListing } from "../services/apps.js";
import { printable } from "./printable.js";

/**
 * Registries: the separate services an organisation registers in Weldall as resources to keep the
 * apps people create and publish (the Weldall registry). The CLI talks to a registry like to any
 * registered resource (token exchange at Weldall, downstream token at the registry, DPoP requests
 * below its request prefixes), and git reaches it at its git route.
 *
 * Finding one: only Weldall says which resources are registries. `GET /api/me/apps` lists them in
 * `registries` (`services/apps.ts`), with the person's own session: the resources an administrator
 * switched app discovery on for, each with its apps endpoint, publish and administration
 * permissions (and whether the person holds them), git route and git credential endpoint, already
 * checked by Weldall against the resource's registration. A resource's own protected resource
 * metadata is never read for this: any registered resource could announce an apps API there and
 * would then receive the folder's content and write into the working tree.
 *
 * Trust, in depth: every listed entry must also match the resource Weldall lists for the token
 * exchange (same key and resource identifier), every address in it must be at that resource's
 * authorization-server https origin (the API and git credential endpoint below the resource's
 * request prefixes, the git route exactly `<origin>/git/`), and its permissions must be among the
 * scopes Weldall lists for the resource. An entry that fails is reported in `rejected` and never
 * used. The project folder, including `.git/config` and the stored `weldall.*` values, can be
 * written by an agent while the CLI runs with the person's login; so every origin the CLI sends a
 * token or a git credential to comes from Weldall, never from the folder. The folder may only
 * choose among the registries Weldall lists, and a git address it stores must lie below the chosen
 * registry's git route.
 */
/** The git route of a registry, at the root of its origin. */
export const GIT_ROUTE_PATH = "/git/";

export interface Registry {
  /** Resource key in Weldall; what `--registry` names and the folder records. */
  key: string;
  name: string;
  /** The registry's https origin, from the authorization server Weldall lists. */
  origin: string;
  /** The resource as Weldall listed it. */
  resource: ResourceRegistryEntry;
  /** Base of the apps API (`<origin>/api/`): `apps`, `admin/apps`, `admin/checklist` below it. */
  api: string;
  /** The permission for one's own apps (`registry:publish` by default). */
  publishScope: string;
  /** Whether the person holds `publishScope` (Weldall says so, and grants it for the resource). */
  publishAllowed: boolean;
  /** The administration permission, or null when the registry offers no administration. */
  adminScope: string | null;
  /** Whether the person holds `adminScope`. */
  adminAllowed: boolean;
  /** `<origin>/git/` when the registry publishes changes, else null. */
  git: string | null;
  /** Where git credentials come from, when the registry publishes changes, else null. */
  gitCredentials: string | null;
}

/** What an operation needs of a registry. */
export type RegistryNeed = "apps" | "changes" | "admin" | "admin-changes";

export const needsAdmin = (need: RegistryNeed) => need === "admin" || need === "admin-changes";
export const needsChanges = (need: RegistryNeed) => need === "changes" || need === "admin-changes";
/** The permission to request for `need` at `registry`. */
export const scopeFor = (registry: Registry, need: RegistryNeed) =>
  needsAdmin(need) ? registry.adminScope : registry.publishScope;

/** Answer of a registry request: the HTTP status, the parsed body and `Retry-After` in seconds. */
export interface RegistryAnswer {
  status: number;
  body: unknown;
  retryAfter: number | null;
}

export interface RegistryRequest {
  method: "GET" | "POST" | "PUT";
  /** An absolute URL; it must lie below the registry's resource (checked before sending). */
  url: string;
  body?: unknown;
  timeoutMs: number;
}

/** One registry with a downstream token for one permission. */
export interface RegistryClient {
  readonly registry: Registry;
  /** Sends one request; throws only when it cannot ask. */
  send(request: RegistryRequest): Promise<RegistryAnswer>;
}

/** The registries Weldall lists for this person, as far as the CLI trusts them. */
export interface FoundRegistries {
  /** False when the Weldall server lists no registries at all (an older server). */
  listed: boolean;
  registries: Registry[];
  resources: ResourceRegistryEntry[];
  /** Entries Weldall listed that fail the CLI's own checks; never used. */
  rejected: Array<{ key: string; reason: string }>;
}

/**
 * Opens a client for the registry `choose` picks from the registries Weldall lists for this
 * person. `choose` runs on the registry list and resource registry fetched for this very
 * connection and throws to refuse, so the origin that gets the token is always one Weldall
 * listed as a registry. The direct variant uses this device's CLI login; a sandboxed client
 * provides one through its door instead and must keep the same checks.
 */
export type OpenRegistry = (
  choose: (found: FoundRegistries) => Registry,
  need: RegistryNeed,
) => Promise<RegistryClient>;

export type RegistryAccessFailure =
  "login" | "network" | "timeout" | "configuration" | "refused" | "not_registered";

/**
 * A registry could not be asked: no login, unreachable, no answer in time, refused token, or not
 * registered.
 */
export class RegistryAccessError extends CliError {
  constructor(
    readonly kind: RegistryAccessFailure,
    message: string,
    options: { cause?: unknown; hint?: string } = {},
  ) {
    super(message, options);
    this.name = "RegistryAccessError";
  }
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

/** A plain https URL at `origin` (no credentials, query or fragment, already normalised), else null. */
function urlAt(value: unknown, origin: string): URL | null {
  if (typeof value !== "string" || value.length > 2_000) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== value
  )
    return null;
  return url;
}

/** Whether `url` is below the resource's request prefixes, as the request path checks it. */
export const isBelowResource = (resource: ResourceRegistryEntry, url: URL | string) => {
  try {
    return resolveResourceForTarget([resource], new URL(url)).length === 1;
  } catch {
    return false;
  }
};

/**
 * The registry one entry of Weldall's list describes, checked against the resource Weldall lists
 * for the token exchange (module note). Throws a `CliError` naming the reason when they disagree.
 */
export function registryFromListing(
  entry: AppRegistryListing,
  resources: readonly ResourceRegistryEntry[],
): Registry {
  const resource = resources.find((candidate) => candidate.key === entry.key);
  if (!resource) throw new CliError("it is not among the resources Weldall lists for you");
  if (resource.resourceIdentifier !== entry.resource)
    throw new CliError("its resource identifier is not the one of its registration");
  const origin = httpsOrigin(resource.authorizationServer);
  if (origin === null) throw new CliError("its authorization server is not a bare https origin");
  // Weldall checks the addresses against the resource identifier's origin; the CLI sends tokens
  // from the authorization server there, so both must be the same origin.
  let resourceOrigin: string | null = null;
  try {
    const identifier = new URL(entry.resource);
    if (identifier.protocol === "https:") resourceOrigin = identifier.origin;
  } catch {
    // Reported below.
  }
  if (resourceOrigin !== origin)
    throw new CliError(
      `its resource identifier (${printable(entry.resource, 200)}) is not on the origin of its authorization server (${origin}); the administrator must register both on the same origin`,
    );
  const endpoint = urlAt(entry.endpoint, origin);
  if (!endpoint || !endpoint.pathname.endsWith("/apps"))
    throw new CliError(
      `its apps endpoint (${printable(entry.endpoint, 200)}) is not an https URL ending in /apps at ${origin}`,
    );
  // Only where the CLI sends a Weldall-brokered token: the apps endpoint and the git credential
  // endpoint. The git route (`<origin>/git/`) is outside the API prefix by design.
  if (!isBelowResource(resource, endpoint))
    throw new CliError(
      `its apps endpoint (${endpoint.href}) is not below the resource's request prefixes (${resource.requestPrefixes.map((prefix) => printable(prefix, 200)).join(", ")})`,
    );
  if (!resource.supportedScopes.includes(entry.scope))
    throw new CliError("its publish permission is not one Weldall lists for it");
  if (
    entry.adminScope !== null &&
    (entry.adminScope === entry.scope || !resource.supportedScopes.includes(entry.adminScope))
  )
    throw new CliError("its administration permission is not one Weldall lists for it");
  if (entry.git !== null && entry.git !== `${origin}${GIT_ROUTE_PATH}`)
    throw new CliError(`its git route is not ${origin}${GIT_ROUTE_PATH}`);
  let credentials: URL | null = null;
  if (entry.gitCredentials !== null) {
    credentials = urlAt(entry.gitCredentials, origin);
    if (!credentials)
      throw new CliError(
        `its git credential endpoint (${printable(entry.gitCredentials, 200)}) is not an https URL at ${origin}`,
      );
    if (!isBelowResource(resource, credentials))
      throw new CliError(
        `its git credential endpoint (${credentials.href}) is not below the resource's request prefixes (${resource.requestPrefixes.map((prefix) => printable(prefix, 200)).join(", ")})`,
      );
  }
  // Publishing changes needs both; with one of them only, the registry keeps apps but does not
  // publish changes (`publishing_not_configured` for the commands that need git).
  const publishes = entry.git !== null && credentials !== null;
  const git = publishes ? entry.git : null;
  const gitCredentials = publishes ? credentials!.href : null;
  const granted = (scope: string | null) =>
    scope !== null && resource.grantedScopes.includes(scope);
  return {
    key: resource.key,
    name: resource.name,
    origin,
    resource,
    api: new URL("./", endpoint).href,
    publishScope: entry.scope,
    publishAllowed: entry.allowed && granted(entry.scope),
    adminScope: entry.adminScope,
    adminAllowed: entry.adminAllowed && granted(entry.adminScope),
    git,
    gitCredentials,
  };
}

/**
 * The registries of Weldall's list (`null`: the server lists none) that pass the CLI's own checks
 * against the resources Weldall lists; the others are reported in `rejected`. A key listed twice
 * is rejected as a whole.
 */
export function trustedRegistries(
  listing: readonly AppRegistryListing[] | null,
  resources: ResourceRegistryEntry[],
): FoundRegistries {
  const registries: Registry[] = [];
  const rejected: FoundRegistries["rejected"] = [];
  const counts = new Map<string, number>();
  for (const entry of listing ?? []) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
  for (const entry of listing ?? []) {
    if (counts.get(entry.key)! > 1) {
      if (!rejected.some(({ key }) => key === entry.key))
        rejected.push({ key: entry.key, reason: "Weldall lists it more than once" });
      continue;
    }
    try {
      registries.push(registryFromListing(entry, resources));
    } catch (error) {
      rejected.push({
        key: entry.key,
        reason: printable(error instanceof Error ? error.message : "unusable", 200),
      });
    }
  }
  return { listed: listing !== null, registries, resources, rejected };
}

/** A registry as named in messages: its name and resource key, made printable. */
export const describeRegistry = (registry: Pick<Registry, "key" | "name">) =>
  `${printable(registry.name, 200)} (${printable(registry.key, 200)})`;

/**
 * `registry_ambiguous`: several registries fit where the CLI needs one. `situation` says how they
 * fit; the error names each one and lists their keys in `details.registries`.
 */
export const ambiguousRegistries = (
  situation: string,
  registries: readonly Pick<Registry, "key" | "name">[],
) =>
  new PublishError(
    "registry_ambiguous",
    `${situation}: ${registries.map(describeRegistry).join(", ")}.`,
    {
      hint: "Add `--registry <key>` to name one; ask the person which one the app belongs to.",
      details: { registries: registries.map(({ key }) => key).join(", ") },
    },
  );

const ADMIN_HINT = "Ask your Weldall administrator to set up publishing apps.";

const rejectedNote = (found: FoundRegistries) =>
  found.rejected.length
    ? ` Weldall lists ${found.rejected.length === 1 ? "a registry" : `${found.rejected.length} registries`} that the CLI does not use, because it does not match its registration (${found.rejected
        .slice(0, 5)
        .map(({ key, reason }) => `${printable(key, 120)}: ${reason}`)
        .join("; ")}).`
    : "";

const activity = (need: RegistryNeed) =>
  needsAdmin(need) ? "administering apps" : "publishing apps";

/** Why a registry does not fit `need`, or null when it does (permissions not checked here). */
function unfit(registry: Registry, need: RegistryNeed): { code: string; message: string } | null {
  if (needsChanges(need) && !registry.git)
    return {
      code: "publishing_not_configured",
      message: `${describeRegistry(registry)} keeps apps but does not publish changes to them yet`,
    };
  if (needsAdmin(need) && !registry.adminScope)
    return {
      code: "administration_not_offered",
      message: `${describeRegistry(registry)} does not offer administration of its apps`,
    };
  return null;
}

/** Whether the person holds the permission `need` takes at `registry`, as Weldall lists it. */
export const allowedFor = (registry: Registry, need: RegistryNeed) =>
  needsAdmin(need)
    ? registry.adminScope !== null && registry.adminAllowed
    : registry.publishAllowed;

const notFitting = (reasons: ReadonlyArray<{ code: string; message: string }>) =>
  new PublishError(reasons[0]!.code, `${reasons.map(({ message }) => message).join("; ")}.`, {
    hint: reasons[0]!.code === "administration_not_offered" ? ADMINISTRATION_HINT : ADMIN_HINT,
  });

const ADMINISTRATION_HINT =
  "Apps of this registry cannot be administered through Weldall; ask your Weldall administrator.";

/**
 * Picks the registry for `need`: the one `key` names, or else the only one that fits and that the
 * person may use for it. Never picks one of several: refuses with a clear reason when none or
 * several fit, or when the person lacks the permission.
 */
export function selectRegistry(
  found: FoundRegistries,
  { key, need }: { key?: string | undefined; need: RegistryNeed },
): Registry {
  const { registries } = found;
  const fitting = registries.filter((registry) => unfit(registry, need) === null);
  const available = registries.map(({ key: name }) => printable(name)).join(", ");
  let registry: Registry;
  if (key !== undefined) {
    const named = registries.find((candidate) => candidate.key === key);
    if (!named)
      throw new PublishError(
        "registry_unknown",
        found.resources.some((resource) => resource.key === key)
          ? `"${printable(key)}" is registered in Weldall but Weldall does not list it as a registry for apps.${rejectedNote(found)}`
          : `Weldall lists no registry "${printable(key)}" for you.`,
        {
          hint: available
            ? `Registries you can use: ${available}.`
            : `No registry for apps is set up. ${ADMIN_HINT}`,
        },
      );
    const reason = unfit(named, need);
    if (reason) throw notFitting([reason]);
    registry = named;
  } else {
    if (!registries.length)
      throw new PublishError(
        "publishing_not_set_up",
        `Your organisation has not set up ${activity(need)} through Weldall: ${
          found.listed
            ? "Weldall lists no registry for apps for you."
            : "this Weldall server lists no registries for apps."
        }${rejectedNote(found)}`,
        { hint: ADMIN_HINT },
      );
    if (!fitting.length) throw notFitting(registries.map((candidate) => unfit(candidate, need)!));
    const allowed = fitting.filter((candidate) => allowedFor(candidate, need));
    if (allowed.length === 1) return allowed[0]!;
    if (allowed.length > 1)
      throw ambiguousRegistries("Several registries for apps are set up in Weldall", allowed);
    registry = fitting[0]!;
    if (fitting.length > 1)
      throw new PublishError(
        "scope_missing",
        `You lack the permission for ${activity(need)} at every registry set up in Weldall (${fitting.map(describeRegistry).join(", ")}).`,
        {
          hint: `Ask your Weldall administrator for one of: ${fitting.map((candidate) => printable(scopeFor(candidate, need)!)).join(", ")}.`,
        },
      );
  }
  if (!allowedFor(registry, need)) {
    const missing = printable(scopeFor(registry, need)!);
    throw new PublishError(
      "scope_missing",
      `You lack the permission ${missing} for ${activity(need)} at ${describeRegistry(registry)}.`,
      { hint: `Ask your Weldall administrator for ${missing}.` },
    );
  }
  return registry;
}

/** The registries (that publish changes) whose git route is at `origin`. */
export const registriesAtOrigin = (registries: readonly Registry[], origin: string): Registry[] =>
  registries.filter((registry) => registry.git !== null && registry.origin === origin);
