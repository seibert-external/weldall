export type InstallMode = "npm" | "standalone";

// Build-time constant, injected by the esbuild/Bun plugins (mirroring the
// package-version plugin): the npm package build bakes "npm" and the compiled
// standalone binaries bake "standalone". The npm default below only serves
// typecheck, dev, and test runs.
export const installMode: InstallMode = "npm";
