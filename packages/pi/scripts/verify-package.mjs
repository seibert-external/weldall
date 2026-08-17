import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const packageDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "weldall-pi-pack-"));

try {
  const packDirectory = join(temporaryDirectory, "pack");
  const installDirectory = join(temporaryDirectory, "install");
  mkdirSync(packDirectory);
  execFileSync("pnpm", ["pack", "--pack-destination", packDirectory], {
    cwd: packageDir,
    stdio: "inherit",
  });
  const tarball = join(
    packDirectory,
    readdirSync(packDirectory).find((name) => name.endsWith(".tgz")),
  );
  const packedManifest = JSON.parse(
    execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }),
  );
  assert.equal(packedManifest.name, "@weldall/pi");
  assert.deepEqual(packedManifest.pi, { extensions: ["./dist/index.js"] });
  assert.equal(packedManifest.dependencies["@weldall/cli"], "^0.9.0");

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
      tarball,
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
