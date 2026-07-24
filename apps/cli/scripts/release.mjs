import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import packageJson from "../package.json" with { type: "json" };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist", "release");
const targets = [
  { artifact: "darwin-arm64", bun: "bun-darwin-arm64" },
  { artifact: "darwin-x64", bun: "bun-darwin-x64-baseline" },
];

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)),
    );
  });

const cleanBunTemporaryFiles = async () =>
  Promise.all(
    (await readdir(root))
      .filter((name) => name.startsWith(".") && name.endsWith(".bun-build"))
      .map((name) => rm(join(root, name), { force: true })),
  );

if (process.platform !== "darwin") throw new Error("Weldall releases must be built on macOS");

try {
  await run("pnpm", ["typecheck"]);
  await run("pnpm", ["test"]);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  const archives = [];
  for (const target of targets) {
    const name = `weldall-v${packageJson.version}-${target.artifact}`;
    const directory = join(output, name);
    const executable = join(directory, "weldall");
    await mkdir(directory, { recursive: true });
    await run("bun", [
      "build",
      "--compile",
      `--target=${target.bun}`,
      `--outfile=${executable}`,
      "src/index.ts",
    ]);
    await chmod(executable, 0o755);
    await run("codesign", [
      "--force",
      "--sign",
      process.env.WELDALL_CODESIGN_IDENTITY ?? "-",
      executable,
    ]);
    await run("codesign", ["--verify", "--strict", executable]);
    const archive = `${name}.tar.gz`;
    await run("tar", ["-czf", join(output, archive), "-C", output, name]);
    archives.push(archive);
  }

  const checksums = [];
  for (const archive of archives) {
    const digest = createHash("sha256")
      .update(await readFile(join(output, archive)))
      .digest("hex");
    checksums.push(`${digest}  ${archive}`);
  }
  await writeFile(join(output, "SHA256SUMS"), `${checksums.join("\n")}\n`);
  console.log(`Release artifacts written to ${output}`);
} finally {
  await cleanBunTemporaryFiles();
}
