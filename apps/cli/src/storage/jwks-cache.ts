import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, importJWK, type JSONWebKeySet } from "jose";
import { CONFIG_REFRESH_HINT, type WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";

const CACHE_VERSION = 1 as const;
export const JWKS_CACHE_TTL_MS = 5 * 60 * 1_000;

interface CachedJwks {
  version: typeof CACHE_VERSION;
  issuer: string;
  jwksUrl: string;
  fetchedAt: number;
  jwks: JSONWebKeySet;
}

export interface LoadedJwks {
  set: ReturnType<typeof createLocalJWKSet>;
  kids: ReadonlySet<string>;
  cached: boolean;
}

const cacheName = (issuer: string, jwksUrl: string) =>
  `jwks-${createHash("sha256").update(`${issuer}\0${jwksUrl}`).digest("base64url")}.json`;

export const validateJwks = (value: unknown): JSONWebKeySet => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new CliError("Weldall returned an invalid signing-key set");
  const keys = (value as Partial<JSONWebKeySet>).keys;
  const kids = new Set<string>();
  if (
    !Array.isArray(keys) ||
    keys.length < 1 ||
    keys.length > 100 ||
    keys.some((key) => {
      if (
        typeof key !== "object" ||
        key === null ||
        typeof key.kid !== "string" ||
        !key.kid ||
        kids.has(key.kid) ||
        key.alg !== "ES256" ||
        key.kty !== "EC" ||
        key.crv !== "P-256" ||
        typeof key.x !== "string" ||
        !key.x ||
        typeof key.y !== "string" ||
        !key.y ||
        key.d !== undefined ||
        (key.use !== undefined && key.use !== "sig")
      )
        return true;
      kids.add(key.kid);
      return false;
    })
  )
    throw new CliError("Weldall returned an invalid signing-key set");
  return { keys } as JSONWebKeySet;
};

const validateKeyMaterial = async (jwks: JSONWebKeySet) => {
  try {
    await Promise.all(jwks.keys.map((key) => importJWK(key, "ES256")));
  } catch (error) {
    throw new CliError("Weldall returned an invalid signing-key set", { cause: error });
  }
};

export class WeldallJwksCache {
  private readonly parsed = new Map<string, { record: CachedJwks; loaded: LoadedJwks }>();

  constructor(
    private readonly directory: string | null = join(homedir(), ".weldall"),
    private readonly fetcher?: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private key(config: WeldallConfig) {
    return `${config.issuer}\0${config.jwks}`;
  }

  private parse(record: CachedJwks, cached: boolean): LoadedJwks {
    const jwks = validateJwks(record.jwks);
    return {
      set: createLocalJWKSet(jwks),
      kids: new Set(jwks.keys.map((key) => key.kid!)),
      cached,
    };
  }

  private validRecord(value: unknown, config: WeldallConfig): CachedJwks | null {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      (value as Partial<CachedJwks>).version !== CACHE_VERSION ||
      (value as Partial<CachedJwks>).issuer !== config.issuer ||
      (value as Partial<CachedJwks>).jwksUrl !== config.jwks ||
      typeof (value as Partial<CachedJwks>).fetchedAt !== "number" ||
      !Number.isInteger((value as CachedJwks).fetchedAt) ||
      (value as CachedJwks).fetchedAt <= 0 ||
      (value as CachedJwks).fetchedAt > this.now() + 60_000
    )
      return null;
    try {
      validateJwks((value as CachedJwks).jwks);
      return value as CachedJwks;
    } catch {
      return null;
    }
  }

  private async read(config: WeldallConfig): Promise<CachedJwks | null> {
    if (!this.directory) return null;
    try {
      const record = this.validRecord(
        JSON.parse(
          await readFile(join(this.directory, cacheName(config.issuer, config.jwks)), "utf8"),
        ) as unknown,
        config,
      );
      if (!record) return null;
      await validateKeyMaterial(record.jwks);
      return record;
    } catch {
      return null;
    }
  }

  private async write(record: CachedJwks): Promise<void> {
    if (!this.directory) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, cacheName(record.issuer, record.jwksUrl));
    const temporary = join(this.directory, `.jwks-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    try {
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async refresh(config: WeldallConfig): Promise<LoadedJwks> {
    const response = await (this.fetcher ?? fetch)(config.jwks, {
      headers: { accept: "application/json" },
      redirect: "error",
    });
    if (!response.ok)
      throw new CliError("Unable to load Weldall signing keys", {
        ...(response.status === 404 || response.status === 410
          ? { hint: CONFIG_REFRESH_HINT }
          : {}),
      });
    const jwks = validateJwks((await response.json().catch(() => null)) as unknown);
    await validateKeyMaterial(jwks);
    const record: CachedJwks = {
      version: CACHE_VERSION,
      issuer: config.issuer,
      jwksUrl: config.jwks,
      fetchedAt: this.now(),
      jwks,
    };
    const loaded = this.parse(record, false);
    await this.write(record).catch(() => undefined);
    this.parsed.set(this.key(config), { record, loaded });
    return loaded;
  }

  async get(config: WeldallConfig, force = false): Promise<LoadedJwks> {
    if (force) return this.refresh(config);
    const key = this.key(config);
    const memory = this.parsed.get(key);
    if (memory && this.now() - memory.record.fetchedAt <= JWKS_CACHE_TTL_MS)
      return { ...memory.loaded, cached: true };
    const disk = await this.read(config);
    if (disk && this.now() - disk.fetchedAt <= JWKS_CACHE_TTL_MS) {
      const loaded = this.parse(disk, true);
      this.parsed.set(key, { record: disk, loaded });
      return loaded;
    }
    return this.refresh(config);
  }
}

export const weldallJwksCache = new WeldallJwksCache(
  process.env.NODE_ENV === "test" ? null : join(homedir(), ".weldall"),
);
