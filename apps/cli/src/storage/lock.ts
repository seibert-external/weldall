import { mkdir, open, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const dir = join(homedir(), ".weldall");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "cli.lock");
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch {
    const owner = Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10);
    let ownerIsRunning = Number.isInteger(owner) && owner > 0;
    if (ownerIsRunning) {
      try {
        process.kill(owner, 0);
      } catch (error) {
        ownerIsRunning = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    }
    if (ownerIsRunning) throw new Error("another weldall command is running");
    await rm(path, { force: true });
    file = await open(path, "wx", 0o600).catch(() => {
      throw new Error("another weldall command is running");
    });
  }
  await file.writeFile(String(process.pid));
  try {
    return await fn();
  } finally {
    await file.close();
    await rm(path, { force: true });
  }
}
