import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createPublicKey } from "node:crypto";
import { parseDocument } from "yaml";
import { SKILL_TAG_LENGTH_LIMIT, SKILL_TAG_LIMIT } from "@weldall/sdk";
import { CliError } from "../errors.js";

export const MANIFEST_VERSION = "weldall.dev/v1";
export const MANIFEST_FILE = "weldall.yml";
export const LOCK_FILE = "weldall.lock.yml";
export const MAX_INCLUDES = 100;
export const MAX_OBJECTS = 1_000;

export interface Manifest {
  apiVersion: typeof MANIFEST_VERSION;
  workspace: { name: string; issuer: string };
  include?: string[];
  cli?: { logoUrl: string; darkLogoUrl?: string };
  scopes?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  skills?: Record<string, unknown>;
  machines?: Record<string, unknown>;
  emailAssignments?: Record<string, unknown>;
  groupAssignments?: Record<string, unknown>;
}
export interface Lockfile {
  version: 1;
  server: { issuer: string; installationId: string | null };
  workspace: { id: string; name: string; observedRevision: number };
  objects: Record<
    string,
    { kind: string; objectId: string | null; identity: string; observedVersion?: number }
  >;
}

const objectSections = [
  "scopes",
  "resources",
  "skills",
  "machines",
  "emailAssignments",
  "groupAssignments",
] as const;
const rootSections = ["cli", ...objectSections] as const;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CliError("Expected a YAML mapping");
  return value as Record<string, unknown>;
};

export async function loadWorkspace(
  cwd = process.cwd(),
): Promise<{ manifest: Manifest; lock: Lockfile | null; root: string }> {
  const root = resolve(cwd);
  const rootFile = join(root, MANIFEST_FILE);
  const rootReal = await realpath(root);
  const manifest = parseYaml(await readFile(rootFile, "utf8"), rootFile) as Manifest;
  validateRoot(manifest);
  const merged: Manifest = structuredClone(manifest);
  for (const section of objectSections) merged[section] = { ...(merged[section] ?? {}) };
  const includes = manifest.include ?? [];
  if (includes.length > MAX_INCLUDES)
    throw new CliError(`At most ${MAX_INCLUDES} includes are allowed`);
  const paths = await expandIncludes(root, includes);
  for (const path of paths) {
    const targetReal = await realpath(path);
    if (
      relative(rootReal, targetReal).startsWith(`..${sep}`) ||
      relative(rootReal, targetReal) === ".."
    )
      throw new CliError("Included files cannot escape the workspace");
    if ((await lstat(path)).isSymbolicLink())
      throw new CliError("Symbolic-link includes are not allowed");
    const fragment = record(parseYaml(await readFile(path, "utf8"), path));
    for (const field of Object.keys(fragment))
      if (!objectSections.includes(field as any))
        throw new CliError(`Unknown fragment field ${field}`);
    for (const section of objectSections) {
      const additions = fragment[section] === undefined ? {} : record(fragment[section]);
      for (const [address, value] of Object.entries(additions)) {
        if (address in (merged[section] ?? {}))
          throw new CliError(`Duplicate logical address ${section}.${address}`);
        (merged[section] as Record<string, unknown>)[address] = value;
      }
    }
  }
  delete merged.include;
  validateManifest(merged);
  let lock: Lockfile | null = null;
  try {
    lock = parseYaml(await readFile(join(root, LOCK_FILE), "utf8"), LOCK_FILE) as Lockfile;
    validateLock(lock, merged);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { manifest: merged, lock, root };
}

function parseYaml(source: string, path: string): unknown {
  const document = parseDocument(source, { uniqueKeys: true, prettyErrors: true, strict: true });
  if (document.errors.length)
    throw new CliError(`Invalid YAML in ${path}: ${document.errors[0]!.message}`);
  if (/[*&!][A-Za-z0-9_-]/.test(source))
    throw new CliError(`YAML aliases and custom tags are forbidden in ${path}`);
  return document.toJS({ maxAliasCount: 0 });
}

export function validateRoot(value: Manifest) {
  const root = record(value);
  for (const field of Object.keys(root))
    if (
      !["apiVersion", "workspace", "include", ...rootSections].includes(
        field as (typeof rootSections)[number] | "apiVersion" | "workspace" | "include",
      )
    )
      throw new CliError(`Unknown manifest field ${field}`);
  if (value.apiVersion !== MANIFEST_VERSION)
    throw new CliError(`apiVersion must be ${MANIFEST_VERSION}`);
  const workspace = record(value.workspace);
  for (const field of Object.keys(workspace))
    if (!["name", "issuer"].includes(field)) throw new CliError(`Unknown workspace field ${field}`);
  if (typeof workspace.name !== "string" || !workspace.name.trim())
    throw new CliError("workspace.name is required");
  if (typeof workspace.issuer !== "string") throw new CliError("workspace.issuer must be HTTPS");
  const issuer = canonicalHttpsUrl(workspace.issuer, "workspace.issuer", "origin");
  if (issuer !== workspace.issuer)
    throw new CliError("workspace.issuer must be a canonical origin");
  if (
    value.include &&
    (!Array.isArray(value.include) || !value.include.every((item) => typeof item === "string"))
  )
    throw new CliError("include must be an array of paths");
}
function validateManifest(value: Manifest) {
  if (value.cli !== undefined) {
    const cli = record(value.cli);
    if (Object.keys(cli).some((field) => field !== "logoUrl" && field !== "darkLogoUrl"))
      throw new CliError("Unknown cli field");
    if (typeof cli.logoUrl !== "string" || cli.logoUrl.length > 2_000)
      throw new CliError("Invalid cli.logoUrl");
    if (cli.logoUrl && canonicalHttpsUrl(cli.logoUrl, "cli.logoUrl", "asset") !== cli.logoUrl)
      throw new CliError("cli.logoUrl must be a canonical HTTPS URL");
    if (
      cli.darkLogoUrl !== undefined &&
      (typeof cli.darkLogoUrl !== "string" || cli.darkLogoUrl.length > 2_000)
    )
      throw new CliError("Invalid cli.darkLogoUrl");
    if (
      cli.darkLogoUrl &&
      canonicalHttpsUrl(cli.darkLogoUrl, "cli.darkLogoUrl", "asset") !== cli.darkLogoUrl
    )
      throw new CliError("cli.darkLogoUrl must be a canonical HTTPS URL");
  }
  let count = 0;
  const identities = new Set<string>();
  for (const section of objectSections)
    for (const [address, item] of Object.entries(value[section] ?? {})) {
      count++;
      if (!/^[a-z][a-z0-9_-]{0,119}$/.test(address))
        throw new CliError(`Invalid logical address ${section}.${address}`);
      const object = record(item);
      if (containsPrivateJwk(object))
        throw new CliError("Private JWK member d is forbidden in Weldall YAML");
      validatePrimitive(section, object);
      const identity = String(
        object.key ??
          object.slug ??
          object.clientId ??
          object.email ??
          `${object.provider}:${object.groupId}`,
      );
      const composite = `${section}:${identity}`;
      if (identities.has(composite)) throw new CliError(`Duplicate natural identity ${identity}`);
      identities.add(composite);
    }
  if (count > MAX_OBJECTS) throw new CliError(`At most ${MAX_OBJECTS} objects are allowed`);
  for (const scope of Object.values(value.scopes ?? {}).map(record))
    if (["weldall:login", "weldall:administer", "weldall:iac"].includes(String(scope.key)))
      throw new CliError(`System scope ${scope.key} cannot be declared`);
  for (const assignment of [
    ...Object.values(value.emailAssignments ?? {}),
    ...Object.values(value.groupAssignments ?? {}),
  ].map(record))
    if (Array.isArray(assignment.scopes) && assignment.scopes.includes("weldall:iac"))
      throw new CliError("weldall:iac is machine-only");
}
function validatePrimitive(
  section: (typeof objectSections)[number],
  object: Record<string, unknown>,
) {
  const fields: Record<typeof section, string[]> = {
    scopes: ["key", "description"],
    resources: [
      "key",
      "name",
      "resourceIdentifier",
      "authorizationServer",
      "downstreamClientId",
      "enabled",
      "skillDiscoveryEnabled",
      "requestPrefixes",
      "scopes",
    ],
    skills: ["slug", "title", "content", "requiredScopes", "visibility", "meta", "lastUpdatedAt"],
    machines: ["clientId", "name", "enabled", "publicKeys", "resources", "scopes"],
    emailAssignments: ["email", "scopes"],
    groupAssignments: ["provider", "groupId", "scopes"],
  };
  for (const field of Object.keys(object))
    if (!fields[section].includes(field)) throw new CliError(`Unknown ${section} field ${field}`);
  const required = fields[section].filter(
    (field) => !["skillDiscoveryEnabled", "publicKeys", "meta", "lastUpdatedAt"].includes(field),
  );
  for (const field of required)
    if (!(field in object)) throw new CliError(`${section}.${field} is required`);
  const text = (field: string, max: number, pattern?: RegExp) => {
    const value = object[field];
    if (
      typeof value !== "string" ||
      value !== value.trim() ||
      !value ||
      value.length > max ||
      (pattern && !pattern.test(value))
    )
      throw new CliError(`Invalid ${section}.${field}`);
    return value;
  };
  const list = (field: string, nonEmpty = false) => {
    const value = object[field];
    if (
      !Array.isArray(value) ||
      (nonEmpty && !value.length) ||
      value.length > 100 ||
      !value.every((item) => typeof item === "string" && item.trim() && item.length <= 160) ||
      new Set(value).size !== value.length
    )
      throw new CliError(`Invalid ${section}.${field}`);
    return value as string[];
  };
  if (section === "scopes") {
    text("key", 160, /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/);
    text("description", 500);
  } else if (section === "resources") {
    text("key", 120, /^[a-z0-9._-]+$/);
    text("name", 200);
    text("downstreamClientId", 200);
    if (typeof object.enabled !== "boolean")
      throw new CliError(`${section}.enabled must be boolean`);
    if (
      object.skillDiscoveryEnabled !== undefined &&
      typeof object.skillDiscoveryEnabled !== "boolean"
    )
      throw new CliError(`${section}.skillDiscoveryEnabled must be boolean`);
    if (
      canonicalHttpsUrl(text("resourceIdentifier", 2000), "resourceIdentifier", "identifier") !==
      object.resourceIdentifier
    )
      throw new CliError("resourceIdentifier must be canonical HTTPS");
    if (
      canonicalHttpsUrl(text("authorizationServer", 2000), "authorizationServer", "origin") !==
      object.authorizationServer
    )
      throw new CliError("authorizationServer must be a canonical HTTPS origin");
    for (const prefix of list("requestPrefixes", true))
      if (canonicalHttpsUrl(prefix, "requestPrefixes", "prefix") !== prefix)
        throw new CliError("requestPrefixes must be canonical HTTPS URLs");
    list("scopes");
  } else if (section === "skills") {
    text("slug", 120, /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
    text("title", 200);
    if (
      typeof object.content !== "string" ||
      !object.content.trim() ||
      object.content.trim().length > 100_000
    )
      throw new CliError("Invalid skills.content");
    const requiredScopes = list("requiredScopes");
    if (!requiredScopes.every((scope) => /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/.test(scope)))
      throw new CliError("Invalid skills.requiredScopes");
    if (!(["DEFAULT", "HIDDEN_IF_UNALLOWED"] as unknown[]).includes(object.visibility))
      throw new CliError("Invalid skills.visibility");
    if (object.meta !== undefined) {
      const meta = record(object.meta);
      if (Object.keys(meta).some((field) => !["tags", "owner"].includes(field)))
        throw new CliError("Unknown skills.meta field");
      if (
        meta.tags !== undefined &&
        (!Array.isArray(meta.tags) ||
          meta.tags.length > SKILL_TAG_LIMIT ||
          !meta.tags.every(
            (tag) =>
              typeof tag === "string" && tag.length > 0 && tag.length <= SKILL_TAG_LENGTH_LIMIT,
          ))
      )
        throw new CliError("Invalid skills.meta.tags");
      if (meta.owner !== undefined && typeof meta.owner !== "string")
        throw new CliError("Invalid skills.meta.owner");
    }
    if (object.lastUpdatedAt !== undefined && typeof object.lastUpdatedAt !== "string")
      throw new CliError("Invalid skills.lastUpdatedAt");
  } else if (section === "machines") {
    text("clientId", 128, /^[A-Za-z0-9._:-]+$/);
    text("name", 200);
    if (typeof object.enabled !== "boolean") throw new CliError("machines.enabled must be boolean");
    list("resources");
    list("scopes");
    const keys = object.publicKeys === undefined ? {} : record(object.publicKeys);
    for (const [kid, raw] of Object.entries(keys)) {
      if (!/^[a-z][a-z0-9_-]{0,119}$/.test(kid)) throw new CliError("Invalid public key ID");
      const jwk = record(raw);
      if (
        Object.keys(jwk).some((field) => !["kty", "crv", "x", "y", "alg", "use"].includes(field)) ||
        jwk.kty !== "EC" ||
        jwk.crv !== "P-256" ||
        typeof jwk.x !== "string" ||
        typeof jwk.y !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(jwk.x) ||
        !/^[A-Za-z0-9_-]{43}$/.test(jwk.y) ||
        (jwk.alg !== undefined && jwk.alg !== "ES256") ||
        (jwk.use !== undefined && jwk.use !== "sig")
      )
        throw new CliError("Public keys must be strict public P-256 JWKs");
      try {
        createPublicKey({ key: jwk as Record<string, string>, format: "jwk" });
      } catch {
        throw new CliError("Public keys must be valid public P-256 JWKs");
      }
    }
  } else if (section === "emailAssignments") {
    const email = text("email", 320);
    if (!/^\S+@\S+\.\S+$/.test(email) || email !== email.toLowerCase())
      throw new CliError("Invalid emailAssignments.email");
    list("scopes", true);
  } else {
    text("provider", 160);
    text("groupId", 191);
    list("scopes", true);
  }
}

function canonicalHttpsUrl(
  value: string,
  label: string,
  kind: "origin" | "identifier" | "prefix" | "asset",
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`${label} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new CliError(`${label} must be HTTPS without credentials`);
  if (kind === "origin") {
    if (url.pathname !== "/" || url.search || url.hash)
      throw new CliError(`${label} must be an HTTPS origin`);
    return url.origin;
  }
  if (url.hash || (kind === "prefix" && url.search))
    throw new CliError(`${label} contains forbidden URL components`);
  if (kind === "prefix") {
    if (url.pathname.includes("%"))
      throw new CliError(`${label} must not contain percent encoding`);
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  }
  return url.toString();
}

function containsPrivateJwk(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateJwk);
  if (!value || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, "d")) return true;
  return Object.values(value).some(containsPrivateJwk);
}
export async function expandIncludes(root: string, patterns: string[]): Promise<string[]> {
  const glob = (await import("node:fs/promises")).glob;
  const paths: string[] = [];
  for (const pattern of patterns) {
    if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes(".."))
      throw new CliError("Includes must be root-relative and cannot contain ..");
    for await (const entry of glob(pattern, { cwd: root })) paths.push(join(root, entry));
  }
  return [...new Set(paths)].sort();
}
function validateLock(lock: Lockfile, manifest: Manifest) {
  if (
    lock.version !== 1 ||
    !lock.workspace?.id ||
    lock.server?.issuer !== manifest.workspace.issuer ||
    lock.workspace.name !== manifest.workspace.name
  )
    throw new CliError("weldall.lock.yml does not match this workspace");
}
export function newLock(manifest: Manifest): Lockfile {
  return {
    version: 1,
    server: { issuer: manifest.workspace.issuer, installationId: null },
    workspace: { id: randomUUID(), name: manifest.workspace.name, observedRevision: 0 },
    objects: {},
  };
}
export async function writeLock(root: string, lock: Lockfile) {
  const { stringify } = await import("yaml");
  const temporary = join(root, `.weldall.lock.${randomUUID()}.tmp`);
  await writeFile(temporary, stringify(lock), { mode: 0o644, flag: "wx" });
  await (await import("node:fs/promises")).rename(temporary, join(root, LOCK_FILE));
}
export function serverManifest(manifest: Manifest, lock: Lockfile) {
  // Re-run local validation immediately before constructing an API payload so
  // plan/up/import never depend on an earlier load-only validation pass.
  validateManifest(manifest);
  return canonicalServerManifest({
    ...manifest,
    workspace: { ...manifest.workspace, id: lock.workspace.id },
  });
}

export function canonicalServerManifest(manifest: Record<string, any>) {
  const canonicalSet = (values: unknown) =>
    [...new Set((values as string[]) ?? [])].sort((left, right) => left.localeCompare(right));
  const canonicalRecords = (section: string, transform: (value: any) => any) =>
    Object.fromEntries(
      Object.entries(manifest[section] ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => [name, transform(value)]),
    );
  return {
    apiVersion: manifest.apiVersion,
    workspace: manifest.workspace,
    ...(manifest.cli
      ? {
          cli: {
            logoUrl: manifest.cli.logoUrl,
            ...(manifest.cli.darkLogoUrl !== undefined
              ? { darkLogoUrl: manifest.cli.darkLogoUrl }
              : {}),
          },
        }
      : {}),
    scopes: canonicalRecords("scopes", (value) => value),
    resources: canonicalRecords("resources", (value) => ({
      ...value,
      skillDiscoveryEnabled: value.skillDiscoveryEnabled ?? false,
      requestPrefixes: canonicalSet(value.requestPrefixes),
      scopes: canonicalSet(value.scopes),
    })),
    skills: canonicalRecords("skills", (value) => ({
      ...value,
      content: value.content.trim(),
      requiredScopes: canonicalSet(value.requiredScopes),
    })),
    machines: canonicalRecords("machines", (value) => ({
      ...value,
      publicKeys: Object.fromEntries(
        Object.entries(value.publicKeys ?? {}).sort(([left], [right]) => left.localeCompare(right)),
      ),
      resources: canonicalSet(value.resources),
      scopes: canonicalSet(value.scopes),
    })),
    emailAssignments: canonicalRecords("emailAssignments", (value) => ({
      ...value,
      email: value.email.toLowerCase(),
      scopes: canonicalSet(value.scopes),
    })),
    groupAssignments: canonicalRecords("groupAssignments", (value) => ({
      ...value,
      scopes: canonicalSet(value.scopes),
    })),
  };
}

export function canonicalManifestDigest(manifest: Record<string, any>) {
  return createHash("sha256")
    .update(canonicalJson(canonicalServerManifest(manifest)))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
