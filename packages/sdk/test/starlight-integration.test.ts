import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { weldallSearch } from "../src/starlight/index.js";

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
        root: new URL(`file://${root}/`),
        srcDir: new URL(`file://${root}/src/`),
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
        root: new URL(`file://${root}/`),
        srcDir: new URL(`file://${root}/src/`),
      },
      injectRoute: () => undefined,
      logger: { info: () => undefined } as never,
      updateConfig: () => ({}) as never,
      command: "build",
      isRestart: false,
    } as never);

    const dist = new URL(`file://${root}/dist/`);
    await integration.hooks?.["astro:build:done"]?.({
      dir: dist,
      logger: { info: () => undefined } as never,
    } as never);

    const { readFile } = await import("node:fs/promises");
    const copied = JSON.parse(
      await readFile(path.join(dist.pathname, ".weldall-search/index.json"), "utf8"),
    );
    expect(copied.language).toBe("german");
  });
});
