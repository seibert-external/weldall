import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig } from "../src/starlight/runtime.js";
import { buildSearchSkill } from "../src/starlight/skill.js";

let tempDirs: string[] = [];

async function withIndexDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sws-cfg-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

const identity = {
  issuer: "https://weldall.example.com",
  resource: "https://basics.seibert.tools/api",
  publicOrigin: "https://basics.seibert.tools",
  clientId: "starlight-basics",
  requiredScopes: ["search:read"],
};

let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(process.cwd());
});

afterEach(async () => {
  cwdSpy.mockRestore();
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadRuntimeConfig", () => {
  it("reads the persisted config and derives the search scope", async () => {
    const root = await withIndexDir({
      ".weldall-search/config.json": JSON.stringify(identity),
      ".weldall-search/index.json": "{}",
    });
    cwdSpy.mockReturnValue(root);

    const { config } = loadRuntimeConfig();
    expect(config.issuer).toBe("https://weldall.example.com");
    expect(config.resource).toBe("https://basics.seibert.tools/api");
    expect(config.publicOrigin).toBe("https://basics.seibert.tools");
    expect(config.clientId).toBe("starlight-basics");
    expect(config.requiredScopes).toEqual(["search:read"]);
    expect(config.searchPath).toBe("/api/search");
    expect(config.language).toBe("german");
    expect(config.defaultLimit).toBe(10);
    expect(config.allowInsecureLoopback).toBe(false);
    // no persisted signing key; the runtime falls back to env/default
    expect(config.signingKey).toBeUndefined();
  });

  it("throws a helpful error when the Weldall config is missing", async () => {
    const root = await withIndexDir({});
    cwdSpy.mockReturnValue(root);
    expect(() => loadRuntimeConfig()).toThrow(/issuer/);
    expect(() => loadRuntimeConfig()).toThrow(/astro\.config\.mjs/);
  });

  it("honors overridable site settings and a user-provided signing key", async () => {
    const key = { kid: "k1", privateJwk: { kty: "EC" }, publicJwk: { kty: "EC" } };
    const root = await withIndexDir({
      ".weldall-search/config.json": JSON.stringify({
        ...identity,
        requiredScopes: ["search:read", "staging:read"],
        searchPath: "/suchen",
        defaultLimit: 5,
        signingKey: key,
      }),
      ".weldall-search/index.json": "{}",
    });
    cwdSpy.mockReturnValue(root);

    const { config } = loadRuntimeConfig();
    expect(config.requiredScopes).toEqual(["search:read", "staging:read"]);
    expect(config.searchPath).toBe("/suchen");
    expect(config.defaultLimit).toBe(5);
    expect(config.signingKey).toEqual(key);
  });
});

describe("buildSearchSkill", () => {
  it("documents the exact search URL and scope", () => {
    const { id, title, content } = buildSearchSkill({
      publicOrigin: "https://basics.seibert.tools",
      resource: "https://basics.seibert.tools/api",
      searchPath: "/api/search",
      requiredScopes: ["search:read"],
      siteLabel: "basics",
    });
    expect(id).toBe("search");
    expect(title).toBe("Search the basics knowledge base");
    expect(content).toContain('"https://basics.seibert.tools/api/search?q=<query>"');
    expect(content).toContain("--scope search:read");
    expect(content).toContain("weldall request");
  });

  it("falls back to a generic title without a site label", () => {
    const { title } = buildSearchSkill({
      publicOrigin: "http://localhost:4321",
      resource: "http://localhost:4321/api",
      searchPath: "/api/search",
      requiredScopes: ["search:read"],
      siteLabel: "",
    });
    expect(title).toBe("Search the knowledge base");
  });
});
