import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { packageInputsPlugin } from "../scripts/package-inputs-plugin.mjs";

interface CapturedHook {
  onResolve: Array<{
    filter: RegExp;
    callback: (args: { path: string }) => unknown;
  }>;
  onLoad: Array<{
    filter: RegExp;
    callback: () => { contents: string; loader: string };
  }>;
}

const capture = (version: string, installation: string): CapturedHook => {
  const captured: CapturedHook = { onResolve: [], onLoad: [] };
  packageInputsPlugin(version, installation).setup({
    onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => unknown) {
      captured.onResolve.push({ filter: options.filter, callback });
    },
    onLoad(options: { filter: RegExp }, callback: () => { contents: string; loader: string }) {
      captured.onLoad.push({ filter: options.filter, callback });
    },
  } as never);
  return captured;
};

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const bundledInstallMode = async (
  importPath: "./install-mode.js" | "../install-mode.js",
  installation: "npm" | "standalone",
) => {
  const result = await build({
    stdin: {
      contents: `import { installMode } from ${JSON.stringify(importPath)};
export default installMode;`,
      resolveDir: importPath.startsWith("../")
        ? join(cliRoot, "src", "storage")
        : join(cliRoot, "src"),
      sourcefile: "install-mode-entry.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins: [packageInputsPlugin("0.10.0", installation)],
  });
  const bundled = result.outputFiles[0]?.text;
  expect(bundled).toBeDefined();
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled!).toString("base64")}`;
  const module = (await import(moduleUrl)) as { default: string };
  return module.default;
};

describe("package inputs plugin install-mode selection", () => {
  it.each([
    ["./install-mode.js", "npm", "npm"],
    ["./install-mode.js", "standalone", "standalone"],
    ["../install-mode.js", "npm", "npm"],
    ["../install-mode.js", "standalone", "standalone"],
  ] as const)(
    "bakes %s as %s for bundled %s builds",
    async (importPath, installation, expected) => {
      await expect(bundledInstallMode(importPath, installation)).resolves.toBe(expected);
    },
  );

  it("keeps baking the package version and the SDK entry alongside the install mode", () => {
    const { onResolve, onLoad } = capture("9.8.7", "npm");
    const versionResolve = onResolve.find(({ filter }) => filter.test("../package.json"));
    expect(versionResolve?.callback({ path: "../package.json" })).toEqual({
      path: "package-version",
      namespace: "weldall",
    });
    const versionLoad = onLoad.find(({ filter }) => filter.test("package-version"));
    expect(versionLoad?.callback()).toEqual({
      contents: 'export default {"version":"9.8.7"};',
      loader: "js",
    });
    const sdkResolve = onResolve.find(({ filter }) => filter.test("@weldall/sdk"));
    const resolved = sdkResolve?.callback({ path: "@weldall/sdk" }) as { path: string };
    expect(resolved.path).toMatch(/packages[/\\]sdk[/\\]src[/\\]index\.ts$/);
  });
});
