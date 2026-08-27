import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WeldallConfig } from "../src/config.js";
import { WeldallConfigCache } from "../src/storage/config-cache.js";

const issuer = "https://weldall.example.com";
const config: WeldallConfig = {
  issuer,
  resource: `${issuer}/api`,
  authorize: `${issuer}/api/auth/oauth2/authorize`,
  token: `${issuer}/api/auth/oauth2/token`,
  revoke: `${issuer}/api/auth/oauth2/revoke`,
  jwks: `${issuer}/api/oauth/jwks`,
  cli: `${issuer}/api/me/cli`,
  grants: `${issuer}/api/me/grants`,
  scopes: `${issuer}/api/me/scopes`,
  skills: `${issuer}/api/me/skills`,
  userInfo: `${issuer}/api/auth/oauth2/userinfo`,
};

describe("validated discovery cache", () => {
  it("isolates issuers and atomically writes owner-only validated snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weldall-config-cache-"));
    try {
      const cache = new WeldallConfigCache(directory);
      await cache.write(issuer, config);
      await expect(cache.read(issuer)).resolves.toMatchObject({ issuer, config });
      await expect(cache.read("https://other.example.com")).resolves.toBeNull();
      const [file] = await readdir(directory);
      expect(file).toMatch(/^discovery-/);
      if (process.platform !== "win32")
        expect((await stat(join(directory, file!))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects corrupt, cross-issuer, and path-changing snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weldall-config-cache-"));
    try {
      const cache = new WeldallConfigCache(directory);
      await cache.write(issuer, config);
      const [file] = await readdir(directory);
      const path = join(directory, file!);
      const stored = JSON.parse(await readFile(path, "utf8")) as any;
      await writeFile(path, JSON.stringify({ ...stored, issuer: "https://other.example.com" }));
      await expect(cache.read(issuer)).resolves.toBeNull();
      await writeFile(
        path,
        JSON.stringify({ ...stored, config: { ...stored.config, token: `${issuer}/attacker` } }),
      );
      await expect(cache.read(issuer)).resolves.toBeNull();
      await writeFile(path, "not json");
      await expect(cache.read(issuer)).resolves.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
