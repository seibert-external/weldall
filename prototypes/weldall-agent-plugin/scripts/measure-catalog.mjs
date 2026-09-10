import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Drops the fields an agent never reads, keeping every field the outcome table branches on. */
export const trimCatalog = (payload) => ({
  warnings: payload.warnings,
  items: payload.items.map((item) => ({
    slug: item.slug,
    title: item.title,
    preview: item.preview,
    available: item.available,
    ...(item.missingScopes?.length ? { missingScopes: item.missingScopes } : {}),
    ...(item.meta?.tags === undefined ? {} : { tags: item.meta.tags }),
    source: item.source.type === "resource" ? item.source.name : "Weldall",
  })),
});

/** Bytes on the wire, and the usual four-bytes-per-token estimate over them. */
export const measure = (value) => {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  return { bytes, tokens: Math.ceil(bytes / 4) };
};

/**
 * An explicit directory resolves against the cwd, the caller's choice. The default must
 * not: it resolves against this script's own location, so the live catalog it writes
 * always lands in the plugin's own `measurements/` directory (matched by the repo's
 * `.gitignore`), no matter where the script was invoked from.
 */
export const resolveOutputDirectory = (argument) =>
  argument === undefined ? join(import.meta.dirname, "..", "measurements") : resolve(argument);

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const directory = resolveOutputDirectory(process.argv[2]);
  const { stdout } = await run("weldall", ["skills", "list", "--json"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const raw = JSON.parse(stdout);
  const trimmed = trimCatalog(raw);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "raw.json"), `${JSON.stringify(raw, null, 2)}\n`);
  await writeFile(join(directory, "trimmed.json"), `${JSON.stringify(trimmed, null, 2)}\n`);

  const before = measure(raw);
  const after = measure(trimmed);
  const saved = Math.round((1 - after.bytes / before.bytes) * 100);
  console.log(`items: ${raw.items.length}   warnings: ${raw.warnings.length}`);
  console.log("            bytes   ~tokens");
  console.log(`raw      ${String(before.bytes).padStart(8)}  ${String(before.tokens).padStart(8)}`);
  console.log(`trimmed  ${String(after.bytes).padStart(8)}  ${String(after.tokens).padStart(8)}`);
  console.log(`saved    ${String(before.bytes - after.bytes).padStart(8)}  ${saved}%`);
  console.log(`payloads written to ${directory}`);
}
