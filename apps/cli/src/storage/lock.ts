import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";

interface LockOptions {
  path?: string;
  stale?: number;
  retries?: number | { retries: number; factor?: number; minTimeout?: number; maxTimeout?: number };
}

export async function withLock<T>(fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  // Use a new basename: releases before 0.4.1 used cli.lock as a regular
  // PID file, while proper-lockfile uses <target>.lock as a directory.
  const path = options.path ?? join(homedir(), ".weldall", "cli-v2");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(path, {
      realpath: false,
      retries: options.retries ?? 0,
      stale: options.stale ?? 10_000,
      update: Math.floor((options.stale ?? 10_000) / 2),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED")
      throw new Error("another weldall command is running");
    throw error;
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}

export const withCredentialLock = <T>(issuer: string, fn: () => Promise<T>): Promise<T> =>
  withLock(fn, {
    path: join(
      homedir(),
      ".weldall",
      `credentials-${createHash("sha256").update(issuer).digest("base64url")}`,
    ),
    stale: 15_000,
    retries: { retries: 30, factor: 1.15, minTimeout: 20, maxTimeout: 200 },
  });
