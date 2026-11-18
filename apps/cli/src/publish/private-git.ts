import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIRECTORY } from "../storage/preferences.js";
import { PRIVATE_CONFIG_KEYS, type ConfigEntry } from "./repository-safety.js";

/** Where the CLI keeps private git directories: the person's profile, which agents cannot write. */
export const defaultPrivateGitRoot = () => join(homedir(), CONFIG_DIRECTORY, "git");

/** A private directory older than this belongs to a run that was killed. */
const STALE_MS = 24 * 60 * 60_000;

export interface PrivateGitDirectoryOptions {
  /** Parent of the private directories, e.g. `~/.weldall/git`. */
  root: string;
  /** The folder (working tree). */
  workTree: string;
  /** The folder's object store, shared: objects are content-addressed data. */
  objects: string;
  /** The person's index, used unless a command brings its own. */
  index: string;
  /** The folder's `info/exclude`, copied once. */
  exclude: string;
  /** The folder's allowed config entries; `PRIVATE_CONFIG_KEYS` are taken over. */
  entries: readonly ConfigEntry[];
}

/** The private directory's config: the folder's working-tree settings, nothing that runs. */
export function privateGitConfig(entries: readonly ConfigEntry[]): string {
  const values = new Map<string, string>();
  for (const { key, value } of entries)
    if ((PRIVATE_CONFIG_KEYS as readonly string[]).includes(key) && value !== null)
      values.set(key, value);
  const lines = ["[core]", "\tbare = false"];
  for (const [key, value] of values)
    if (key.startsWith("core.")) lines.push(`\t${key.slice("core.".length)} = ${value}`);
  const format = values.get("extensions.objectformat");
  if (format) lines.push("[extensions]", `\tobjectformat = ${format}`);
  // Maintenance here would only see the private refs and could prune the folder's objects.
  lines.push("[gc]", "\tauto = 0", "[maintenance]", "\tauto = false");
  return `${lines.join("\n")}\n`;
}

/**
 * A git directory only the CLI writes, for the commands that git could make start a program
 * through the folder's config: reading the working tree (clean filters), checking out (smudge
 * filters), merging (merge drivers), fetching and pushing (credential helpers, remote and URL
 * settings). It holds a config, `HEAD`, `refs/` and a copy of `info/exclude`, and shares the
 * folder's object store and index (`GIT_OBJECT_DIRECTORY`, `GIT_INDEX_FILE`), so these commands
 * never read the folder's `.git/config`, which an agent could change while publish runs. One
 * directory per run, created on first use and removed by {@link dispose}.
 */
export class PrivateGitDirectory {
  private path: Promise<string> | null = null;

  constructor(private readonly options: PrivateGitDirectoryOptions) {}

  /** Variables that point git at the private directory; creates it on first use. */
  async environment(): Promise<NodeJS.ProcessEnv> {
    this.path ??= this.create();
    return {
      GIT_DIR: await this.path,
      GIT_WORK_TREE: this.options.workTree,
      GIT_OBJECT_DIRECTORY: this.options.objects,
      GIT_INDEX_FILE: this.options.index,
    };
  }

  async dispose(): Promise<void> {
    const path = await this.path?.catch(() => null);
    this.path = null;
    if (path) await rm(path, { recursive: true, force: true });
  }

  private async create(): Promise<string> {
    const { root } = this.options;
    await mkdir(root, { recursive: true, mode: 0o700 });
    await this.removeStale();
    const path = join(root, randomUUID());
    await mkdir(path, { mode: 0o700 });
    for (const directory of ["refs", "refs/heads", "info"]) await mkdir(join(path, directory));
    const exclusive = { flag: "wx", mode: 0o600 } as const;
    await writeFile(join(path, "HEAD"), "ref: refs/heads/main\n", exclusive);
    await writeFile(join(path, "config"), privateGitConfig(this.options.entries), exclusive);
    const exclude = await readFile(this.options.exclude).catch(() => Buffer.alloc(0));
    await writeFile(join(path, "info", "exclude"), exclude, exclusive);
    return path;
  }

  private async removeStale() {
    const now = Date.now();
    for (const name of await readdir(this.options.root).catch(() => [] as string[])) {
      const path = join(this.options.root, name);
      const modified = await stat(path).then(
        (stats) => stats.mtimeMs,
        () => now,
      );
      if (now - modified > STALE_MS) await rm(path, { recursive: true, force: true });
    }
  }
}
