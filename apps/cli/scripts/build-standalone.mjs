import { createRequire } from "node:module";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inkReactDevtoolsPlugin } from "./ink-react-devtools-plugin.mjs";
import { canonicalOutputDirectory } from "./output-paths.mjs";
import { packageInputsPlugin } from "./package-inputs-plugin.mjs";
import { getNativeStandaloneTarget, getStandaloneTarget } from "./standalone-targets.mjs";
import { assertNoTestHooksInArtifact, assertTestHooksInArtifact } from "./test-hook-artifact.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(cliRoot, "../..");
const require = createRequire(join(cliRoot, "package.json"));
const keyringRequire = createRequire(require.resolve("@napi-rs/keyring"));
const nativePackages = Object.keys(
  require("@napi-rs/keyring/package.json").optionalDependencies ?? {},
).filter((name) => name.startsWith("@napi-rs/keyring-"));

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function assertRunner(target) {
  if (target.platform !== process.platform || target.arch !== process.arch)
    throw new Error(
      `Refusing to cross-compile ${target.id} on ${process.platform}-${process.arch}; use ${target.runner}`,
    );
  if (process.env.GITHUB_ACTIONS === "true") {
    if (process.env.RUNNER_OS !== target.runnerOs || process.env.RUNNER_ARCH !== target.runnerArch)
      throw new Error(
        `Runner metadata ${process.env.RUNNER_OS}/${process.env.RUNNER_ARCH} does not match ${target.id}`,
      );
    if (process.env.WELDALL_RUNNER_LABEL !== target.runner)
      throw new Error(
        `WELDALL_RUNNER_LABEL must identify ${target.runner}; got ${process.env.WELDALL_RUNNER_LABEL ?? "unset"}`,
      );
  }
}

function assertNativeBinding(target) {
  const installed = nativePackages.filter((name) => {
    try {
      keyringRequire.resolve(`${name}/package.json`);
      return true;
    } catch (error) {
      if (error?.code === "MODULE_NOT_FOUND") return false;
      throw error;
    }
  });
  if (installed.length !== 1 || installed[0] !== target.nativeKeyringPackage)
    throw new Error(
      `Expected exactly ${target.nativeKeyringPackage}; found ${installed.length ? installed.join(", ") : "none"}`,
    );
  keyringRequire.resolve(target.nativeKeyringPackage);
}

const pinnedBunVersion = (await readFile(join(repositoryRoot, ".bun-version"), "utf8")).trim();
if (globalThis.Bun?.version !== pinnedBunVersion)
  throw new Error(
    `Bun ${pinnedBunVersion} is required; running ${globalThis.Bun?.version ?? "not Bun"}`,
  );

const testHooks = process.argv.includes("--test-hooks");
const targetArgument = argument("--target");
const target = targetArgument
  ? getStandaloneTarget(targetArgument)
  : getNativeStandaloneTarget(process.platform, process.arch);
const outputArgument = argument("--output-dir");
if (!outputArgument)
  throw new Error(
    "An explicit output directory outside the repository is required: --output-dir <path>",
  );
assertRunner(target);
assertNativeBinding(target);
const outputDirectory = await canonicalOutputDirectory(
  outputArgument,
  repositoryRoot,
  "Standalone output",
);

const packageJson = JSON.parse(await readFile(join(cliRoot, "package.json"), "utf8"));
const output = join(outputDirectory, target.executableName);
const intermediate = join(outputDirectory, ".bun-build");
const originalCwd = process.cwd();
await rm(output, { force: true });
await rm(intermediate, { recursive: true, force: true });
await mkdir(intermediate, { recursive: true });

try {
  process.chdir(intermediate);
  const result = await Bun.build({
    entrypoints: [join(cliRoot, "src", "index.ts")],
    target: "bun",
    define: { __WELDALL_TEST_BUILD__: String(testHooks) },
    minify: { syntax: true, identifiers: false, whitespace: false },
    sourcemap: "none",
    bytecode: false,
    plugins: [inkReactDevtoolsPlugin(), packageInputsPlugin(packageJson.version, "standalone")],
    compile: {
      outfile: output,
      execArgv: ["--use-system-ca"],
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });
  if (!result.success) throw new AggregateError(result.logs, `Bun failed to compile ${target.id}`);
} finally {
  process.chdir(originalCwd);
  await rm(intermediate, { recursive: true, force: true });
}

if (process.platform !== "win32") await chmod(output, 0o755);
if (testHooks) await assertTestHooksInArtifact(output);
else await assertNoTestHooksInArtifact(output);

// Bun's compile step keeps the signature of the bun executable it copies (Oven's Developer ID)
// on darwin-x64 and only re-signs ad hoc on darwin-arm64, where macOS requires a valid
// signature. A modified binary with a stale foreign signature has no usable code identity, so
// the keychain cannot bind items to it: a write succeeds, but the same process reads back
// null and cannot delete. Re-sign ad hoc on both macOS targets so the executable owns a valid
// identity. The release workflow replaces this with the Developer ID signature.
if (target.platform === "darwin") {
  const codesign = Bun.spawnSync(
    [
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "--identifier",
      "dev.seibert.weldall-cli",
      output,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (codesign.exitCode !== 0)
    throw new Error(
      `Ad-hoc code signing failed for ${target.id}: ${codesign.stderr.toString().trim()}`,
    );
  const verify = Bun.spawnSync(["/usr/bin/codesign", "--verify", "--strict", output], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (verify.exitCode !== 0)
    throw new Error(
      `Ad-hoc signature verification failed for ${target.id}: ${verify.stderr.toString().trim()}`,
    );
}

const versionRun = Bun.spawnSync([output, "--version"], {
  cwd: outputDirectory,
  env: { ...process.env, NODE_ENV: "production" },
  stdout: "pipe",
  stderr: "pipe",
});
const reportedVersion = versionRun.stdout.toString().trim();
if (versionRun.exitCode !== 0 || reportedVersion !== packageJson.version)
  throw new Error(
    `Built executable version mismatch: expected ${packageJson.version}, got ${JSON.stringify(reportedVersion)} (${versionRun.stderr.toString().trim()})`,
  );

console.log(
  `Built ${target.id} ${packageJson.version}${testHooks ? " with test hooks" : ""}: ${output}`,
);
