import { pathToFileURL } from "node:url";

export const standaloneTargets = Object.freeze([
  Object.freeze({
    id: "linux-x64",
    platform: "linux",
    arch: "x64",
    bunTarget: "bun-linux-x64-baseline",
    runner: "ubuntu-latest",
    runnerOs: "Linux",
    runnerArch: "X64",
    nativeKeyringPackage: "@napi-rs/keyring-linux-x64-gnu",
    executableName: "weldall",
    archiveFormat: "tar.gz",
    archiveName: "weldall-v{version}-linux-x64.tar.gz",
  }),
  Object.freeze({
    id: "windows-x64",
    platform: "win32",
    arch: "x64",
    bunTarget: "bun-windows-x64-baseline",
    runner: "windows-latest",
    runnerOs: "Windows",
    runnerArch: "X64",
    nativeKeyringPackage: "@napi-rs/keyring-win32-x64-msvc",
    executableName: "weldall.exe",
    archiveFormat: "zip",
    archiveName: "weldall-v{version}-windows-x64.zip",
  }),
  Object.freeze({
    id: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    bunTarget: "bun-darwin-arm64",
    runner: "macos-15",
    runnerOs: "macOS",
    runnerArch: "ARM64",
    nativeKeyringPackage: "@napi-rs/keyring-darwin-arm64",
    executableName: "weldall",
    archiveFormat: "tar.gz",
    archiveName: "weldall-v{version}-darwin-arm64.tar.gz",
  }),
  Object.freeze({
    id: "darwin-x64",
    platform: "darwin",
    arch: "x64",
    bunTarget: "bun-darwin-x64",
    runner: "macos-15-intel",
    runnerOs: "macOS",
    runnerArch: "X64",
    nativeKeyringPackage: "@napi-rs/keyring-darwin-x64",
    executableName: "weldall",
    archiveFormat: "tar.gz",
    archiveName: "weldall-v{version}-darwin-x64.tar.gz",
  }),
]);

export function getStandaloneTarget(id) {
  const target = standaloneTargets.find((candidate) => candidate.id === id);
  if (!target)
    throw new Error(
      `Unknown standalone target ${JSON.stringify(id)}; expected one of ${standaloneTargets
        .map(({ id: targetId }) => targetId)
        .join(", ")}`,
    );
  return target;
}

export function getNativeStandaloneTarget(platform = process.platform, arch = process.arch) {
  const target = standaloneTargets.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (!target) throw new Error(`No standalone target supports ${platform}-${arch}`);
  return target;
}

export function archiveNameFor(target, version) {
  const numeric = "(?:0|[1-9]\\d*)";
  const prereleaseIdentifier = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
  const buildIdentifier = "[0-9A-Za-z-]+";
  const semver = new RegExp(
    `^${numeric}\\.${numeric}\\.${numeric}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?(?:\\+${buildIdentifier}(?:\\.${buildIdentifier})*)?$`,
  );
  if (!semver.test(version)) throw new Error(`Invalid package version ${JSON.stringify(version)}`);
  return target.archiveName.replace("{version}", version);
}

export function githubMatrix(version) {
  return {
    include: standaloneTargets.map((target) => ({
      target: target.id,
      platform: target.platform,
      arch: target.arch,
      bunTarget: target.bunTarget,
      runner: target.runner,
      nativeKeyringPackage: target.nativeKeyringPackage,
      executableName: target.executableName,
      archiveName: archiveNameFor(target, version),
    })),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const versionIndex = process.argv.indexOf("--version");
  const version = versionIndex === -1 ? undefined : process.argv[versionIndex + 1];
  if (!version)
    throw new Error("Usage: node standalone-targets.mjs --github-matrix --version X.Y.Z");
  const output = githubMatrix(version);
  if (process.argv.includes("--github-matrix")) process.stdout.write(`${JSON.stringify(output)}\n`);
  else throw new Error("Expected --github-matrix");
}
