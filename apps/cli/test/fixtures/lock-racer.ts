/**
 * One contender for `publish.lock` (`publish-lock.test.ts`): waits until the `go` file exists, so
 * every contender starts at once, tries to take the lock, prints `acquired` or the error code, and
 * holds a lock it got for `holdMs` before releasing it.
 */
import { existsSync } from "node:fs";
import { Folder } from "../../src/publish/folder.js";
import type { GitRepository } from "../../src/publish/git.js";
import { acquirePublishLock } from "../../src/publish/state.js";

const [gitDirectory, go, holdMs] = process.argv.slice(2);
while (!existsSync(go!)) await new Promise((resolve) => setTimeout(resolve, 1));
try {
  const release = await acquirePublishLock(new Folder({} as GitRepository, gitDirectory!));
  process.stdout.write("acquired\n");
  await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
  await release();
} catch (error) {
  process.stdout.write(`${(error as { code?: string }).code ?? String(error)}\n`);
}
