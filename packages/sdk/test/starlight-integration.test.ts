import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { configureWeldallSearchRuntime, weldallSearch } from "../src/starlight/index.js";

let tempDirs: string[] = [];

async function write(relPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(relPath), { recursive: true });
  await writeFile(relPath, content);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("weldallSearch integration", () => {
  it("is a named Astro integration with config:setup and build:done hooks", () => {
    const integration = weldallSearch("https://weldall.example.com", {});
    expect(integration.name).toBe("@weldall/sdk/starlight");
    expect(integration.hooks?.["astro:config:setup"]).toBeTypeOf("function");
    expect(integration.hooks?.["astro:build:done"]).toBeTypeOf("function");
    expect(configureWeldallSearchRuntime).toBeTypeOf("function");
  });

  it("injects the search, metadata, and skills routes and writes the index", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sws-root-"));
    tempDirs.push(root);
    await write(
      path.join(root, "src/content/docs/index.md"),
      "---\ntitle: Start\n---\nDie Grundlagen der Seibert Group.\n",
    );

    const integration = weldallSearch("https://weldall.example.com", {
      contentDir: "src/content/docs",
      language: "german",
    });
    const patterns: string[] = [];
    const logger = { info: () => undefined, warn: () => undefined };

    await integration.hooks?.["astro:config:setup"]?.({
      config: {
        output: "server",
        root: pathToFileURL(`${root}/`),
        srcDir: pathToFileURL(`${root}/src/`),
      },
      injectRoute: (route: { pattern: string }) => patterns.push(route.pattern),
      logger: logger as never,
      updateConfig: () => ({}) as never,
      command: "build",
      isRestart: false,
    } as never);

    expect(patterns).toEqual([
      "/api/search",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/api",
      "/.well-known/weldall-skills",
    ]);
    const { readFile } = await import("node:fs/promises");
    const index = JSON.parse(await readFile(path.join(root, ".weldall-search/index.json"), "utf8"));
    expect(index.language).toBe("german");
    expect(index.raw).toBeTruthy();
  });

  it("derives the resource metadata route from the configured resource path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sws-resource-"));
    tempDirs.push(root);
    await write(path.join(root, "src/content/docs/index.md"), "---\ntitle: Start\n---\nHallo.\n");
    const integration = weldallSearch("https://weldall.example.com", {
      contentDir: "src/content/docs",
      resource: "https://docs.example.com/search",
    });
    const patterns: string[] = [];

    await integration.hooks?.["astro:config:setup"]?.({
      config: {
        output: "server",
        root: pathToFileURL(`${root}/`),
        srcDir: pathToFileURL(`${root}/src/`),
      },
      injectRoute: (route: { pattern: string }) => patterns.push(route.pattern),
      logger: { info: () => undefined } as never,
      updateConfig: () => ({}) as never,
      command: "build",
      isRestart: false,
    } as never);

    expect(patterns).toContain("/.well-known/oauth-protected-resource/search");
  });

  it("uses only the generic resource metadata route for origin resources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sws-origin-resource-"));
    tempDirs.push(root);
    await write(path.join(root, "src/content/docs/index.md"), "---\ntitle: Start\n---\nHallo.\n");
    const integration = weldallSearch("https://weldall.example.com", {
      contentDir: "src/content/docs",
      resource: "https://docs.example.com/",
    });
    const patterns: string[] = [];

    await integration.hooks?.["astro:config:setup"]?.({
      config: {
        output: "server",
        root: pathToFileURL(`${root}/`),
        srcDir: pathToFileURL(`${root}/src/`),
      },
      injectRoute: (route: { pattern: string }) => patterns.push(route.pattern),
      logger: { info: () => undefined } as never,
      updateConfig: () => ({}) as never,
      command: "build",
      isRestart: false,
    } as never);

    expect(
      patterns.filter((pattern) => pattern === "/.well-known/oauth-protected-resource"),
    ).toHaveLength(1);
  });

  it("normalizes routes and persists only deployable config values", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sws-root with spaces-"));
    tempDirs.push(root);
    await write(path.join(root, "src/content/docs/index.md"), "---\ntitle: Start\n---\nHallo.\n");
    const replayStore = { consume: async () => true };
    const signingKey = { kid: "secret", privateJwk: { kty: "EC" }, publicJwk: { kty: "EC" } };
    const integration = weldallSearch("https://weldall.example.com", {
      publicOrigin: "https://basics.seibert.tools",
      resource: "https://basics.seibert.tools/api",
      clientId: "starlight-basics",
      requiredScopes: ["search:read"],
      searchPath: "api/search/",
      signingKey,
      replayStore,
    } as never);
    const patterns: string[] = [];

    await integration.hooks?.["astro:config:setup"]?.({
      config: {
        output: "server",
        root: pathToFileURL(`${root}/`),
        srcDir: pathToFileURL(`${root}/src/`),
      },
      injectRoute: (route: { pattern: string }) => patterns.push(route.pattern),
      logger: { info: () => undefined } as never,
      updateConfig: () => ({}) as never,
      command: "build",
      isRestart: false,
    } as never);

    expect(patterns[0]).toBe("/api/search");
    const { readFile } = await import("node:fs/promises");
    const config = JSON.parse(
      await readFile(path.join(root, ".weldall-search/config.json"), "utf8"),
    );
    expect(config.searchPath).toBe("/api/search");
    expect(config.signingKey).toBeUndefined();
    expect(config.replayStore).toBeUndefined();
  });

  it("rejects dynamic skill loaders during setup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sws-loader-"));
    tempDirs.push(root);
    const integration = weldallSearch("https://weldall.example.com", {
      skills: { load: async () => [] },
    } as never);

    await expect(
      integration.hooks?.["astro:config:setup"]?.({
        config: {
          output: "server",
          root: pathToFileURL(`${root}/`),
        },
        injectRoute: () => undefined,
        logger: { info: () => undefined } as never,
      } as never),
    ).rejects.toThrow(/dynamic skill loaders/);
  });

  it("throws when the site is not configured for SSR", async () => {
    const integration = weldallSearch("https://weldall.example.com", {});
    await expect(
      integration.hooks?.["astro:config:setup"]?.({
        config: { output: "static" },
        injectRoute: () => undefined,
        logger: { info: () => undefined } as never,
      } as never),
    ).rejects.toThrow(/SSR/);
  });

  it("copies the index into the build output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sws-root2-"));
    tempDirs.push(root);
    const contentDir = path.join(root, "src/content/docs");
    await write(path.join(contentDir, "index.md"), "---\ntitle: Start\n---\nHallo Welt.\n");

    const integration = weldallSearch("https://weldall.example.com", {
      contentDir: "src/content/docs",
    });
    await integration.hooks?.["astro:config:setup"]?.({
      config: {
        output: "server",
        root: pathToFileURL(`${root}/`),
        srcDir: pathToFileURL(`${root}/src/`),
      },
      injectRoute: () => undefined,
      logger: { info: () => undefined } as never,
      updateConfig: () => ({}) as never,
      command: "build",
      isRestart: false,
    } as never);

    const dist = pathToFileURL(`${root}/dist/`);
    await integration.hooks?.["astro:build:done"]?.({
      dir: dist,
      logger: { info: () => undefined } as never,
    } as never);

    const { readFile } = await import("node:fs/promises");
    const copied = JSON.parse(
      await readFile(path.join(fileURLToPath(dist), ".weldall-search/index.json"), "utf8"),
    );
    expect(copied.language).toBe("german");
  });

  it("fails the build when generated artifacts cannot be copied", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sws-root3-"));
    tempDirs.push(root);
    await write(path.join(root, "src/content/docs/index.md"), "---\ntitle: Start\n---\nHallo Welt.\n");

    const integration = weldallSearch("https://weldall.example.com", {
      contentDir: "src/content/docs",
    });
    await integration.hooks?.["astro:config:setup"]?.({
      config: {
        output: "server",
        root: pathToFileURL(`${root}/`),
        srcDir: pathToFileURL(`${root}/src/`),
      },
      injectRoute: () => undefined,
      logger: { info: () => undefined } as never,
      updateConfig: () => ({}) as never,
      command: "build",
      isRestart: false,
    } as never);
    await rm(path.join(root, ".weldall-search/config.json"));

    await expect(
      integration.hooks?.["astro:build:done"]?.({
        dir: pathToFileURL(`${root}/dist/`),
        logger: { info: () => undefined } as never,
      } as never),
    ).rejects.toThrow(/config\.json/);
  });
});
