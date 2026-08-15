import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectBinaryHeader } from "../scripts/binary-format.mjs";
import { findPackageDebris } from "../scripts/assert-no-package-debris.mjs";
import {
  createArchiveBuffer,
  readArchiveEntries,
  validateArchiveInteroperability,
} from "../scripts/create-standalone-archive.mjs";
import { verifySha256Sums, writeSha256Sums } from "../scripts/checksums.mjs";
import { generateThirdPartyNotice } from "../scripts/generate-third-party-notices.mjs";
import { canonicalOutputDirectory } from "../scripts/output-paths.mjs";
import { assertPublishableManifest } from "../scripts/packed-manifest.mjs";
import { resolveNpmInvocation } from "../scripts/npm-invocation.mjs";
import { resolvePnpmInvocation } from "../scripts/pnpm-invocation.mjs";
import { terminateProcessTree } from "../scripts/process-launcher.mjs";
import {
  archiveNameFor,
  getNativeStandaloneTarget,
  getStandaloneTarget,
  githubMatrix,
} from "../scripts/standalone-targets.mjs";
import {
  inkReactDevtoolsPlugin,
  reactDevtoolsNoopModule,
} from "../scripts/ink-react-devtools-plugin.mjs";

describe("standalone target descriptor", () => {
  it("looks up every supported native target and emits the GitHub matrix", () => {
    expect(getNativeStandaloneTarget("linux", "x64").id).toBe("linux-x64");
    expect(getNativeStandaloneTarget("win32", "x64").nativeKeyringPackage).toBe(
      "@napi-rs/keyring-win32-x64-msvc",
    );
    expect(getNativeStandaloneTarget("darwin", "arm64").runner).toBe("macos-15");
    expect(getNativeStandaloneTarget("darwin", "x64").runner).toBe("macos-15-intel");
    expect(() => getNativeStandaloneTarget("linux", "arm64")).toThrow(/No standalone target/);
    expect(() => getStandaloneTarget("windows-arm64")).toThrow(/Unknown standalone target/);

    const matrix = githubMatrix("1.2.3");
    expect(matrix.include).toHaveLength(4);
    expect(matrix.include.map(({ archiveName }) => archiveName)).toEqual([
      "weldall-v1.2.3-linux-x64.tar.gz",
      "weldall-v1.2.3-windows-x64.zip",
      "weldall-v1.2.3-darwin-arm64.tar.gz",
      "weldall-v1.2.3-darwin-x64.tar.gz",
    ]);
    for (const malformed of [
      "bad/version",
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2.3-",
      "1.2.3-alpha..1",
      "1.2.3-01",
      "1.2.3+build..1",
      "1.2.3+bad_thing",
    ])
      expect(() => archiveNameFor(getStandaloneTarget("linux-x64"), malformed)).toThrow(
        /Invalid package version/,
      );
    expect(archiveNameFor(getStandaloneTarget("linux-x64"), "1.2.3-alpha.1+build.5")).toBe(
      "weldall-v1.2.3-alpha.1+build.5-linux-x64.tar.gz",
    );
  });
});

describe("Ink optional peer plugin", () => {
  it("resolves only react-devtools-core to an inert default object", async () => {
    let resolveFilter: RegExp | undefined;
    let resolveCallback: ((args: { path: string }) => unknown) | undefined;
    let loadFilter: RegExp | undefined;
    let loadCallback: (() => { contents: string; loader: string }) | undefined;
    inkReactDevtoolsPlugin().setup({
      onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => unknown) {
        resolveFilter = options.filter;
        resolveCallback = callback;
      },
      onLoad(options: { filter: RegExp }, callback: () => { contents: string; loader: string }) {
        loadFilter = options.filter;
        loadCallback = callback;
      },
    } as never);

    expect(resolveFilter?.test("react-devtools-core")).toBe(true);
    expect(resolveFilter?.test("react")).toBe(false);
    expect(resolveCallback?.({ path: "react-devtools-core" })).toEqual({
      path: "react-devtools-core",
      namespace: "weldall-ink-noop",
    });
    expect(loadFilter?.test("react-devtools-core")).toBe(true);
    expect(loadCallback?.()).toEqual({ contents: reactDevtoolsNoopModule, loader: "js" });

    const moduleUrl = `data:text/javascript,${encodeURIComponent(reactDevtoolsNoopModule)}`;
    const loaded = await import(moduleUrl);
    expect(Object.keys(loaded.default).sort()).toEqual(["connectToDevTools", "initialize"]);
    expect(loaded.default.initialize()).toBeUndefined();
    expect(loaded.default.connectToDevTools()).toBeUndefined();
  });
});

describe("deterministic release utilities", () => {
  it("creates stable tar.gz and zip content with consistent metadata", () => {
    const entries = [
      { name: "weldall", content: Buffer.from("binary"), mode: 0o100755 },
      { name: "README.md", content: Buffer.from("readme"), mode: 0o100644 },
    ];
    for (const format of ["tar.gz", "zip"] as const) {
      const first = createArchiveBuffer(format, entries);
      expect(createArchiveBuffer(format, entries)).toEqual(first);
      expect(Object.fromEntries(readArchiveEntries(format, first))).toEqual({
        weldall: Buffer.from("binary"),
        "README.md": Buffer.from("readme"),
      });
    }

    const tar = gunzipSync(createArchiveBuffer("tar.gz", entries));
    expect(tar.subarray(100, 108).toString("ascii").replace(/\0.*$/, "")).toBe("0000755");
    const zip = createArchiveBuffer("zip", entries);
    expect(zip.readUInt16LE(10)).toBe(
      zip.readUInt16LE(zip.indexOf("PK\x01\x02", 0, "binary") + 12),
    );
    expect(zip.readUInt16LE(12)).toBe(
      zip.readUInt16LE(zip.indexOf("PK\x01\x02", 0, "binary") + 14),
    );
  });

  it("extracts tar and zip archives with a required independent system tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-extractor-"));
    const entries = [{ name: "README.md", content: Buffer.from("portable"), mode: 0o100644 }];
    try {
      for (const format of ["tar.gz", "zip"] as const) {
        const path = join(root, `archive.${format}`);
        await writeFile(path, createArchiveBuffer(format, entries));
        await expect(validateArchiveInteroperability(path, format, entries)).resolves.toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the independent system extractor is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-missing-extractor-"));
    const path = join(root, "archive.tar.gz");
    const entries = [{ name: "README.md", content: Buffer.from("portable"), mode: 0o100644 }];
    try {
      await writeFile(path, createArchiveBuffer("tar.gz", entries));
      await expect(
        validateArchiveInteroperability(path, "tar.gz", entries, () => ({
          error: Object.assign(new Error("missing"), { code: "ENOENT" }),
        })),
      ).rejects.toThrow(/tar is required to independently extract/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes and verifies sorted SHA256SUMS", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-checksums-"));
    try {
      const first = join(root, "b.zip");
      const second = join(root, "a.tar.gz");
      const sums = join(root, "SHA256SUMS");
      await writeFile(first, "b");
      await writeFile(second, "a");
      await writeSha256Sums([first, second], sums);
      expect(await verifySha256Sums(sums)).toEqual(["a.tar.gz", "b.zip"]);
      expect(await readFile(sums, "utf8")).toMatch(
        /^[0-9a-f]{64}  a\.tar\.gz\n[0-9a-f]{64}  b\.zip\n$/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("canonicalizes output parents and rejects a symlink into the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-output-path-"));
    const repository = join(root, "repository");
    const outside = join(root, "outside");
    await mkdir(repository);
    await mkdir(outside);
    const intoRepository = join(outside, "into-repository");
    await symlink(repository, intoRepository, process.platform === "win32" ? "junction" : "dir");
    try {
      await expect(
        canonicalOutputDirectory(intoRepository, repository, "Test output"),
      ).rejects.toThrow(/outside the repository/);
      await expect(canonicalOutputDirectory(outside, repository, "Test output")).resolves.toMatch(
        /[/\\]outside$/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("generates the committed exact production notices deterministically", async () => {
    const generated = await generateThirdPartyNotice();
    expect(await generateThirdPartyNotice()).toBe(generated);
    expect(
      (await readFile(join(import.meta.dirname, "..", "THIRD_PARTY_NOTICES"), "utf8")).replace(
        /\r\n?/g,
        "\n",
      ),
    ).toBe(generated);
    expect(generated).toContain("@napi-rs/keyring@1.3.0");
    expect(generated).toContain("Bun 1.3.14");
    expect(generated).toContain("Bun itself is MIT-licensed.");
  });

  it("finds ignored packaging debris inside workspace dist while skipping only caches", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-debris-"));
    try {
      await mkdir(join(root, ".bun-build"));
      await writeFile(join(root, ".bun-build", "ignored.bin"), "debris");
      const dist = join(root, "apps", "cli", "dist");
      await mkdir(join(dist, ".bun-build"), { recursive: true });
      await mkdir(join(dist, ".cache"));
      await writeFile(join(dist, ".bun-build", "ignored.bin"), "debris");
      await writeFile(join(dist, "release.zip"), "archive debris");
      await writeFile(join(dist, "weldall"), "binary debris");
      await writeFile(join(dist, ".cache", "cached.zip"), "ignored cache");
      await writeFile(join(dist, "index.js"), "normal build output");
      await writeFile(join(root, ".gitignore"), ".bun-build/\napps/cli/dist/\n");
      expect(await findPackageDebris(root)).toEqual([
        ".bun-build",
        "apps/cli/dist/.bun-build",
        "apps/cli/dist/release.zip",
        "apps/cli/dist/weldall",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("terminates a Windows process tree with absolute System32 taskkill exactly once", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });
    const invocations: Array<{ command: string; args: string[] }> = [];
    const spawnProcess = (command: string, args: string[]) => {
      invocations.push({ command, args });
      const killer = new EventEmitter();
      queueMicrotask(() => {
        killer.emit("close", 0);
        child.signalCode = "SIGKILL";
        child.emit("close", null, "SIGKILL");
      });
      return killer;
    };

    const first = terminateProcessTree(child as never, {
      platform: "win32",
      systemRoot: "C:\\Windows",
      spawnProcess: spawnProcess as never,
    });
    const second = terminateProcessTree(child as never, {
      platform: "win32",
      spawnProcess: spawnProcess as never,
    });
    expect(second).toBe(first);
    await first;
    expect(invocations).toEqual([
      {
        command: "C:\\Windows\\System32\\taskkill.exe",
        args: ["/PID", "4242", "/T", "/F"],
      },
    ]);
  });

  it("resolves npm directly on POSIX and through npm-cli.js on Windows", () => {
    expect(resolveNpmInvocation("linux", "/setup/node", () => false)).toEqual({
      command: "npm",
      prefix: [],
    });
    expect(
      resolveNpmInvocation("win32", "D:\\setup\\node.exe", (path) =>
        path.endsWith("\\node_modules\\npm\\bin\\npm-cli.js"),
      ),
    ).toEqual({
      command: "D:\\setup\\node.exe",
      prefix: ["D:\\setup\\node_modules\\npm\\bin\\npm-cli.js"],
    });
    expect(() => resolveNpmInvocation("win32", "D:\\setup\\node.exe", () => false)).toThrow(
      /Unable to locate setup-node's npm-cli\.js/,
    );
  });

  it("runs publication-fidelity packing through pnpm's JavaScript entrypoint", () => {
    expect(
      resolvePnpmInvocation(
        { npm_execpath: "/tools/pnpm/bin/pnpm.cjs" },
        "/node/bin/node",
        (path) => path === "/tools/pnpm/bin/pnpm.cjs",
      ),
    ).toEqual({
      command: "/node/bin/node",
      prefix: ["/tools/pnpm/bin/pnpm.cjs"],
    });
    expect(() => resolvePnpmInvocation({}, "/node/bin/node", () => false)).toThrow(
      /JavaScript entrypoint/,
    );
    expect(() =>
      resolvePnpmInvocation(
        { npm_execpath: "/tools/npm/bin/npm-cli.js" },
        "/node/bin/node",
        () => false,
      ),
    ).toThrow(/JavaScript entrypoint/);
  });

  it("rejects repository-local protocols from every packed dependency section", () => {
    const manifest = {
      name: "@weldall/cli",
      os: ["darwin", "linux", "win32"],
      dependencies: { production: "1.0.0" },
      devDependencies: { development: "2.0.0" },
      optionalDependencies: { optional: "3.0.0" },
      peerDependencies: { peer: "4.0.0" },
    };
    expect(assertPublishableManifest(manifest)).toBe(manifest);
    for (const [section, protocol] of [
      ["dependencies", "workspace:*"],
      ["devDependencies", "catalog:"],
      ["optionalDependencies", "file:../local"],
      ["peerDependencies", "link:../local"],
    ] as const) {
      expect(() =>
        assertPublishableManifest({
          ...manifest,
          [section]: { ...manifest[section], invalid: protocol },
        }),
      ).toThrow(new RegExp(section));
    }
  });
});

describe("portable executable inspection", () => {
  it("recognizes ELF x64, PE x64, and both supported Mach-O CPUs", () => {
    const elf = Buffer.alloc(64);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(elf);
    elf[4] = 2;
    elf[5] = 1;
    elf.writeUInt16LE(0x3e, 18);
    expect(inspectBinaryHeader(elf)).toEqual({ format: "ELF", arch: "x64" });

    const pe = Buffer.alloc(128);
    pe.write("MZ");
    pe.writeUInt32LE(64, 0x3c);
    pe.write("PE\0\0", 64, "binary");
    pe.writeUInt16LE(0x8664, 68);
    expect(inspectBinaryHeader(pe)).toEqual({ format: "PE", arch: "x64" });

    for (const [cpu, arch] of [
      [0x0100000c, "arm64"],
      [0x01000007, "x64"],
    ] as const) {
      const macho = Buffer.alloc(64);
      macho.writeUInt32LE(0xfeedfacf, 0);
      macho.writeUInt32LE(cpu, 4);
      expect(inspectBinaryHeader(macho)).toEqual({ format: "Mach-O", arch });
    }
  });

  it("rejects unsupported architectures and unknown data", () => {
    const elf = Buffer.alloc(64);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(elf);
    elf[4] = 2;
    elf[5] = 1;
    elf.writeUInt16LE(0xb7, 18);
    expect(() => inspectBinaryHeader(elf)).toThrow(/Unsupported ELF machine/);
    expect(() => inspectBinaryHeader(Buffer.alloc(64))).toThrow(/Unrecognized/);
  });
});
