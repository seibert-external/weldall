import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WeldallConfig } from "../config.js";
import { atomicWriteFile } from "./atomic-write.js";

const CACHE_VERSION = 1 as const;

export interface CachedWeldallConfig {
  version: typeof CACHE_VERSION;
  issuer: string;
  validatedAt: number;
  config: WeldallConfig;
}

const cacheName = (issuer: string) =>
  `discovery-${createHash("sha256").update(issuer).digest("base64url")}.json`;

const expectedConfig = (issuer: string): WeldallConfig => ({
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
});

export const isValidWeldallConfig = (config: unknown, issuer: string): config is WeldallConfig => {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return false;
  const expected = expectedConfig(issuer);
  return Object.entries(expected).every(
    ([key, expectedValue]) => (config as Record<string, unknown>)[key] === expectedValue,
  );
};

export class WeldallConfigCache {
  constructor(private readonly directory = join(homedir(), ".weldall")) {}

  async read(issuer: string): Promise<CachedWeldallConfig | null> {
    try {
      const value = JSON.parse(
        await readFile(join(this.directory, cacheName(issuer)), "utf8"),
      ) as Partial<CachedWeldallConfig> | null;
      if (
        value?.version !== CACHE_VERSION ||
        value.issuer !== issuer ||
        typeof value.validatedAt !== "number" ||
        !Number.isInteger(value.validatedAt) ||
        value.validatedAt <= 0 ||
        !isValidWeldallConfig(value.config, issuer)
      )
        return null;
      return value as CachedWeldallConfig;
    } catch {
      return null;
    }
  }

  async write(issuer: string, config: WeldallConfig): Promise<void> {
    if (!isValidWeldallConfig(config, issuer)) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, cacheName(issuer));
    const temporary = join(this.directory, `.discovery-${randomUUID()}.tmp`);
    const value: CachedWeldallConfig = {
      version: CACHE_VERSION,
      issuer,
      validatedAt: Date.now(),
      config,
    };
    await atomicWriteFile(path, JSON.stringify(value), { temporary });
  }
}

export const weldallConfigCache = new WeldallConfigCache();
