import { createHash } from "node:crypto";
import { mkdir, open, readdir, stat, unlink, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MCP_LIMITS } from "@weldall/sdk/mcp";
import { atomicWriteFile } from "./atomic-write.js";
import { withLock } from "./lock.js";

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 128;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = MCP_LIMITS.definitionsBytes + 4096;
const filename = (key: string) => `${createHash("sha256").update(key).digest("hex")}.json`;

/** Optional disk snapshots of definitions only. Callers must validate catalogs and live access. */
export class NativeMcpCatalogCache {
  constructor(private readonly directory = join(homedir(), ".weldall", "native-mcp")) {}

  async read(key: string): Promise<unknown | null> {
    const path = join(this.directory, filename(key));
    try {
      const file = await open(path, "r");
      let text: string;
      try {
        // Bound allocation even for corrupt files; atomic replacements cannot change this handle.
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > MAX_FILE_BYTES) return null;
        text = buffer.subarray(0, size).toString("utf8");
      } finally {
        await file.close();
      }
      const value = JSON.parse(text);
      const now = Date.now();
      if (
        value?.version !== 1 ||
        value.key !== filename(key) ||
        !Number.isSafeInteger(value.createdAt) ||
        value.createdAt > now ||
        now - value.createdAt >= TTL_MS
      )
        return null;
      // Touch for eviction only; reads never extend the five-minute freshness window.
      await utimes(path, new Date(now), new Date(now)).catch(() => {});
      return value.catalog ?? null;
    } catch {
      return null;
    }
  }

  async write(key: string, catalog: unknown): Promise<void> {
    try {
      const name = filename(key);
      const json = JSON.stringify({ version: 1, key: name, createdAt: Date.now(), catalog });
      const size = Buffer.byteLength(json);
      if (size > MAX_FILE_BYTES) return;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await withLock(
        async () => {
          const entries = await Promise.all(
            (await readdir(this.directory))
              .filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry) && entry !== name)
              .map(async (entry) => ({
                name: entry,
                ...(await stat(join(this.directory, entry))),
              })),
          );
          entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
          let bytes = entries.reduce((sum, entry) => sum + entry.size, 0) + size;
          while (entries.length >= MAX_ENTRIES || bytes > MAX_BYTES) {
            const oldest = entries.shift()!;
            await unlink(join(this.directory, oldest.name));
            bytes -= oldest.size;
          }
          await atomicWriteFile(join(this.directory, name), json);
        },
        { path: join(this.directory, "write"), retries: 0 },
      );
    } catch {
      // Cache failures (including another writer) must not fail or retry a business operation.
    }
  }

  async remove(key: string): Promise<void> {
    await unlink(join(this.directory, filename(key))).catch(() => {});
  }
}

export const nativeMcpCatalogCache = new NativeMcpCatalogCache();
