import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { generateEs256KeyPair, issueAccessToken } from "@weldall/sdk";
import type { WeldallConfig } from "../src/config.js";
import { WELDALL_CLIENT_ID } from "../src/oauth/constants.js";
import { validateAccessToken } from "../src/oauth/session.js";
import { JWKS_CACHE_TTL_MS, WeldallJwksCache } from "../src/storage/jwks-cache.js";

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

const responseFor = (key: Awaited<ReturnType<typeof generateEs256KeyPair>>, kid: string) =>
  Response.json({ keys: [{ ...key.publicJwk, kid, alg: "ES256", use: "sig" }] });

describe("JWKS cache", () => {
  it("reuses validated keys across cache instances and writes owner-only files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weldall-jwks-cache-"));
    try {
      const signing = await generateEs256KeyPair();
      const fetcher = vi.fn(async () => responseFor(signing, "key-1"));
      await new WeldallJwksCache(directory, fetcher).get(config);
      await new WeldallJwksCache(directory, fetcher).get(config);
      expect(fetcher).toHaveBeenCalledOnce();
      const [file] = await readdir(directory);
      if (process.platform !== "win32")
        expect((await stat(join(directory, file!))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refreshes expired signing keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weldall-jwks-cache-"));
    try {
      const signing = await generateEs256KeyPair();
      let now = 1_000;
      const fetcher = vi.fn(async () => responseFor(signing, "key-1"));
      const cache = new WeldallJwksCache(directory, fetcher, () => now);
      await cache.get(config);
      now += JWKS_CACHE_TTL_MS + 1;
      await cache.get(config);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("forces one refresh for an unknown kid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weldall-jwks-cache-"));
    try {
      const oldSigning = await generateEs256KeyPair();
      const signing = await generateEs256KeyPair();
      const device = await generateEs256KeyPair();
      const token = await issueAccessToken({
        issuer,
        subject: "user",
        email: "user@example.com",
        resource: config.resource,
        clientId: WELDALL_CLIENT_ID,
        scopes: ["weldall:scopes"],
        jkt: device.jkt,
        kid: "current",
        privateJwk: signing.privateJwk,
      });
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(responseFor(oldSigning, "old"))
        .mockResolvedValueOnce(responseFor(signing, "current"));
      const cache = new WeldallJwksCache(directory, fetcher);
      await expect(
        validateAccessToken(config, token, device.publicJwk, cache),
      ).resolves.toMatchObject({
        sub: "user",
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("forces one refresh when a cached kid has replacement signing material", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weldall-jwks-cache-"));
    try {
      const oldSigning = await generateEs256KeyPair();
      const signing = await generateEs256KeyPair();
      const device = await generateEs256KeyPair();
      const token = await issueAccessToken({
        issuer,
        subject: "user",
        email: "user@example.com",
        resource: config.resource,
        clientId: WELDALL_CLIENT_ID,
        scopes: ["weldall:scopes"],
        jkt: device.jkt,
        kid: "shared",
        privateJwk: signing.privateJwk,
      });
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(responseFor(oldSigning, "shared"))
        .mockResolvedValueOnce(responseFor(signing, "shared"));
      const cache = new WeldallJwksCache(directory, fetcher);

      await expect(
        validateAccessToken(config, token, device.publicJwk, cache),
      ).resolves.toMatchObject({ sub: "user" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not overwrite a valid cache with invalid replacement keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "weldall-jwks-cache-"));
    try {
      const signing = await generateEs256KeyPair();
      const initial = new WeldallJwksCache(directory, async () => responseFor(signing, "key-1"));
      await initial.get(config);
      await expect(
        new WeldallJwksCache(directory, async () =>
          Response.json({ keys: [{ kid: "bad", d: "x" }] }),
        ).get(config, true),
      ).rejects.toThrow("invalid signing-key set");
      const unavailable = vi.fn(async () => {
        throw new Error("network should not be used");
      });
      await expect(new WeldallJwksCache(directory, unavailable).get(config)).resolves.toMatchObject(
        {
          kids: expect.any(Set),
        },
      );
      expect(unavailable).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
