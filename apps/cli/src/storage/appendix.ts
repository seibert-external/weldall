import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_VERSION = 1;
const MAX_APPENDIX_LENGTH = 100_000;

interface CachedAppendix {
  version: typeof CACHE_VERSION;
  issuer: string;
  appendix: string;
}

const cacheName = (issuer: string) =>
  `appendix-${createHash("sha256").update(issuer).digest("base64url")}.json`;

export class AppendixCache {
  constructor(private readonly directory = join(homedir(), ".weldall")) {}

  async read(issuer: string): Promise<string | null> {
    try {
      const value = JSON.parse(
        await readFile(join(this.directory, cacheName(issuer)), "utf8"),
      ) as Partial<CachedAppendix> | null;
      if (
        value?.version !== CACHE_VERSION ||
        value.issuer !== issuer ||
        typeof value.appendix !== "string" ||
        value.appendix.length > MAX_APPENDIX_LENGTH
      )
        return null;
      return value.appendix;
    } catch {
      return null;
    }
  }

  async write(issuer: string, appendix: string): Promise<void> {
    if (appendix.length > MAX_APPENDIX_LENGTH) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, cacheName(issuer));
    const temporary = join(this.directory, `.appendix-${randomUUID()}.tmp`);
    const value: CachedAppendix = { version: CACHE_VERSION, issuer, appendix };
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    try {
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export const appendixCache = new AppendixCache();
