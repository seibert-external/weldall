import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateThirdPartyNotice } from "./generate-third-party-notices.mjs";
import { canonicalOutputDirectory } from "./output-paths.mjs";
import { archiveNameFor, getStandaloneTarget } from "./standalone-targets.mjs";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(cliRoot, "../..");
const fixedEpochSeconds = 946684800; // 2000-01-01T00:00:00Z
const fixedDosTime = 0;
const fixedDosDate = 0x2821;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function tarString(buffer, value, offset, length) {
  buffer.write(value, offset, Math.min(Buffer.byteLength(value), length), "utf8");
}

function tarOctal(buffer, value, offset, length) {
  tarString(buffer, `${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
}

function tarEntry(name, content, mode) {
  const header = Buffer.alloc(512);
  tarString(header, name, 0, 100);
  tarOctal(header, mode & 0o7777, 100, 8);
  tarOctal(header, 0, 108, 8);
  tarOctal(header, 0, 116, 8);
  tarOctal(header, content.length, 124, 12);
  tarOctal(header, fixedEpochSeconds, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  tarString(header, "ustar\0", 257, 6);
  tarString(header, "00", 263, 2);
  tarString(header, "root", 265, 32);
  tarString(header, "root", 297, 32);
  tarOctal(
    header,
    header.reduce((sum, byte) => sum + byte, 0),
    148,
    8,
  );
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipArchive(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(fixedDosTime, 10);
    localHeader.writeUInt16LE(fixedDosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(entry.content.length, 18);
    localHeader.writeUInt32LE(entry.content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    local.push(localHeader, name, entry.content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(fixedDosTime, 12);
    centralHeader.writeUInt16LE(fixedDosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(entry.content.length, 20);
    centralHeader.writeUInt32LE(entry.content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + entry.content.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuffer, end]);
}

export function createArchiveBuffer(format, entries) {
  if (format === "zip") return zipArchive(entries);
  if (format === "tar.gz") {
    const tar = Buffer.concat([
      ...entries.map((entry) => tarEntry(entry.name, entry.content, entry.mode)),
      Buffer.alloc(1024),
    ]);
    const gzip = gzipSync(tar, { level: 9, mtime: 0 });
    gzip[9] = 255;
    return gzip;
  }
  throw new Error(`Unsupported archive format ${format}`);
}

export function readArchiveEntries(format, archive) {
  const entries = new Map();
  if (format === "tar.gz") {
    const tar = gunzipSync(archive);
    let offset = 0;
    while (offset + 512 <= tar.length && tar[offset] !== 0) {
      const header = tar.subarray(offset, offset + 512);
      const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
      const size = Number.parseInt(
        header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(),
        8,
      );
      offset += 512;
      entries.set(name, tar.subarray(offset, offset + size));
      offset += Math.ceil(size / 512) * 512;
    }
    return entries;
  }
  if (format === "zip") {
    let offset = 0;
    while (archive.readUInt32LE(offset) === 0x04034b50) {
      const size = archive.readUInt32LE(offset + 18);
      const nameLength = archive.readUInt16LE(offset + 26);
      const extraLength = archive.readUInt16LE(offset + 28);
      const dataOffset = offset + 30 + nameLength + extraLength;
      const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
      entries.set(name, archive.subarray(dataOffset, dataOffset + size));
      offset = dataOffset + size;
    }
    return entries;
  }
  throw new Error(`Unsupported archive format ${format}`);
}

export async function validateArchiveInteroperability(path, format, entries, spawn = spawnSync) {
  const extractionRoot = await mkdtemp(join(tmpdir(), "weldall-archive-extract-"));
  try {
    const invocation =
      format === "tar.gz"
        ? {
            command: "tar",
            args: [
              ...(process.platform === "win32" ? ["--force-local"] : []),
              "-xzf",
              path,
              "-C",
              extractionRoot,
            ],
          }
        : process.platform === "win32"
          ? {
              command: "powershell.exe",
              args: [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "& { param($archive, $destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination }",
                path,
                extractionRoot,
              ],
            }
          : { command: "unzip", args: ["-qq", path, "-d", extractionRoot] };
    const result = spawn(invocation.command, invocation.args, { encoding: "utf8" });
    if (result.error?.code === "ENOENT")
      throw new Error(
        `${invocation.command} is required to independently extract ${path} on this runner`,
        { cause: result.error },
      );
    if (result.status !== 0)
      throw new Error(
        `${invocation.command} could not extract ${path}: ${result.stderr || result.stdout}`,
      );
    for (const entry of entries)
      assert.deepEqual(await readFile(join(extractionRoot, entry.name)), entry.content);
    return true;
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

export async function createStandaloneArchive({ target, version, executable, outputDirectory }) {
  const realOutput = await canonicalOutputDirectory(
    outputDirectory,
    repositoryRoot,
    "Archive output",
  );
  const entries = [
    { name: target.executableName, content: await readFile(executable), mode: 0o100755 },
    { name: "LICENSE", content: await readFile(join(cliRoot, "LICENSE")), mode: 0o100644 },
    {
      name: "README.md",
      content: await readFile(join(cliRoot, "STANDALONE_README.md")),
      mode: 0o100644,
    },
    {
      name: "THIRD_PARTY_NOTICES",
      content: Buffer.from(await generateThirdPartyNotice()),
      mode: 0o100644,
    },
  ];
  const archive = createArchiveBuffer(target.archiveFormat, entries);
  const path = join(realOutput, archiveNameFor(target, version));
  await writeFile(path, archive, { flag: "wx" });
  const decoded = readArchiveEntries(target.archiveFormat, await readFile(path));
  assert.deepEqual(
    [...decoded.keys()],
    entries.map(({ name }) => name),
  );
  for (const entry of entries) assert.deepEqual(decoded.get(entry.name), entry.content);
  await validateArchiveInteroperability(path, target.archiveFormat, entries);
  return path;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const target = getStandaloneTarget(argument("--target"));
  const version = argument("--version");
  const executable = argument("--executable");
  const outputDirectory = argument("--output-dir");
  if (!version || !executable || !outputDirectory)
    throw new Error(
      "Usage: node create-standalone-archive.mjs --target <id> --version <version> --executable <path> --output-dir <path>",
    );
  console.log(await createStandaloneArchive({ target, version, executable, outputDirectory }));
}
