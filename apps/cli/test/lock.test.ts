import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withLock } from "../src/storage/lock.js";

const directories: string[] = [];

const lockPath = async () => {
  const directory = await mkdtemp(join(tmpdir(), "weldall-lock-test-"));
  directories.push(directory);
  return join(directory, "cli");
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("CLI process lock", () => {
  it("allows only one credential-mutating operation at a time", async () => {
    const path = await lockPath();
    let enter!: () => void;
    let leave!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const held = new Promise<void>((resolve) => (leave = resolve));

    const first = withLock(
      async () => {
        enter();
        await held;
      },
      { path },
    );
    await entered;

    await expect(withLock(async () => undefined, { path })).rejects.toThrow(
      "another weldall command is running",
    );
    leave();
    await first;
  });

  it("does not collide with the legacy regular PID file during upgrade", async () => {
    const legacyTarget = await lockPath();
    await writeFile(`${legacyTarget}.lock`, "12345");

    await expect(withLock(async () => "acquired", { path: `${legacyTarget}-v2` })).resolves.toBe(
      "acquired",
    );
  });

  it("recovers an abandoned stale lock atomically", async () => {
    const path = await lockPath();
    const staleDirectory = `${path}.lock`;
    await mkdir(staleDirectory);
    const old = new Date(Date.now() - 10_000);
    await utimes(staleDirectory, old, old);

    await expect(withLock(async () => "acquired", { path, stale: 2_000 })).resolves.toBe(
      "acquired",
    );
  });

  it("releases the lock when the protected operation fails", async () => {
    const path = await lockPath();
    await expect(
      withLock(
        async () => {
          throw new Error("operation failed");
        },
        { path },
      ),
    ).rejects.toThrow("operation failed");

    await expect(withLock(async () => "next", { path })).resolves.toBe("next");
  });
});
