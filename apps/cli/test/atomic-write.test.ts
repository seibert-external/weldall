import { mkdtemp, readFile, readdir, rename as renameFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { atomicWriteFile } from "../src/storage/atomic-write.js";

const eperm = (message = "operation not permitted") =>
  Object.assign(new Error(message), { code: "EPERM" });

const temporaryDirectory = async () => mkdtemp(join(tmpdir(), "weldall atomic write "));

describe("atomic-write storage helper", () => {
  it("writes an exclusive owner-only temporary file and renames it over the destination", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "target.json");
    try {
      await atomicWriteFile(destination, JSON.stringify({ ok: true }));
      expect(JSON.parse(await readFile(destination, "utf8"))).toEqual({ ok: true });
      expect(await readdir(directory)).toEqual(["target.json"]);
      if (process.platform !== "win32") expect((await stat(destination)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("defaults to a sibling temporary file when none is provided", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "discovery-config.json");
    try {
      await atomicWriteFile(destination, "payload");
      expect(await readdir(directory)).toEqual(["discovery-config.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries the rename on EPERM and completes once the concurrent reader closes", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "credentials.json");
    const temporary = join(directory, ".weldall-test.tmp");
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValueOnce(eperm())
      .mockRejectedValueOnce(eperm())
      .mockImplementation((from, to) => renameFile(from, to));
    try {
      await atomicWriteFile(destination, "secret", { temporary, rename, baseDelayMs: 1 });
      expect(rename).toHaveBeenCalledTimes(3);
      expect(rename).toHaveBeenCalledWith(temporary, destination);
      expect(await readFile(destination, "utf8")).toBe("secret");
      expect(await readdir(directory)).toEqual(["credentials.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("gives up after a bounded number of EPERM attempts and preserves the error", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "credentials.json");
    const temporary = join(directory, ".weldall-test.tmp");
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValue(eperm("original EPERM"));
    try {
      await expect(
        atomicWriteFile(destination, "secret", { temporary, rename, attempts: 3, baseDelayMs: 1 }),
      ).rejects.toMatchObject({ code: "EPERM", message: "original EPERM" });
      expect(rename).toHaveBeenCalledTimes(3);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails fast on non-EPERM rename errors without retrying and cleans up", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "credentials.json");
    const temporary = join(directory, ".weldall-test.tmp");
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValue(new Error("replace failed"));
    try {
      await expect(
        atomicWriteFile(destination, "secret", { temporary, rename, attempts: 5, baseDelayMs: 1 }),
      ).rejects.toThrow("replace failed");
      expect(rename).toHaveBeenCalledTimes(1);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves the original failure when temporary cleanup also fails", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "credentials.json");
    const temporary = join(directory, ".weldall-test.tmp");
    const rename = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValue(eperm("locked"));
    const cleanup = vi
      .fn<(path: string, options: { force: true }) => Promise<void>>()
      .mockRejectedValue(new Error("cleanup failed"));
    try {
      await expect(
        atomicWriteFile(destination, "secret", { temporary, rename, rm: cleanup, attempts: 1 }),
      ).rejects.toMatchObject({ code: "EPERM", message: "locked" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
