import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureWeldallSearchRuntime,
  SUPPORTED_SEARCH_LANGUAGES,
  weldallSearch,
} from "../src/starlight/index.js";
import { createDpopProof, generateEs256KeyPair, issueIdJag } from "../src/index.js";
import { resetRuntimeForTests } from "../src/starlight/runtime.js";
import { buildIndexFromDir, writeIndexFile } from "../src/starlight/indexing.js";

let tempDirs: string[] = [];

async function write(relPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(relPath), { recursive: true });
  await writeFile(relPath, content);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  resetRuntimeForTests();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("weldallSearch integration", () => {
  it("is a named Astro integration with config:setup and build:done hooks", () => {
    const integration = weldallSearch("https://weldall.example.com", {});
    expect(integration.name).toBe("@weldall/sdk/starlight");
    expect(integration.hooks?.["astro:config:setup"]).toBeTypeOf("function");
    expect(integration.hooks?.["astro:build:done"]).toBeTypeOf("function");
    expect(configureWeldallSearchRuntime).toBeTypeOf("function");
    expect(SUPPORTED_SEARCH_LANGUAGES).toContain("english");
    expect(SUPPORTED_SEARCH_LANGUAGES).toContain("german");
  });

  it("injects the search, metadata, and skills routes and writes the index", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sws-root-"));
    tempDirs.push(root);
    await write(
      path.join(root, "src/content/docs/index.md"),
      "---\ntitle: Welcome\n---\nThe Example Company knowledge base.\n",
    );

    const integration = weldallSearch("https://weldall.example.com", {
      contentDir: "src/content/docs",
      language: "english",
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
      "/api/content",
      "/.well-known/oauth-authorization-server",
      "/.well-known/jwks.json",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/api",
      "/.well-known/weldall-skills",
      "/oauth/token",
    ]);
    const { readFile } = await import("node:fs/promises");
    const index = JSON.parse(await readFile(path.join(root, ".weldall-search/index.json"), "utf8"));
    expect(index.language).toBe("english");
    expect(index.raw).toBeTruthy();
  });

  it("derives the resource metadata route from the configured resource path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sws-resource-"));
    tempDirs.push(root);
    await write(path.join(root, "src/content/docs/index.md"), "---\ntitle: Welcome\n---\nHello.\n");
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
    await write(path.join(root, "src/content/docs/index.md"), "---\ntitle: Welcome\n---\nHello.\n");
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

  it("injects a configurable content endpoint path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sws-content-route-"));
    tempDirs.push(root);
    await write(path.join(root, "src/content/docs/index.md"), "---\ntitle: Welcome\n---\nHello.\n");
    const integration = weldallSearch("https://weldall.example.com", {
      contentDir: "src/content/docs",
      contentPath: "/read",
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

    expect(patterns).toContain("/read");
  });

  it("normalizes routes and persists only deployable config values", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sws-root with spaces-"));
    tempDirs.push(root);
    await write(path.join(root, "src/content/docs/index.md"), "---\ntitle: Welcome\n---\nHello.\n");
    const replayStore = { consume: async () => true };
    const signingKey = { kid: "secret", privateJwk: { kty: "EC" }, publicJwk: { kty: "EC" } };
    const integration = weldallSearch("https://weldall.example.com", {
      publicOrigin: "https://docs.example.com",
      resource: "https://docs.example.com/api",
      clientId: "starlight-docs",
      requiredScopes: ["search:read"],
      searchPath: "api/search/",
      contentPath: "read/",
      skills: { search: { title: "Find it", extraRules: "Pages under /office are teams." } },
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
    expect(patterns[1]).toBe("/read");
    const { readFile } = await import("node:fs/promises");
    const config = JSON.parse(
      await readFile(path.join(root, ".weldall-search/config.json"), "utf8"),
    );
    expect(config.searchPath).toBe("/api/search");
    expect(config.contentPath).toBe("/read");
    expect(config.skillsSearch).toEqual({
      title: "Find it",
      extraRules: "Pages under /office are teams.",
    });
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
    await write(path.join(contentDir, "index.md"), "---\ntitle: Welcome\n---\nHello world.\n");

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
    expect(copied.language).toBe("english");
    const copiedDocuments = JSON.parse(
      await readFile(path.join(fileURLToPath(dist), ".weldall-search/documents.json"), "utf8"),
    );
    expect(copiedDocuments).toEqual([
      {
        path: "/",
        title: "Welcome",
        description: "",
        content: "Hello world.",
        markdown: "Hello world.",
      },
    ]);
  });

  it("fails the build when generated artifacts cannot be copied", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sws-root3-"));
    tempDirs.push(root);
    await write(
      path.join(root, "src/content/docs/index.md"),
      "---\ntitle: Welcome\n---\nHello world.\n",
    );

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

describe("Starlight protocol routes", () => {
  it("serves local auth metadata, JWKS, and token exchange handlers", async () => {
    vi.resetModules();
    const runtime = {
      weldall: {
        handlers: {
          authorizationServerMetadata: vi.fn(async () =>
            Response.json({ issuer: "https://docs.example.com" }),
          ),
          jwks: vi.fn(async () => Response.json({ keys: [{ kid: "local" }] })),
          token: vi.fn(async () => Response.json({ access_token: "token" })),
        },
      },
    };
    vi.doMock("../src/starlight/runtime.js", () => ({
      getRuntime: vi.fn(async () => runtime),
    }));
    try {
      const [authorizationServer, jwks, token] = await Promise.all([
        import("../src/starlight/routes/oauth-authorization-server.js"),
        import("../src/starlight/routes/jwks.js"),
        import("../src/starlight/routes/token.js"),
      ]);

      const metadataResponse = await authorizationServer.GET({
        request: new Request("https://docs.example.com/.well-known/oauth-authorization-server"),
      } as never);
      const jwksResponse = await jwks.GET({
        request: new Request("https://docs.example.com/.well-known/jwks.json"),
      } as never);
      const tokenResponse = await token.POST({
        request: new Request("https://docs.example.com/oauth/token", { method: "POST" }),
      } as never);

      await expect(metadataResponse.json()).resolves.toMatchObject({
        issuer: "https://docs.example.com",
      });
      await expect(jwksResponse.json()).resolves.toMatchObject({ keys: [{ kid: "local" }] });
      await expect(tokenResponse.json()).resolves.toMatchObject({ access_token: "token" });
      expect(runtime.weldall.handlers.token).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("../src/starlight/runtime.js");
      vi.resetModules();
    }
  });

  it("exchanges an ID-JAG and reaches the protected search endpoint", async () => {
    vi.resetModules();
    const root = await mkdtemp(path.join(tmpdir(), "sws-flow-"));
    tempDirs.push(root);
    const contentDir = path.join(root, "src/content/docs");
    await write(path.join(contentDir, "index.md"), "---\ntitle: Welcome\n---\nHello world.\n");
    const built = await buildIndexFromDir(contentDir, "english");
    await writeIndexFile(path.join(root, ".weldall-search/index.json"), {
      language: "english",
      raw: built.raw,
    });
    await write(
      path.join(root, ".weldall-search/documents.json"),
      JSON.stringify([
        {
          path: "/",
          title: "Welcome",
          description: "",
          content: "Hello world.",
          markdown: "Hello world.",
        },
      ]),
    );
    await write(
      path.join(root, ".weldall-search/config.json"),
      JSON.stringify({
        issuer: "https://weldall.example.com",
        resource: "http://localhost:4321/api",
        publicOrigin: "http://localhost:4321",
        clientId: "starlight-demo",
        requiredScopes: ["search:read"],
        allowInsecureLoopback: true,
      }),
    );
    const weldallKey = await generateEs256KeyPair();
    const localKey = await generateEs256KeyPair();
    const deviceKey = await generateEs256KeyPair();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://weldall.example.com/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer: "https://weldall.example.com",
            jwks_uri: "https://weldall.example.com/.well-known/jwks.json",
          });
        }
        if (url === "https://weldall.example.com/.well-known/jwks.json") {
          return Response.json({
            keys: [{ ...weldallKey.publicJwk, kid: "weldall", alg: "ES256", use: "sig" }],
          });
        }
        return new Response(null, { status: 404 });
      }),
    );
    const originalSigningKey = process.env.WELDALL_SIGNING_KEY;
    process.env.WELDALL_SIGNING_KEY = JSON.stringify({
      kid: "local",
      privateJwk: localKey.privateJwk,
      publicJwk: localKey.publicJwk,
    });
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      const [token, search] = await Promise.all([
        import("../src/starlight/routes/token.js"),
        import("../src/starlight/routes/search.js"),
      ]);
      const assertion = await issueIdJag({
        issuer: "https://weldall.example.com",
        subject: "user-1",
        email: "user@example.com",
        audience: "http://localhost:4321",
        clientId: "starlight-demo",
        resource: "http://localhost:4321/api",
        scopes: ["search:read"],
        jkt: deviceKey.jkt,
        kid: "weldall",
        privateJwk: weldallKey.privateJwk,
      });
      const tokenProof = await createDpopProof({
        ...deviceKey,
        method: "POST",
        url: "http://localhost:4321/oauth/token",
      });
      const tokenResponse = await token.POST({
        request: new Request("http://localhost:4321/oauth/token", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            dpop: tokenProof,
          },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-dpop",
            assertion,
          }),
        }),
      } as never);
      expect(tokenResponse.status).not.toBe(404);
      expect(tokenResponse.status).toBe(200);
      const tokenBody = (await tokenResponse.json()) as { access_token: string };
      const searchProof = await createDpopProof({
        ...deviceKey,
        method: "GET",
        url: "http://localhost:4321/api/search?q=hello",
        accessToken: tokenBody.access_token,
      });
      const searchResponse = await search.GET({
        request: new Request("http://localhost:4321/api/search?q=hello", {
          headers: {
            authorization: `DPoP ${tokenBody.access_token}`,
            dpop: searchProof,
          },
        }),
      } as never);

      expect(searchResponse.status).toBe(200);
      await expect(searchResponse.json()).resolves.toMatchObject({
        query: "hello",
        results: [{ path: "/", title: "Welcome" }],
        subject: "user-1",
      });

      const content = await import("../src/starlight/routes/content.js");
      const contentProof = await createDpopProof({
        ...deviceKey,
        method: "GET",
        url: "http://localhost:4321/api/content?path=/",
        accessToken: tokenBody.access_token,
      });
      const contentResponse = await content.GET({
        request: new Request("http://localhost:4321/api/content?path=/", {
          headers: {
            authorization: `DPoP ${tokenBody.access_token}`,
            dpop: contentProof,
          },
        }),
      } as never);
      expect(contentResponse.status).toBe(200);
      await expect(contentResponse.json()).resolves.toMatchObject({
        path: "/",
        title: "Welcome",
        content: "Hello world.",
        subject: "user-1",
      });

      const missingProof = await createDpopProof({
        ...deviceKey,
        method: "GET",
        url: "http://localhost:4321/api/content?path=/nope",
        accessToken: tokenBody.access_token,
      });
      const missingResponse = await content.GET({
        request: new Request("http://localhost:4321/api/content?path=/nope", {
          headers: {
            authorization: `DPoP ${tokenBody.access_token}`,
            dpop: missingProof,
          },
        }),
      } as never);
      expect(missingResponse.status).toBe(404);
      await expect(missingResponse.json()).resolves.toMatchObject({ error: "not_found" });
    } finally {
      if (originalSigningKey === undefined) {
        delete process.env.WELDALL_SIGNING_KEY;
      } else {
        process.env.WELDALL_SIGNING_KEY = originalSigningKey;
      }
      cwdSpy.mockRestore();
      vi.resetModules();
    }
  });
});
