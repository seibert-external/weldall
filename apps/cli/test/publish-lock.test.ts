/**
 * Publish's own files below the git directory: the state directory must be a real directory, the
 * lock is never read through a link or a pipe, and exactly one run holds it, also when several
 * find a stale one at once.
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Folder } from "../src/publish/folder.js";
import type { GitRepository } from "../src/publish/git.js";
import {
  acquirePublishLock,
  clearPendingConflict,
  LOCK_REFRESH_MS,
  readPendingConflict,
  STALE_LOCK_MS,
} from "../src/publish/state.js";

let root: string;
let gitDirectory: string;
const folder = () => new Folder({} as GitRepository, gitDirectory);
const lockPath = () => join(gitDirectory, "weldall", "publish.lock");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "weldall-lock-"));
  gitDirectory = join(root, ".git");
  await mkdir(gitDirectory);
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("the state directory", () => {
  it.skipIf(process.platform === "win32")(
    "is refused when it is a link, and nothing is written or removed where it points",
    async () => {
      const outside = join(root, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "conflict.json"), "keep\n");
      await writeFile(join(outside, "publish.lock"), "keep\n");
      await symlink(outside, join(gitDirectory, "weldall"));

      await expect(acquirePublishLock(folder())).rejects.toMatchObject({
        code: "state_directory_unsafe",
        message: expect.stringContaining("not a plain folder"),
      });
      await expect(readPendingConflict(folder())).rejects.toMatchObject({
        code: "state_directory_unsafe",
      });
      await expect(clearPendingConflict(folder())).rejects.toMatchObject({
        code: "state_directory_unsafe",
      });
      expect((await readdir(outside)).sort()).toEqual(["conflict.json", "publish.lock"]);
      expect(await readFile(join(outside, "publish.lock"), "utf8")).toBe("keep\n");
      expect(await readFile(join(outside, "conflict.json"), "utf8")).toBe("keep\n");
    },
  );

  it("is refused when it is a file, and is created as a private directory when missing", async () => {
    await writeFile(join(gitDirectory, "weldall"), "x");
    await expect(acquirePublishLock(folder())).rejects.toMatchObject({
      code: "state_directory_unsafe",
    });
    await rm(join(gitDirectory, "weldall"));
    expect(await readPendingConflict(folder())).toBeNull();
    await expect(lstat(join(gitDirectory, "weldall"))).rejects.toMatchObject({ code: "ENOENT" });
    const release = await acquirePublishLock(folder());
    const created = await lstat(join(gitDirectory, "weldall"));
    expect(created.isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(created.mode & 0o777).toBe(0o700);
    await release();
  });
});

describe("the publish lock", () => {
  it("is held by one run, and released only by the run that holds it", async () => {
    const release = await acquirePublishLock(folder());
    expect(await readFile(lockPath(), "utf8")).toMatch(
      new RegExp(`^${process.pid} [0-9a-f]{32}\n$`),
    );
    await expect(acquirePublishLock(folder())).rejects.toMatchObject({ code: "busy" });
    await release();
    await expect(lstat(lockPath())).rejects.toMatchObject({ code: "ENOENT" });

    const mine = await acquirePublishLock(folder());
    // Another run's lock took its place (for example after this one was judged stale).
    await rm(lockPath());
    await writeFile(lockPath(), `${process.pid} other\n`);
    await mine();
    expect(await readFile(lockPath(), "utf8")).toBe(`${process.pid} other\n`);
    // No leftovers besides the lock.
    expect(await readdir(join(gitDirectory, "weldall"))).toEqual(["publish.lock"]);
  });

  it("takes over the lock of a process that is gone, and one not refreshed for an hour", async () => {
    await mkdir(join(gitDirectory, "weldall"));
    await writeFile(lockPath(), "999999\n");
    const first = await acquirePublishLock(folder());
    await first();

    // A living process (this one), but not refreshed for longer than a run may take.
    await writeFile(lockPath(), `${process.pid} old\n`);
    const old = new Date(Date.now() - STALE_LOCK_MS - 60_000);
    await utimes(lockPath(), old, old);
    const second = await acquirePublishLock(folder());
    expect(await readFile(lockPath(), "utf8")).not.toContain("old");
    await second();
    expect(await readdir(join(gitDirectory, "weldall"))).toEqual([]);
  });

  it("keeps the lock of a long run alive instead of letting it be taken over", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const release = await acquirePublishLock(folder());
    // An hour and more without a refresh would make it stale.
    const old = new Date(Date.now() - STALE_LOCK_MS - 60_000);
    await utimes(lockPath(), old, old);
    vi.advanceTimersByTime(LOCK_REFRESH_MS);
    for (let index = 0; index < 100; index += 1) {
      if (Date.now() - (await stat(lockPath())).mtimeMs < STALE_LOCK_MS) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(Date.now() - (await stat(lockPath())).mtimeMs).toBeLessThan(60_000);
    await expect(acquirePublishLock(folder())).rejects.toMatchObject({ code: "busy" });
    await release();
  });

  it.skipIf(process.platform === "win32")(
    "never blocks on a pipe named publish.lock, nor reads through a link",
    async () => {
      await mkdir(join(gitDirectory, "weldall"));
      expect(spawnSync("mkfifo", [lockPath()]).status).toBe(0);
      await expect(acquirePublishLock(folder())).rejects.toMatchObject({
        code: "state_file_unsafe",
        message: expect.stringContaining("not a lock Weldall wrote"),
      });
      await rm(lockPath());
      const target = join(root, "target");
      await writeFile(target, "999999\n");
      await symlink(target, lockPath());
      await expect(acquirePublishLock(folder())).rejects.toMatchObject({
        code: "state_file_unsafe",
      });
      expect(await readFile(target, "utf8")).toBe("999999\n");
    },
    10_000,
  );

  it("lets exactly one of several runs take over a stale lock at the same time", async () => {
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
    const racer = fileURLToPath(new URL("./fixtures/lock-racer.ts", import.meta.url));
    await mkdir(join(gitDirectory, "weldall"));
    for (let round = 0; round < 3; round += 1) {
      await writeFile(lockPath(), "999999\n");
      const go = join(root, `go-${round}`);
      const runs = Array.from({ length: 6 }, () => {
        const child = spawn(process.execPath, ["--import", tsx, racer, gitDirectory, go, "1500"], {
          stdio: ["ignore", "pipe", "inherit"],
        });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        return new Promise<string>((resolve) => child.on("close", () => resolve(output.trim())));
      });
      // Every contender is loaded and waiting before they start together.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      await writeFile(go, "");
      const outcomes = await Promise.all(runs);
      expect(
        outcomes.filter((outcome) => outcome === "acquired"),
        outcomes.join(","),
      ).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome !== "acquired")).toEqual(
        Array.from({ length: 5 }, () => "busy"),
      );
      expect(await readdir(join(gitDirectory, "weldall"))).toEqual([]);
    }
  }, 60_000);
});
