import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

export function resolveNpmInvocation(
  platform = process.platform,
  nodeExecutable = process.execPath,
  pathExists = existsSync,
) {
  if (platform !== "win32") return { command: "npm", prefix: [] };
  const path = win32.isAbsolute(nodeExecutable) ? win32 : posix;
  const executableDirectory = path.dirname(nodeExecutable);
  const candidates = [
    path.resolve(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const npmCli = candidates.find(pathExists);
  if (!npmCli)
    throw new Error(
      `Unable to locate setup-node's npm-cli.js relative to ${nodeExecutable}; checked ${candidates.join(", ")}`,
    );
  return { command: nodeExecutable, prefix: [npmCli] };
}
