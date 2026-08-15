import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runBlackBoxHarness } from "./black-box-harness.mjs";
import { readPackedManifest } from "./packed-manifest.mjs";
import { smokeNativeTerminal, terminalLauncher } from "./native-terminal.mjs";
import { resolveNpmInvocation } from "./npm-invocation.mjs";
import { resolvePnpmInvocation } from "./pnpm-invocation.mjs";
import { capturedLauncher } from "./process-launcher.mjs";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function tool(command, args, options) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8", windowsHide: true });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

function quoteCmdArgument(value) {
  if (value.includes('"')) throw new Error("The packed smoke cmd launcher does not accept quotes");
  return `"${value}"`;
}

function windowsCmdLauncher(path) {
  return (args, options) => {
    // /s requires one outer quote pair around a quoted command path. Passing the
    // command line verbatim prevents Node from escaping those quotes into literals.
    const commandLine = `"${[path, ...args].map(quoteCmdArgument).join(" ")}"`;
    return capturedLauncher(process.env.ComSpec ?? "cmd.exe", ["/d", "/v:off", "/s", "/c"], {
      windowsVerbatimArguments: true,
    })([commandLine], options);
  };
}

async function packArtifact(root, pnpm) {
  const packDirectory = join(root, "actual pnpm publication pack");
  await mkdir(packDirectory, { recursive: true });
  const packed = JSON.parse(
    tool(pnpm.command, [...pnpm.prefix, "pack", "--json", "--pack-destination", packDirectory], {
      cwd: cliRoot,
    }).stdout,
  );
  const tarball = packed.filename;
  assert.equal(dirname(tarball), packDirectory);
  readPackedManifest(tarball);
  return tarball;
}

async function installLocal(root, name, omitOptional, npm, tarball) {
  const consumer = join(root, `consumer ${name} 日本語`);
  await mkdir(consumer, { recursive: true });
  await writeFile(join(consumer, "package.json"), `${JSON.stringify({ private: true })}\n`);
  const args = ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
  if (omitOptional) args.push("--omit=optional");
  args.push(tarball);
  tool(npm.command, [...npm.prefix, ...args], { cwd: consumer });
  return consumer;
}

const powershellPrefix = (script) => [
  "-NoLogo",
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  script,
];

function launchersFor(binDirectory) {
  return process.platform === "win32"
    ? [
        ["cmd", windowsCmdLauncher(join(binDirectory, "weldall.cmd"))],
        [
          "PowerShell",
          capturedLauncher("powershell.exe", [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            join(binDirectory, "weldall.ps1"),
          ]),
        ],
      ]
    : [["POSIX", capturedLauncher(join(binDirectory, "weldall"))]];
}

function terminalLauncherFor(binDirectory) {
  return process.platform === "win32"
    ? terminalLauncher("powershell.exe", powershellPrefix(join(binDirectory, "weldall.ps1")))
    : terminalLauncher(join(binDirectory, "weldall"));
}

async function main() {
  const packageJson = JSON.parse(await readFile(join(cliRoot, "package.json"), "utf8"));
  const npm = resolveNpmInvocation();
  const pnpm = resolvePnpmInvocation();
  const root = await mkdtemp(join(tmpdir(), "weldall packed smoke ü "));
  try {
    const tarball = await packArtifact(root, pnpm);
    assert.match(tarball, /\.tgz$/);
    for (const [name, omitOptional] of [
      ["normal", false],
      ["omit optional", true],
    ]) {
      const consumer = await installLocal(root, name, omitOptional, npm, tarball);
      const binDirectory = join(consumer, "node_modules", ".bin");
      const launchers = launchersFor(binDirectory);
      const terminalLaunch = terminalLauncherFor(binDirectory);
      if (!omitOptional)
        await smokeNativeTerminal({
          launch: terminalLaunch,
          cwd: consumer,
          label: "Packed npm CLI",
        });

      for (const [index, [shim, launch]] of launchers.entries()) {
        await runBlackBoxHarness({
          version: packageJson.version,
          launch,
          interruptLaunch: terminalLaunch,
          expectRuntime: "node",
          expectSystemCa: true,
          authenticated: !omitOptional && index === 0,
        });
        console.log(`${shim} full black-box harness passed (${name})`);
      }

      const secureStoreLaunch = launchers[0][1];
      const secureStoreEnvironment = omitOptional
        ? { WELDALL_TEST_KEYCHAIN_GET: "https://missing-keyring.example.com" }
        : { WELDALL_TEST_KEYRING_SMOKE: randomUUID().replaceAll("-", "") };
      const secureStore = await secureStoreLaunch([], {
        cwd: consumer,
        env: { NODE_ENV: "test", ...secureStoreEnvironment },
      });
      if (omitOptional) {
        assert.equal(secureStore.status, 1, secureStore.stderr);
        assert.match(
          secureStore.stderr,
          /Unable to read the Weldall session from the secure credential store/,
        );
        assert.match(secureStore.stderr, /Install the optional @napi-rs\/keyring dependency/);
      } else {
        assert.equal(secureStore.status, 0, secureStore.stderr);
        assert.equal(JSON.parse(secureStore.stdout).keyringRoundTrip, true);
      }
    }

    const globalPrefix = join(root, "global npm prefix 日本語");
    await mkdir(globalPrefix, { recursive: true });
    tool(
      npm.command,
      [
        ...npm.prefix,
        "install",
        "--global",
        "--prefix",
        globalPrefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      { cwd: root },
    );
    const globalBin = process.platform === "win32" ? globalPrefix : join(globalPrefix, "bin");
    for (const [shim, launch] of launchersFor(globalBin)) {
      await runBlackBoxHarness({
        version: packageJson.version,
        launch,
        expectRuntime: "node",
        expectSystemCa: true,
      });
      console.log(`${shim} full black-box harness passed (global --prefix install)`);
    }
    console.log(
      "pnpm publication-fidelity packed npm smoke passed for local normal/omit-optional and global-prefix installs",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
