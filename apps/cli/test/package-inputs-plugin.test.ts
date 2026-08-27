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

describe("package inputs plugin install-mode selection", () => {
  it("bakes the npm install mode for the npm package build", () => {
    const { onResolve, onLoad } = capture("0.10.0", "npm");
    const resolve = onResolve.find(({ filter }) => filter.test("./install-mode.js"));
    expect(resolve?.callback({ path: "./install-mode.js" })).toEqual({
      path: "install-mode",
      namespace: "weldall",
    });
    const load = onLoad.find(({ filter }) => filter.test("install-mode"));
    expect(load?.callback()).toEqual({
      contents: 'export const installMode = "npm";',
      loader: "js",
    });
  });

  it("bakes the standalone install mode for compiled binaries", () => {
    const { onLoad } = capture("0.10.0", "standalone");
    const load = onLoad.find(({ filter }) => filter.test("install-mode"));
    expect(load?.callback()).toEqual({
      contents: 'export const installMode = "standalone";',
      loader: "js",
    });
  });

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
