import { fileURLToPath } from "node:url";

const sdkEntry = fileURLToPath(new URL("../../../packages/sdk/src/index.ts", import.meta.url));

// Injects build-time constants for the CLI bundle: the package version (baked
// where the source imports ../package.json) and the install mode (baked where
// the source imports ./install-mode.js). Both are also resolved as real files
// so typecheck, dev, and tests keep working; only the compiled artifacts use
// the injected values.
export function packageInputsPlugin(version, installation) {
  return {
    name: "weldall-package-inputs",
    setup(build) {
      build.onResolve({ filter: /^@weldall\/sdk$/ }, () => ({ path: sdkEntry }));
      build.onResolve({ filter: /^\.\.\/package\.json$/ }, () => ({
        path: "package-version",
        namespace: "weldall",
      }));
      build.onLoad({ filter: /^package-version$/, namespace: "weldall" }, () => ({
        contents: `export default ${JSON.stringify({ version })};`,
        loader: "js",
      }));
      build.onResolve({ filter: /^\.\/install-mode\.js$/ }, () => ({
        path: "install-mode",
        namespace: "weldall",
      }));
      build.onLoad({ filter: /^install-mode$/, namespace: "weldall" }, () => ({
        contents: `export const installMode = ${JSON.stringify(installation)};`,
        loader: "js",
      }));
    },
  };
}
