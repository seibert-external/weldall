import assert from "node:assert/strict";
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capturedLauncher } from "./process-launcher.mjs";
import { smokeNativeTerminal, terminalLauncher } from "./native-terminal.mjs";
import { verifyBinary } from "./binary-format.mjs";
import { runBlackBoxHarness } from "./black-box-harness.mjs";
import { getNativeStandaloneTarget, getStandaloneTarget } from "./standalone-targets.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(cliRoot, "package.json"), "utf8"));
const target = argument("--target")
  ? getStandaloneTarget(argument("--target"))
  : getNativeStandaloneTarget();
if (target.platform !== process.platform || target.arch !== process.arch)
  throw new Error(`Standalone smoke for ${target.id} must run on matching native hardware`);
const source = argument("--executable");
if (!source)
  throw new Error("Usage: node smoke-standalone.mjs --executable <path> [--target <id>]");

const expectedFormat =
  target.platform === "linux" ? "ELF" : target.platform === "win32" ? "PE" : "Mach-O";
await verifyBinary(resolve(source), { format: expectedFormat, arch: target.arch });

const root = await mkdtemp(join(tmpdir(), "weldall standalone copied ü "));
const copiedDirectory = join(root, "copy away from repository 日本語");
const hostileCwd = join(root, "hostile unrelated cwd ü");
const hostileBin = join(root, "empty path");
await mkdir(copiedDirectory, { recursive: true });
await mkdir(hostileCwd, { recursive: true });
await mkdir(hostileBin, { recursive: true });
const executable = join(copiedDirectory, target.executableName);
await copyFile(resolve(source), executable);
if (process.platform !== "win32") await chmod(executable, 0o755);
await writeFile(join(hostileCwd, ".env"), "WELDALL_TEST_DOTENV_SENTINEL=loaded\n");
await writeFile(
  join(hostileCwd, "bunfig.toml"),
  'preload = ["./preload.js"]\n[define]\n"process.env.WELDALL_TEST_BUNFIG_SENTINEL" = "\\"loaded\\""\n',
);
await writeFile(
  join(hostileCwd, "preload.js"),
  'process.env.WELDALL_TEST_BUNFIG_SENTINEL = "loaded";\n',
);

const baseEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      name !== "PATH" &&
      name !== "NODE_PATH" &&
      name !== "BUN_INSTALL" &&
      !name.toLowerCase().startsWith("npm_"),
  ),
);
baseEnvironment.PATH = hostileBin;

const launch = capturedLauncher(executable, [], { baseEnvironment });
const terminalLaunch = terminalLauncher(executable, [], { baseEnvironment });

try {
  await smokeNativeTerminal({
    launch: terminalLaunch,
    cwd: hostileCwd,
    label: `Standalone ${target.id}`,
  });
  const result = await runBlackBoxHarness({
    version: packageJson.version,
    launch,
    interruptLaunch: terminalLaunch,
    expectRuntime: "bun",
    expectSystemCa: true,
    keyringSmoke: true,
    keyringEnvironment:
      process.platform === "darwin"
        ? { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
        : {},
    hostileCwd,
    authenticated: true,
  });
  assert.equal(
    result.diagnostics.runtime.version,
    (await readFile(resolve(cliRoot, "../..", ".bun-version"), "utf8")).trim(),
  );
  console.log(`Copied standalone smoke passed: ${target.id} ${expectedFormat} ${target.arch}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
