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
  resource: "https://docs.example.com/api",
  publicOrigin: "https://docs.example.com",
  clientId: "starlight-docs",
  requiredScopes: ["search:read"],
};

let cwdSpy: ReturnType<typeof vi.spyOn>;
let originalSigningKey: string | undefined;

beforeEach(() => {
  originalSigningKey = process.env.WELDALL_SIGNING_KEY;
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(process.cwd());
});

afterEach(async () => {
  if (originalSigningKey === undefined) {
    delete process.env.WELDALL_SIGNING_KEY;
  } else {
    process.env.WELDALL_SIGNING_KEY = originalSigningKey;
  }
  cwdSpy.mockRestore();
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
    expect(config.resource).toBe("https://docs.example.com/api");
    expect(config.publicOrigin).toBe("https://docs.example.com");
    expect(config.clientId).toBe("starlight-docs");
    expect(config.requiredScopes).toEqual(["search:read"]);
    expect(config.searchPath).toBe("/api/search");
    expect(config.contentPath).toBe("/api/content");
    expect(config.language).toBe("english");
    expect(config.defaultLimit).toBe(10);
    expect(config.allowInsecureLoopback).toBe(false);
  });

  it("throws a helpful error when the Weldall config is missing", async () => {
    const root = await withIndexDir({});
    cwdSpy.mockReturnValue(root);
    expect(() => loadRuntimeConfig()).toThrow(/issuer/);
    expect(() => loadRuntimeConfig()).toThrow(/astro\.config\.mjs/);
  });

  it("honors overridable site settings without requiring secret config", async () => {
    const root = await withIndexDir({
      ".weldall-search/config.json": JSON.stringify({
        ...identity,
        requiredScopes: ["search:read", "staging:read"],
        searchPath: "/search",
        defaultLimit: 5,
      }),
      ".weldall-search/index.json": "{}",
    });
    cwdSpy.mockReturnValue(root);

    const { config } = loadRuntimeConfig();
    expect(config.requiredScopes).toEqual(["search:read", "staging:read"]);
    expect(config.searchPath).toBe("/search");
    expect(config.defaultLimit).toBe(5);
  });

  it("honors a custom content path and search skill override", async () => {
    const root = await withIndexDir({
      ".weldall-search/config.json": JSON.stringify({
        ...identity,
        contentPath: "/read",
        skillsSearch: { title: "Find it", extraRules: "Pages under /office are teams." },
      }),
      ".weldall-search/index.json": "{}",
    });
    cwdSpy.mockReturnValue(root);

    const { config, skillsSearch } = loadRuntimeConfig();
    expect(config.contentPath).toBe("/read");
    expect(skillsSearch).toEqual({
      title: "Find it",
      extraRules: "Pages under /office are teams.",
    });
  });

  it("passes the environment signing key and runtime replay store into Weldall", async () => {
    vi.resetModules();
    const initWeldall = vi.fn(() => ({
      handlers: {},
      verifyNoThrow: vi.fn(),
    }));
    vi.doMock("../src/astro.js", () => ({ initWeldall }));
    vi.doMock("../src/starlight/indexing.js", () => ({
      readIndexFile: vi.fn(async () => ({})),
      readDocumentsFile: vi.fn(async () => []),
      runSearch: vi.fn(async () => []),
    }));
    try {
      const runtimeModule = await import("../src/starlight/runtime.js");
      const root = await withIndexDir({
        ".weldall-search/config.json": JSON.stringify(identity),
        ".weldall-search/index.json": "{}",
      });
      cwdSpy.mockReturnValue(root);
      const signingKey = { kid: "k1", privateJwk: { kty: "EC" }, publicJwk: { kty: "EC" } };
      const replayStore = { consume: vi.fn(async () => true) };
      process.env.WELDALL_SIGNING_KEY = JSON.stringify(signingKey);

      runtimeModule.configureRuntimeOptions({ replayStore });
      await runtimeModule.getRuntime();

      expect(initWeldall).toHaveBeenCalledWith(
        "https://weldall.example.com",
        expect.objectContaining({ signingKey, replayStore }),
      );
      runtimeModule.resetRuntimeForTests();
    } finally {
      vi.doUnmock("../src/astro.js");
      vi.doUnmock("../src/starlight/indexing.js");
      vi.resetModules();
    }
  });

  it("fails runtime creation when the signing key is absent from the environment", async () => {
    vi.resetModules();
    vi.doMock("../src/astro.js", () => ({ initWeldall: vi.fn() }));
    vi.doMock("../src/starlight/indexing.js", () => ({
      readIndexFile: vi.fn(async () => ({})),
      readDocumentsFile: vi.fn(async () => []),
      runSearch: vi.fn(async () => []),
    }));
    try {
      const runtimeModule = await import("../src/starlight/runtime.js");
      const root = await withIndexDir({
        ".weldall-search/config.json": JSON.stringify(identity),
        ".weldall-search/index.json": "{}",
      });
      cwdSpy.mockReturnValue(root);
      delete process.env.WELDALL_SIGNING_KEY;

      await expect(runtimeModule.getRuntime()).rejects.toThrow(/WELDALL_SIGNING_KEY/);
      runtimeModule.resetRuntimeForTests();
    } finally {
      vi.doUnmock("../src/astro.js");
      vi.doUnmock("../src/starlight/indexing.js");
      vi.resetModules();
    }
  });
});

describe("buildSearchSkill", () => {
  const baseContext = {
    publicOrigin: "https://docs.example.com",
    resource: "https://docs.example.com/api",
    searchPath: "/api/search",
    contentPath: "/api/content",
    requiredScopes: ["search:read"],
    siteLabel: "docs",
  };

  it("documents the exact search URL and scope", () => {
    const { id, title, content } = buildSearchSkill(baseContext);
    expect(id).toBe("search");
    expect(title).toBe("Search the docs knowledge base");
    expect(content).toContain(
      [
        "weldall request \\",
        "  --scope search:read \\",
        '  "https://docs.example.com/api/search?q=<query>"',
      ].join("\n"),
    );
  });

  it("documents the full-page read endpoint and its response shape", () => {
    const { content } = buildSearchSkill(baseContext);
    expect(content).toContain(
      [
        "weldall request \\",
        "  --scope search:read \\",
        '  "https://docs.example.com/api/content?path=<path>"',
      ].join("\n"),
    );
    expect(content).toContain(
      '"content": "# Team\\n\\nThe employee directory explains the team structure ..."',
    );
  });

  it("falls back to a generic title without a site label", () => {
    const { title } = buildSearchSkill({
      ...baseContext,
      publicOrigin: "http://localhost:4321",
      resource: "http://localhost:4321/api",
      siteLabel: "",
    });
    expect(title).toBe("Search the knowledge base");
  });

  it("applies a custom title and appended operating rules", () => {
    const { title, content } = buildSearchSkill(baseContext, {
      title: "Find company info",
      extraRules: "Pages under /office describe internal support teams.",
    });
    expect(title).toBe("Find company info");
    expect(content).toContain("# Find company info");
    expect(content).toContain("Pages under /office describe internal support teams.");
    expect(content).toContain("weldall request");
  });

  it("replaces the generated content entirely when a content override is given", () => {
    const { title, content } = buildSearchSkill(baseContext, {
      title: "Custom",
      content: "# Custom\n\nDo exactly this.\n",
    });
    expect(title).toBe("Custom");
    expect(content).toBe("# Custom\n\nDo exactly this.\n");
  });
});
