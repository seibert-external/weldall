import { existsSync } from "node:fs";
import { win32 } from "node:path";

export function resolveNpmInvocation(
  platform = process.platform,
  nodeExecutable = process.execPath,
  pathExists = existsSync,
) {
  if (platform !== "win32") return { command: "npm", prefix: [] };
  const executableDirectory = win32.dirname(nodeExecutable);
  const candidates = [
    win32.resolve(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    win32.resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const npmCli = candidates.find(pathExists);
  if (!npmCli)
    throw new Error(
      `Unable to locate setup-node's npm-cli.js relative to ${nodeExecutable}; checked ${candidates.join(", ")}`,
    );
  return { command: nodeExecutable, prefix: [npmCli] };
}
