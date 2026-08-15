import { existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export function resolvePnpmInvocation(
  environment = process.env,
  nodeExecutable = process.execPath,
  pathExists = existsSync,
) {
  const version = /(?:^|\s)pnpm\/([^\s]+)/.exec(environment.npm_config_user_agent ?? "")?.[1];
  const pathDirectories = (environment.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = [
    environment.npm_execpath,
    environment._,
    ...(environment.PNPM_HOME && version
      ? [join(environment.PNPM_HOME, ".tools", "pnpm", version, "bin", "pnpm.cjs")]
      : []),
    ...pathDirectories.flatMap((directory) => [
      join(directory, "pnpm.cjs"),
      join(directory, "pnpm.js"),
      resolve(directory, "..", "pnpm", "bin", "pnpm.cjs"),
      resolve(directory, "..", "lib", "node_modules", "corepack", "dist", "pnpm.js"),
    ]),
    resolve(dirname(nodeExecutable), "node_modules", "corepack", "dist", "pnpm.js"),
    resolve(dirname(nodeExecutable), "..", "lib", "node_modules", "corepack", "dist", "pnpm.js"),
  ].filter(
    (candidate) =>
      typeof candidate === "string" &&
      isAbsolute(candidate) &&
      /(?:^|[/\\])pnpm(?:\.c?js)?$/i.test(candidate),
  );
  const pnpmScript = candidates.find(pathExists);
  if (!pnpmScript)
    throw new Error(
      `Unable to locate pnpm's JavaScript entrypoint; checked ${candidates.join(", ")}`,
    );
  return { command: nodeExecutable, prefix: [pnpmScript] };
}
