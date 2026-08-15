import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MACH_CPU = new Map([
  [0x01000007, "x64"],
  [0x0100000c, "arm64"],
]);

export function inspectBinaryHeader(header) {
  if (!Buffer.isBuffer(header) || header.length < 64)
    throw new Error("Binary header must contain at least 64 bytes");

  if (header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    if (header[4] !== 2) throw new Error("Only 64-bit ELF executables are supported");
    const littleEndian = header[5] === 1;
    if (!littleEndian && header[5] !== 2) throw new Error("Invalid ELF byte order");
    const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18);
    if (machine !== 0x3e) throw new Error(`Unsupported ELF machine 0x${machine.toString(16)}`);
    return { format: "ELF", arch: "x64" };
  }

  if (header[0] === 0x4d && header[1] === 0x5a) {
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset + 6 > header.length)
      throw new Error(`PE header at ${peOffset} is outside the inspected header`);
    if (!header.subarray(peOffset, peOffset + 4).equals(Buffer.from("PE\0\0")))
      throw new Error("Invalid PE signature");
    const machine = header.readUInt16LE(peOffset + 4);
    if (machine !== 0x8664) throw new Error(`Unsupported PE machine 0x${machine.toString(16)}`);
    return { format: "PE", arch: "x64" };
  }

  const magic = header.readUInt32LE(0);
  if (magic === 0xfeedfacf) {
    const cpu = header.readUInt32LE(4);
    const arch = MACH_CPU.get(cpu);
    if (!arch) throw new Error(`Unsupported Mach-O CPU 0x${cpu.toString(16)}`);
    return { format: "Mach-O", arch };
  }
  if (header.readUInt32BE(0) === 0xfeedfacf) {
    const cpu = header.readUInt32BE(4);
    const arch = MACH_CPU.get(cpu);
    if (!arch) throw new Error(`Unsupported Mach-O CPU 0x${cpu.toString(16)}`);
    return { format: "Mach-O", arch };
  }

  throw new Error("Unrecognized executable format");
}

export async function inspectBinary(path) {
  const file = await open(path, "r");
  try {
    const initial = Buffer.alloc(64);
    const { bytesRead } = await file.read(initial, 0, initial.length, 0);
    if (bytesRead < 64) throw new Error(`${path} is too short to be an executable`);
    if (initial[0] === 0x4d && initial[1] === 0x5a) {
      const peOffset = initial.readUInt32LE(0x3c);
      if (peOffset + 6 > initial.length) {
        const extended = Buffer.alloc(peOffset + 6);
        const result = await file.read(extended, 0, extended.length, 0);
        if (result.bytesRead < extended.length)
          throw new Error(`${path} has a truncated PE header`);
        return inspectBinaryHeader(extended);
      }
    }
    return inspectBinaryHeader(initial);
  } finally {
    await file.close();
  }
}

export async function verifyBinary(path, expected) {
  const actual = await inspectBinary(path);
  assert.deepEqual(actual, expected, `${path} architecture mismatch`);
  return actual;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const path = process.argv[2];
  const format = process.argv[3];
  const arch = process.argv[4];
  if (!path || !format || !arch)
    throw new Error("Usage: node binary-format.mjs <executable> <ELF|PE|Mach-O> <x64|arm64>");
  const result = await verifyBinary(path, { format, arch });
  console.log(`${path}: ${result.format} ${result.arch}`);
}
