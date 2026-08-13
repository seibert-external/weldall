import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { CliError } from "../errors.js";

export const MANIFEST_VERSION = "weldall.dev/v1alpha1";
export const MANIFEST_FILE = "weldall.yml";
export const LOCK_FILE = "weldall.lock.yml";
export const MAX_INCLUDES = 100;
export const MAX_OBJECTS = 1_000;

export interface Manifest {
  apiVersion: typeof MANIFEST_VERSION;
  workspace: { name: string; issuer: string };
  include?: string[];
  scopes?: Record<string, unknown>;
  resources?: Record<string, unknown>;
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
  "machines",
  "emailAssignments",
  "groupAssignments",
] as const;
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

function validateRoot(value: Manifest) {
  const root = record(value);
  for (const field of Object.keys(root))
    if (!["apiVersion", "workspace", "include", ...objectSections].includes(field))
      throw new CliError(`Unknown manifest field ${field}`);
  if (value.apiVersion !== MANIFEST_VERSION)
    throw new CliError(`apiVersion must be ${MANIFEST_VERSION}`);
  const workspace = record(value.workspace);
  if (typeof workspace.name !== "string" || !workspace.name.trim())
    throw new CliError("workspace.name is required");
  if (typeof workspace.issuer !== "string" || new URL(workspace.issuer).protocol !== "https:")
    throw new CliError("workspace.issuer must be HTTPS");
  if (
    value.include &&
    (!Array.isArray(value.include) || !value.include.every((item) => typeof item === "string"))
  )
    throw new CliError("include must be an array of paths");
}
function validateManifest(value: Manifest) {
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
      const identity = String(
        object.key ?? object.clientId ?? object.email ?? `${object.provider}:${object.groupId}`,
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
function containsPrivateJwk(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateJwk);
  if (!value || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, "d")) return true;
  return Object.values(value).some(containsPrivateJwk);
}
async function expandIncludes(root: string, patterns: string[]): Promise<string[]> {
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
  return { ...manifest, workspace: { ...manifest.workspace, id: lock.workspace.id } };
}
