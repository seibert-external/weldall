import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppendixCache } from "../src/storage/appendix.js";

const issuer = "https://weldall.example.com";

describe("CLI appendix cache", () => {
  it("isolates issuers and writes owner-only cache files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weldall-appendix-test-"));
    try {
      const cache = new AppendixCache(directory);
      await cache.writeSnapshot(issuer, {
        appendix: "# Organization instructions",
        scopes: ["expenses:read"],
        skills: [{ slug: "expenses.review", title: "Review expenses", available: true }],
        skillsInitialized: true,
        subject: "account-a",
      });

      await expect(cache.read(issuer)).resolves.toBe("# Organization instructions");
      await expect(cache.readSnapshot(issuer)).resolves.toEqual({
        appendix: "# Organization instructions",
        scopes: ["expenses:read"],
        skills: [{ slug: "expenses.review", title: "Review expenses", available: true }],
        skillsInitialized: true,
        subject: "account-a",
      });
      await expect(cache.read("https://other.example.com")).resolves.toBeNull();
      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      if (process.platform !== "win32")
        expect((await stat(join(directory, files[0]!))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("only returns account-specific previews to their verified subject", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weldall-appendix-test-"));
    try {
      const cache = new AppendixCache(directory);
      await cache.writeSnapshot(issuer, {
        appendix: "Shared instructions",
        scopes: ["account-a:read"],
        skills: [],
        subject: "account-a",
      });

      await expect(cache.readSnapshot(issuer)).resolves.toMatchObject({
        appendix: "Shared instructions",
        scopes: ["account-a:read"],
        subject: "account-a",
      });
      await expect(cache.readSnapshotForSubject(issuer, "account-b")).resolves.toMatchObject({
        appendix: "Shared instructions",
        scopes: [],
        skills: [],
        skillsInitialized: false,
      });
      await expect(cache.readSnapshotForSubject(issuer, null)).resolves.toMatchObject({
        appendix: "Shared instructions",
        scopes: [],
        skills: [],
      });
      await expect(cache.readSnapshotForSubject(issuer, "account-a")).resolves.toMatchObject({
        scopes: ["account-a:read"],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("clears legacy unbound previews when binding a subject", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weldall-appendix-test-"));
    try {
      const cache = new AppendixCache(directory);
      await cache.writeSnapshot(issuer, {
        appendix: "Shared instructions",
        scopes: ["legacy:read"],
        skills: [{ slug: "legacy", title: "Legacy", available: true }],
        skillsInitialized: true,
      });

      await expect(cache.updateSnapshot(issuer, { subject: "account-a" })).resolves.toMatchObject({
        subject: "account-a",
        scopes: [],
        skills: [],
        skillsInitialized: false,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes partial snapshot updates without losing fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weldall-appendix-test-"));
    try {
      const cache = new AppendixCache(directory);
      await Promise.all([
        cache.updateSnapshot(issuer, { subject: "account-a", scopes: ["expenses:read"] }),
        cache.updateSnapshot(issuer, {
          subject: "account-a",
          skills: [{ slug: "expenses", title: "Expenses", available: true }],
          skillsInitialized: true,
        }),
      ]);

      await expect(cache.readSnapshotForSubject(issuer, "account-a")).resolves.toMatchObject({
        scopes: ["expenses:read"],
        skills: [{ slug: "expenses", title: "Expenses", available: true }],
        skillsInitialized: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores missing or invalid cache entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weldall-appendix-test-"));
    try {
      const cache = new AppendixCache(directory);
      await expect(cache.read(issuer)).resolves.toBeNull();

      await cache.write(issuer, "cached");
      const [path] = await readdir(directory);
      await writeFile(join(directory, path!), "invalid JSON");
      await expect(cache.read(issuer)).resolves.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
