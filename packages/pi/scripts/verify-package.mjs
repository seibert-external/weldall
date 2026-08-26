import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const packageDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliDir = resolve(packageDir, "../../apps/cli");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "weldall-pi-pack-"));

try {
  const packDirectory = join(temporaryDirectory, "pack");
  const installDirectory = join(temporaryDirectory, "install");
  mkdirSync(packDirectory);
  execFileSync("pnpm", ["pack", "--pack-destination", packDirectory], {
    cwd: packageDir,
    stdio: "inherit",
  });
  // @weldall/pi depends on the published @weldall/cli range. When the CLI is
  // bumped in the same release, its new version is not on the registry yet, so
  // pack the local CLI tarball and install it alongside the pi tarball instead
  // of resolving @weldall/cli from the registry.
  execFileSync("pnpm", ["pack", "--pack-destination", packDirectory], {
    cwd: cliDir,
    stdio: "inherit",
  });
  const tarballs = readdirSync(packDirectory)
    .filter((name) => name.endsWith(".tgz"))
    .sort()
    .map((name) => join(packDirectory, name));
  const piTarball = tarballs.find((name) => basename(name).includes("weldall-pi-"));
  const cliTarball = tarballs.find((name) => basename(name).includes("weldall-cli-"));
  const packedManifest = JSON.parse(
    execFileSync("tar", ["-xOzf", piTarball, "package/package.json"], { encoding: "utf8" }),
  );
  const cliManifest = JSON.parse(
    execFileSync("tar", ["-xOzf", cliTarball, "package/package.json"], { encoding: "utf8" }),
  );
  assert.equal(packedManifest.name, "@weldall/pi");
  assert.deepEqual(packedManifest.pi, { extensions: ["./dist/index.js"] });
  assert.equal(packedManifest.dependencies["@weldall/cli"], `^${cliManifest.version}`);

  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--omit=optional",
      "--omit=peer",
      "--prefix",
      installDirectory,
      cliTarball,
      piTarball,
    ],
    { stdio: "inherit" },
  );

  const installedPackage = join(installDirectory, "node_modules", "@weldall", "pi");
  const installedManifest = JSON.parse(
    readFileSync(join(installedPackage, "package.json"), "utf8"),
  );
  assert.deepEqual(installedManifest.pi, { extensions: ["./dist/index.js"] });
  const loaded = await discoverAndLoadExtensions(
    [installedPackage],
    installDirectory,
    join(temporaryDirectory, "agent"),
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert(loaded.extensions[0].commands.has("weldall-refresh"));
  console.log("Verified packed @weldall/pi installation and Pi extension loading");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
