import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeMcpCatalogCache } from "../src/storage/native-mcp-cache.js";

let directory: string;
let cache: NativeMcpCatalogCache;
const catalog = { tools: [{ name: "read", _meta: { "weldall/scopes": ["read"] } }], resources: [] };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "weldall-native-cache-"));
  cache = new NativeMcpCatalogCache(directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it("persists across CLI instances and isolates cache keys", async () => {
  await cache.write("issuer/alice/resource/revision", catalog);
  expect(await new NativeMcpCatalogCache(directory).read("issuer/alice/resource/revision")).toEqual(
    catalog,
  );
  expect(await cache.read("issuer/bob/resource/revision")).toBeNull();
  expect(await cache.read("issuer/alice/resource/new-revision")).toBeNull();
  const names = await readdir(directory);
  expect(names).toHaveLength(1);
  const file = join(directory, names[0]!);
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await readFile(file, "utf8")).not.toContain("issuer/alice");
});
it("expires after five minutes without extending freshness on reads", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await cache.write("key", catalog);
  now += 299_999;
  expect(await cache.read("key")).toEqual(catalog);
  now++;
  expect(await cache.read("key")).toBeNull();
  now -= 300_001;
  expect(await cache.read("key")).toBeNull();
});
it("ignores corrupt and oversized records and allows explicit invalidation", async () => {
  await cache.write("key", catalog);
  const file = join(directory, (await readdir(directory))[0]!);
  await writeFile(file, "broken");
  expect(await cache.read("key")).toBeNull();
  await writeFile(file, "x".repeat(2 * 1024 * 1024));
  expect(await cache.read("key")).toBeNull();
  await cache.write("key", catalog);
  await cache.remove("key");
  expect(await cache.read("key")).toBeNull();
});
it("evicts least recently used entries at 128 files", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  for (let i = 0; i < 128; i++) await cache.write(`key${i}`, catalog);
  now += 10_000;
  await cache.read("key0");
  await cache.write("new", catalog);
  expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toHaveLength(128);
  expect(await cache.read("key0")).toEqual(catalog);
  expect(await cache.read("new")).toEqual(catalog);
});
it("bounds total disk storage and skips oversized catalogs", async () => {
  for (let i = 0; i < 18; i++)
    await cache.write(`large${i}`, { text: "x".repeat(1024 * 1024 - 1024) });
  await cache.write("oversized", { text: "x".repeat(2 * 1024 * 1024) });
  expect(await cache.read("oversized")).toBeNull();
  const files = await readdir(directory);
  const sizes = await Promise.all(
    files.map(async (name) => (await stat(join(directory, name))).size),
  );
  expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(16 * 1024 * 1024);
});
it("keeps concurrent cache writes optional and leaves no temporary files", async () => {
  await Promise.all(Array.from({ length: 8 }, (_, i) => cache.write(`key${i}`, catalog)));
  const files = await readdir(directory);
  expect(files.length).toBeGreaterThan(0);
  expect(files.every((name) => /^[a-f0-9]{64}\.json$/.test(name))).toBe(true);
});
