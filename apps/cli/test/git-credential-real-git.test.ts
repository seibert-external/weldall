import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureGitProxyRepository, gitProxyEnvironment } from "../src/git/repository-setup.js";
import { GitRepository } from "../src/publish/git.js";

/**
 * Real `/usr/bin/git` against an imitation of a registry's git route: HTTPS on 127.0.0.1 that
 * answers the first request with a Basic challenge and accepts only credentials the fake
 * registry's credential endpoint issued, in front of `git http-backend` on a temporary bare
 * repository. The registry is registered in a fake Weldall resource registry and listed with its
 * git route in Weldall's `GET /api/me/apps` (its own metadata announces it too, but the helper
 * must never read that); git reaches the helper through the configuration
 * `configureGitProxyRepository` writes.
 */

const GIT = "/usr/bin/git";
const GIT_PATH = "/git";

function unavailableReason(): string | null {
  if (!existsSync(GIT)) return `${GIT} not found`;
  const execPath = spawnSync(GIT, ["--exec-path"], { encoding: "utf8" });
  if (execPath.status !== 0) return "git --exec-path failed";
  if (!existsSync(join(execPath.stdout.trim(), "git-http-backend")))
    return "git http-backend not found";
  if (spawnSync("openssl", ["version"]).status !== 0) return "openssl not found (TLS test server)";
  return null;
}

const reason = unavailableReason();
const backend = reason
  ? ""
  : join(spawnSync(GIT, ["--exec-path"], { encoding: "utf8" }).stdout.trim(), "git-http-backend");

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

describe.skipIf(reason !== null)(
  `git credential helper with real git${reason ? ` (skipped: ${reason})` : ""}`,
  // Real git processes: a push and a fetch took 5 s on the macOS CI runner.
  { timeout: 60_000 },
  () => {
    let root: string;
    let home: string;
    let work: string;
    let bare: string;
    let traceFile: string;
    let decoyMarker: string;
    let origin: string;
    let remoteUrl: string;
    let base: string;
    let registered = true;
    /** What Weldall lists: the registry with its git route, without it, or no registry. */
    let listing: "git" | "no-git" | "none" = "git";
    /** Reads of the registry's own metadata; the helper must never make one. */
    let metadataReads = 0;
    let pathEnvironment: string;
    const servers: Server[] = [];
    const issued = new Set<string>();
    const credentialRequests: unknown[] = [];
    const proxyRequests: { url: string; authorized: boolean }[] = [];
    let endpointMode: "issue" | "expired-login" | "rate-limited-once" = "issue";

    const git = (args: string[], env: NodeJS.ProcessEnv = {}, cwd = work) =>
      new Promise<GitResult>((resolve, reject) => {
        const child = spawn(GIT, args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: pathEnvironment,
            HOME: home,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
            GIT_SSL_NO_VERIFY: "1",
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
            WELDALL_TEST_ISSUER: "https://weldall.example.com",
            WELDALL_TEST_REGISTRY: `${base}/api/me/scopes`,
            WELDALL_TEST_APPS: `${base}/api/me/apps`,
            WELDALL_TEST_REGISTRY_APIS: JSON.stringify({ [origin]: base }),
            ...env,
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });

    /** Runs git the way the publish step will: through `gitProxyEnvironment`, traced. */
    const gitViaProxy = async (args: string[], access: "read" | "write") => {
      await rm(traceFile, { force: true });
      const result = await git(args, {
        ...gitProxyEnvironment({ access, base: {} }),
        GIT_TRACE: traceFile,
      });
      return { ...result, trace: await readFile(traceFile, "utf8").catch(() => "") };
    };

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "weldall-git-helper-"));
      home = join(root, "home");
      work = join(root, "work");
      bare = join(root, "repos", "acme", "shop.git");
      traceFile = join(root, "trace.txt");
      decoyMarker = join(root, "decoy-helper-ran");
      for (const directory of [home, work, join(root, "bin"), join(root, "repos", "acme")])
        await mkdir(directory, { recursive: true });

      // A helper configured globally, like osxkeychain on a Mac: the setup must clear it.
      const decoy = join(root, "bin", "decoy-helper");
      await writeFile(decoy, `#!/bin/sh\ntouch '${decoyMarker}'\ncat >/dev/null\n`);
      await chmod(decoy, 0o755);
      await writeFile(join(home, ".gitconfig"), `[credential]\n\thelper = !'${decoy}'\n`);

      // `weldall` on PATH: the real protocol code, reaching the fake credential endpoint.
      const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
      const shim = fileURLToPath(new URL("./fixtures/git-credential-shim.ts", import.meta.url));
      await writeFile(
        join(root, "bin", "weldall"),
        `#!/bin/sh\nexec '${process.execPath}' --import '${tsx}' '${shim}' "$@"\n`,
      );
      await chmod(join(root, "bin", "weldall"), 0o755);
      pathEnvironment = `${join(root, "bin")}:/usr/bin:/bin`;

      const certificate = spawnSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-subj",
          "/CN=127.0.0.1",
          "-days",
          "1",
          "-keyout",
          join(root, "key.pem"),
          "-out",
          join(root, "cert.pem"),
        ],
        { encoding: "utf8" },
      );
      if (certificate.status !== 0) throw new Error(`openssl failed: ${certificate.stderr}`);

      // Weldall's resource registry and app list, the registry's metadata and its credential
      // endpoint, as plain HTTP.
      const credentials = createHttpServer(async (req, res) => {
        if (req.url === "/api/me/scopes") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify(
              registered
                ? [
                    {
                      key: "registry",
                      name: "Registry",
                      resourceIdentifier: `${origin}/api`,
                      authorizationServer: origin,
                      downstreamClientId: "weldall-cli-at-registry",
                      requestPrefixes: [`${origin}/api`],
                      supportedScopes: ["registry:publish"],
                      grantedScopes: ["registry:publish"],
                    },
                  ]
                : [],
            ),
          );
          return;
        }
        if (req.url === "/api/me/apps") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              items: [],
              warnings: [],
              registries:
                listing === "none"
                  ? []
                  : [
                      {
                        key: "registry",
                        name: "Registry",
                        resource: `${origin}/api`,
                        endpoint: `${origin}/api/apps`,
                        scope: "registry:publish",
                        allowed: true,
                        adminScope: null,
                        adminAllowed: false,
                        git: listing === "git" ? `${origin}/git/` : null,
                        gitCredentials: listing === "git" ? `${origin}/api/git-credentials` : null,
                      },
                    ],
            }),
          );
          return;
        }
        if (req.url === "/.well-known/oauth-protected-resource") {
          metadataReads += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              resource: `${origin}/api`,
              authorization_servers: [origin],
              scopes_supported: ["registry:publish"],
              weldall_apps_api: {
                endpoint: `${origin}/api/apps`,
                scope: "registry:publish",
                git: `${origin}/git/`,
                gitCredentials: `${origin}/api/git-credentials`,
              },
            }),
          );
          return;
        }
        const body = JSON.parse((await readBody(req)).toString("utf8")) as unknown;
        credentialRequests.push(body);
        if (endpointMode === "rate-limited-once") {
          endpointMode = "issue";
          res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
          res.end(JSON.stringify({ error: "rate_limit", error_description: "Wait." }));
          return;
        }
        if (endpointMode === "expired-login") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_token" }));
          return;
        }
        const password = `wgc_${randomBytes(12).toString("hex")}.${randomBytes(32).toString("base64url")}`;
        issued.add(password);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            username: "weldall",
            password,
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          }),
        );
      });
      base = `http://127.0.0.1:${await listen(credentials)}`;
      servers.push(credentials);

      const proxy = createHttpsServer(
        {
          key: await readFile(join(root, "key.pem")),
          cert: await readFile(join(root, "cert.pem")),
        },
        async (req, res) => {
          const body = await readBody(req);
          const url = new URL(req.url!, "https://proxy");
          const header = req.headers.authorization ?? "";
          const [user, password] = header.startsWith("Basic ")
            ? Buffer.from(header.slice(6), "base64").toString("utf8").split(":")
            : [];
          const authorized = user === "weldall" && password !== undefined && issued.has(password);
          proxyRequests.push({ url: req.url!, authorized });
          if (!authorized || !url.pathname.startsWith(`${GIT_PATH}/`)) {
            res.writeHead(401, { "www-authenticate": 'Basic realm="Weldall git"' });
            res.end("Authentication required.");
            return;
          }
          const child = spawn(backend, [], {
            env: {
              GIT_PROJECT_ROOT: join(root, "repos"),
              GIT_HTTP_EXPORT_ALL: "1",
              GIT_CONFIG_NOSYSTEM: "1",
              HOME: root,
              REMOTE_USER: "weldall",
              PATH_INFO: url.pathname.slice(GIT_PATH.length),
              QUERY_STRING: url.search.slice(1),
              REQUEST_METHOD: req.method!,
              CONTENT_TYPE: req.headers["content-type"] ?? "",
              CONTENT_LENGTH: String(body.length),
              REMOTE_ADDR: "127.0.0.1",
              ...(req.headers["git-protocol"]
                ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) }
                : {}),
              ...(req.headers["content-encoding"]
                ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) }
                : {}),
            },
          });
          child.stdin.on("error", () => {});
          child.stdin.end(body);
          const output: Buffer[] = [];
          child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
          child.on("close", () => {
            const all = Buffer.concat(output);
            const split = all.indexOf("\r\n\r\n");
            let status = 200;
            const headers: Record<string, string> = {};
            for (const line of all.subarray(0, split).toString("latin1").split("\r\n")) {
              const colon = line.indexOf(":");
              const name = line.slice(0, colon).trim().toLowerCase();
              const value = line.slice(colon + 1).trim();
              if (name === "status") status = Number.parseInt(value, 10);
              else if (name) headers[name] = value;
            }
            res.writeHead(status, headers).end(all.subarray(split + 4));
          });
        },
      );
      origin = `https://127.0.0.1:${await listen(proxy)}`;
      servers.push(proxy);
      remoteUrl = `${origin}/git/acme/shop.git`;

      expect((await git(["init", "--bare", "-b", "main", bare], {}, root)).code).toBe(0);
      expect((await git(["init", "-b", "main"])).code).toBe(0);
      await git(["config", "remote.origin.url", "https://example.invalid/other.git"]);
      await writeFile(join(work, "README.md"), "# shop\n");
      // Over 1 MiB, the size at which Apple Git's chunked push breaks without http.postBuffer.
      await writeFile(join(work, "data.bin"), randomBytes(3 * 1024 * 1024));
      await git(["add", "."]);
      expect((await git(["commit", "-m", "initial"])).code).toBe(0);
    });

    afterAll(async () => {
      await Promise.all(
        servers.map((server) => new Promise((resolve) => server.close(() => resolve(null)))),
      );
      if (root) await rm(root, { recursive: true, force: true });
    });

    it("configures only the proxy URL, idempotently", async () => {
      await configureGitProxyRepository({
        repository: new GitRepository(GIT, work, process.env),
        remoteUrl,
      });
      const first = await git(["config", "--local", "--list"]);
      await configureGitProxyRepository({
        repository: new GitRepository(GIT, work, process.env),
        remoteUrl,
      });
      const second = await git(["config", "--local", "--list"]);
      expect(second.stdout).toBe(first.stdout);
      const lines = second.stdout.trim().split("\n");
      const scope = `${origin}/git/`;
      expect(lines).toEqual(
        expect.arrayContaining([
          "remote.origin.url=https://example.invalid/other.git",
          `remote.weldall.url=${remoteUrl}`,
          "remote.weldall.fetch=+refs/heads/*:refs/remotes/weldall/*",
          `credential.${scope}.usehttppath=true`,
          `http.${scope}.postbuffer=104857600`,
        ]),
      );
      expect(lines.filter((line) => line.startsWith(`credential.${scope}.helper=`))).toEqual([
        `credential.${scope}.helper=`,
        `credential.${scope}.helper=!weldall git-credential`,
      ]);
      expect(lines.filter((line) => /askpass|^credential\.helper/i.test(line))).toEqual([]);
    });

    it("pushes and fetches through the helper, with no other helper and no prompt", async () => {
      const homeBefore = await readdir(home);
      const push = await gitViaProxy(["push", "weldall", "main"], "write");
      expect(push.code, push.stderr).toBe(0);
      expect(credentialRequests.at(-1)).toEqual({
        path: "git/acme/shop.git",
        access: "write",
      });
      // Git asks without a credential first and gets the challenge.
      expect(proxyRequests[0]).toMatchObject({ authorized: false });
      expect(proxyRequests.some((request) => request.authorized)).toBe(true);
      const pushed = await git(["rev-parse", "main"], {}, bare);
      const local = await git(["rev-parse", "HEAD"]);
      expect(pushed.stdout).toBe(local.stdout);

      const fetch = await gitViaProxy(["fetch", "weldall"], "read");
      expect(fetch.code, fetch.stderr).toBe(0);
      expect(credentialRequests.at(-1)).toEqual({
        path: "git/acme/shop.git",
        access: "read",
      });
      expect((await git(["rev-parse", "weldall/main"])).stdout).toBe(local.stdout);

      for (const trace of [push.trace, fetch.trace]) {
        expect(trace).toContain("weldall git-credential get");
        expect(trace).not.toMatch(/credential-osxkeychain|decoy-helper/);
      }
      expect(existsSync(decoyMarker)).toBe(false);
      // The helper stored nothing: HOME holds only the test's own git configuration.
      expect(await readdir(home)).toEqual(homeBefore);
      expect(`${push.stderr}${fetch.stderr}`).not.toContain("wgc_");
    });

    it("stops git with the login hint when the Weldall login has expired", async () => {
      endpointMode = "expired-login";
      try {
        const result = await gitViaProxy(["fetch", "weldall"], "read");
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("did not accept your Weldall login");
        expect(result.stderr).toContain("Run `weldall login`");
        expect(result.stderr).toContain("told us to quit");
        expect(result.stderr).not.toMatch(/Username for|Password for/);
        expect(existsSync(decoyMarker)).toBe(false);
      } finally {
        endpointMode = "issue";
      }
    });

    it("gives no credential once the registry is no longer registered in Weldall", async () => {
      registered = false;
      const asked = credentialRequests.length;
      try {
        const result = await gitViaProxy(["fetch", "weldall"], "read");
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("is not a registry Weldall lists for you");
        expect(result.stderr).toContain("told us to quit");
        expect(credentialRequests.length).toBe(asked);
        expect(proxyRequests.at(-1)).toMatchObject({ authorized: false });
      } finally {
        registered = true;
      }
    });

    it.each([
      ["Weldall lists the registry without its git route", "no-git"],
      ["Weldall lists no registry, though its own metadata still announces one", "none"],
    ] as const)("gives no credential once %s", async (_case, next) => {
      listing = next;
      const asked = credentialRequests.length;
      try {
        const result = await gitViaProxy(["fetch", "weldall"], "read");
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("is not a registry Weldall lists for you");
        expect(credentialRequests.length).toBe(asked);
        expect(metadataReads).toBe(0);
      } finally {
        listing = "git";
      }
    });

    it("waits a short Retry-After of the credential endpoint, then fetches", async () => {
      endpointMode = "rate-limited-once";
      const asked = credentialRequests.length;
      const result = await gitViaProxy(["fetch", "weldall"], "read");
      expect(result.code).toBe(0);
      expect(credentialRequests.length).toBe(asked + 2);
      expect(endpointMode).toBe("issue");
    });
  },
);
