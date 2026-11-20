/**
 * A local stand-in for Weldall, a Git app registered in it, and the Git host, for publish tests
 * with the real `/usr/bin/git`:
 *
 * - Weldall: the resource registry for the person (the Git app as a registered resource with its
 *   own origin, authorization server and scopes);
 * - the Git app's git route `https://<origin>/git/<owner>/<repository>.git` on 127.0.0.1 in front
 *   of `git http-backend`, which asks for Basic auth, accepts only credentials the fake Git app
 *   issued for that repository, and refuses pushes like the real Git app (publish branches only,
 *   none to a branch whose pull request is merged or closed), with the same `weldall: <reason>`
 *   status lines;
 * - the Git app's API (`/api/apps`, `/api/apps/{id}/status`, `/api/apps/{id}/pull-requests`,
 *   `/api/apps/{id}/confirm`, `/api/git-credentials`, `/api/admin/checklist`), reached over plain
 *   HTTP through
 *   `testOpenGitApp` (the stand-in's certificate is self-signed; the token exchange is left out,
 *   see `test-git-apps.ts`);
 * - helpers that play the reviewer and the Git host: commit to a branch, squash-merge or close
 *   a pull request, and the administrator: change the registry.
 *
 * Git reaches the credential helper through `weldall` on PATH, a shim running the real protocol
 * and access code (`git-credential-shim.ts`).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ResourceRegistryEntry } from "@weldall/sdk";
import { testOpenGitApp } from "./test-git-apps.js";

export const GIT = "/usr/bin/git";
const GIT_PATH = "/git";
export const GIT_APP_KEY = "git-app";
const PUBLISH_PREFIX = "weldall/publish-";
export const BOT_IDENTITY = {
  name: "weldall-app[bot]",
  email: "41898282+weldall-app[bot]@users.noreply.github.com",
};

/** Why the stand-in cannot run here, or null. */
export function fakeWeldallUnavailable(): string | null {
  if (!existsSync(GIT)) return `${GIT} not found`;
  const execPath = spawnSync(GIT, ["--exec-path"], { encoding: "utf8" });
  if (execPath.status !== 0) return "git --exec-path failed";
  if (!existsSync(join(execPath.stdout.trim(), "git-http-backend")))
    return "git http-backend not found";
  if (spawnSync("openssl", ["version"]).status !== 0) return "openssl not found (TLS test server)";
  return null;
}

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface FakePull {
  number: number;
  head: string;
  title: string;
  body: string;
  state: "open" | "merged" | "closed";
  /** Head commit the host reports; fixed when merged. */
  headCommit: string | null;
}

export interface FakeApp {
  id: string;
  name: string;
  template: string;
  bare: string;
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

const pkt = (data: string | Buffer) => {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
};

/** Ref updates and capabilities at the start of a receive-pack request. */
function readCommands(body: Buffer) {
  const commands: Array<{ old: string; next: string; ref: string }> = [];
  let capabilities: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = Number.parseInt(body.subarray(offset, offset + 4).toString("latin1"), 16);
    if (length === 0) break;
    const line = body
      .subarray(offset + 4, offset + length)
      .toString("latin1")
      .replace(/\n$/, "");
    offset += length;
    const [command, caps] = line.split("\0");
    if (caps !== undefined) capabilities = caps.split(" ");
    const [old = "", next = "", ref = ""] = command!.split(" ");
    commands.push({ old, next, ref });
  }
  return { commands, capabilities };
}

export async function startFakeWeldall() {
  const root = await mkdtemp(join(tmpdir(), "weldall-publish-"));
  const home = join(root, "home");
  const repos = join(root, "repos");
  const bin = join(root, "bin");
  for (const directory of [home, join(repos, "acme"), bin])
    await mkdir(directory, { recursive: true });
  await writeFile(join(home, ".gitconfig"), "");
  const backend = join(
    spawnSync(GIT, ["--exec-path"], { encoding: "utf8" }).stdout.trim(),
    "git-http-backend",
  );

  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const shim = fileURLToPath(new URL("./git-credential-shim.ts", import.meta.url));
  await writeFile(
    join(bin, "weldall"),
    `#!/bin/sh\nexec '${process.execPath}' --import '${tsx}' '${shim}' "$@"\n`,
  );
  await chmod(join(bin, "weldall"), 0o755);

  // A git that tests can interrupt: `ctl/pre` (first line: argument pattern, rest: shell run
  // before git in its working directory), `ctl/fail` (exit 137 before git runs, like a kill) and
  // `ctl/fail-after` (git runs, then exit 137).
  const control = join(root, "ctl");
  await mkdir(control, { recursive: true });
  const gitWrapper = join(bin, "git-wrapper");
  await writeFile(
    gitWrapper,
    [
      "#!/bin/sh",
      `CTL='${control}'`,
      'if [ -f "$CTL/pre" ]; then pat=$(head -1 "$CTL/pre"); case "$*" in *"$pat"*) tail -n +2 "$CTL/pre" > "$CTL/pre.run"; rm "$CTL/pre"; sh "$CTL/pre.run";; esac; fi',
      'if [ -f "$CTL/fail" ]; then pat=$(cat "$CTL/fail"); case "$*" in *"$pat"*) rm "$CTL/fail"; exit 137;; esac; fi',
      'if [ -f "$CTL/fail-after" ]; then pat=$(cat "$CTL/fail-after"); case "$*" in *"$pat"*) rm "$CTL/fail-after"; /usr/bin/git "$@"; exit 137;; esac; fi',
      'exec /usr/bin/git "$@"',
      "",
    ].join("\n"),
  );
  await chmod(gitWrapper, 0o755);

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

  const servers: Server[] = [];
  const issued = new Map<string, { repository: string; access: "read" | "write" }>();
  const apps = new Map<string, FakeApp>();
  /** When the owner confirmed each app (re-verification). */
  const confirmed = new Map<string, string>();
  const pulls: FakePull[] = [];
  const pushes: Array<{ ref: string; next: string; accepted: boolean }> = [];
  const templates = new Map<string, string>();
  let appCounter = 0;
  /** Played once by the next accepted push to this branch: the host merges the pull request right before the push lands. */
  let mergeBeforePush: string | null = null;
  /** Played once: the pull request of this branch is closed right before the proxy checks a push. */
  let closeBeforePush: string | null = null;
  let apiMode: "current" | "old-server" | "old-git-app" = "current";
  let failNextPullRequest = false;
  const credentialRequests: Array<{ path: string; access: string }> = [];
  const apiRequests: Array<{
    origin: string;
    scope: string;
    method: string;
    path: string;
    body?: unknown;
  }> = [];

  const gitEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    ...extra,
  });
  const git = (
    args: string[],
    cwd: string,
    options: { input?: string | Buffer; env?: NodeJS.ProcessEnv } = {},
  ) =>
    new Promise<GitResult>((resolve, reject) => {
      const child = spawn(GIT, args, {
        cwd,
        env: gitEnv(options.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.on("error", () => {});
      child.stdin.end(options.input ?? "");
    });
  const must = async (args: string[], cwd: string, options: Parameters<typeof git>[2] = {}) => {
    const result = await git(args, cwd, options);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };

  /** Commits `changes` (path to content, null deletes) on top of `branch` in a bare repository. */
  async function commitFiles(
    bare: string,
    branch: string,
    changes: Record<string, string | Buffer | null>,
    message: string,
  ): Promise<string> {
    const index = join(root, `index-${randomBytes(4).toString("hex")}`);
    const env = { GIT_INDEX_FILE: index };
    const parent = (
      await git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], bare)
    ).stdout.trim();
    if (parent) await must(["read-tree", parent], bare, { env });
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) {
        await must(["update-index", "-z", "--index-info"], bare, {
          env,
          input: `0 ${"0".repeat(40)}\t${path}\0`,
        });
        continue;
      }
      const blob = await must(["hash-object", "-w", "--stdin"], bare, { input: content });
      await must(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], bare, { env });
    }
    const tree = await must(["write-tree"], bare, { env });
    await rm(index, { force: true });
    const commit = await must(["commit-tree", tree, ...(parent ? ["-p", parent] : [])], bare, {
      input: message,
    });
    await must(["update-ref", `refs/heads/${branch}`, commit], bare);
    return commit;
  }

  const branchHead = async (bare: string, branch: string) =>
    (await git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], bare)).stdout.trim() ||
    null;

  /** Squash merge as GitHub does it: one new commit on main with the merged content. */
  async function squashMerge(pull: FakePull, app: FakeApp, at?: string) {
    const head = at ?? (await branchHead(app.bare, pull.head))!;
    const merged = await git(["merge-tree", "--write-tree", "main", head], app.bare);
    if (merged.code !== 0) throw new Error(`squash merge conflicts: ${merged.stdout}`);
    const tree = merged.stdout.split("\n")[0]!;
    const main = (await branchHead(app.bare, "main"))!;
    const commit = await must(["commit-tree", tree, "-p", main], app.bare, {
      input: `${pull.title} (#${pull.number})`,
    });
    await must(["update-ref", "refs/heads/main", commit], app.bare);
    pull.state = "merged";
    pull.headCommit = head;
  }

  const appOf = (id: string) => apps.get(id);
  const pullsOf = (app: FakeApp) =>
    pulls.filter((pull) => (pull as FakePull & { app: string }).app === app.id);

  const json = (res: import("node:http").ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };

  /** The Git app's API, as plain HTTP (see the module note). */
  const api = createHttpServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url!, "http://fake");
    if (apiMode === "old-git-app") {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<html>Not Found</html>");
    }
    const input = body.length ? (JSON.parse(body.toString("utf8")) as Record<string, string>) : {};
    if (url.pathname === "/api/git-credentials" && req.method === "POST") {
      credentialRequests.push({ path: input.path!, access: input.access ?? "read" });
      const repository = /^git\/acme\/([^/]+)\.git$/.exec(input.path ?? "")?.[1];
      const app = [...apps.values()].find((candidate) => `app-${candidate.name}` === repository);
      if (!app)
        return json(res, 404, {
          error: "not_found",
          error_description: "No app of yours uses this repository.",
        });
      const password = `wgc_${randomBytes(6).toString("base64url")}.${randomBytes(32).toString("base64url")}.${randomBytes(32).toString("base64url")}`;
      issued.set(password, {
        repository: repository!,
        access: input.access === "write" ? "write" : "read",
      });
      return json(res, 200, {
        username: "weldall",
        password,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    if (url.pathname === "/api/admin/checklist" && req.method === "GET") {
      if (req.headers["x-test-scope"] !== "git-app:admin")
        return json(res, 403, {
          error: "insufficient_scope",
          error_description: "Admin scope required.",
        });
      const appId = url.searchParams.get("app");
      const app = appId === null ? null : appOf(appId);
      if (appId !== null && !app)
        return json(res, 404, {
          error: "not_found",
          error_description: "No app of this Git app has this id.",
        });
      return json(res, 200, {
        host: { kind: "github", organization: "acme" },
        repository: app ? { owner: "acme", name: `app-${app.name}` } : null,
        checks: [
          {
            id: "installation",
            title: "Installation",
            state: "pass",
            required: true,
            reason: "Installed.",
            action: null,
          },
        ],
        summary: { pass: 1, fail: 0, unverifiable: 0 },
      });
    }
    const entry = (app: FakeApp) => ({
      id: app.id,
      name: app.name,
      purpose: "Tests",
      repository: {
        owner: "acme",
        name: `app-${app.name}`,
        webUrl: `https://github.example/acme/app-${app.name}`,
      },
      template: app.template,
      links: { preview: null, live: null },
      createdAt: "2026-11-01T10:00:00.000Z",
      confirmedAt: confirmed.get(app.id) ?? null,
      expiresAt: confirmed.has(app.id) ? "2027-02-16T09:00:00.000Z" : "2027-02-01T10:00:00.000Z",
      state: "active",
    });
    if (url.pathname === "/api/apps" && req.method === "GET")
      return json(res, 200, {
        resource: `${origin}/api`,
        apps: [...apps.values()].map(entry),
        reverificationDays: 90,
        expiringSoonDays: 14,
      });
    const confirm = /^\/api\/apps\/([^/]+)\/confirm$/.exec(url.pathname);
    if (confirm && req.method === "POST") {
      const app = appOf(decodeURIComponent(confirm[1]!));
      if (!app)
        return json(res, 404, {
          error: "not_found",
          error_description: "No app of yours has this id.",
        });
      confirmed.set(app.id, "2026-11-18T09:00:00.000Z");
      return json(res, 200, { app: entry(app) });
    }
    if (url.pathname === "/api/apps" && req.method === "POST") {
      const name = input.name!;
      const existing = [...apps.values()].find((app) => app.name === name);
      let app = existing;
      if (!app) {
        const templateDir = templates.get(input.template!);
        if (!templateDir)
          return json(res, 404, {
            error: "unknown_template",
            error_description: "Unknown template.",
          });
        appCounter += 1;
        app = {
          id: `app${appCounter}`,
          name,
          template: input.template!,
          bare: join(repos, "acme", `app-${name}.git`),
        };
        await must(["init", "-q", "--bare", "-b", "main", app.bare], root);
        await must(["fetch", "-q", templateDir, "main:refs/heads/template"], app.bare);
        // GitHub's template copy: the template's content as a new first commit.
        const tree = await must(["rev-parse", "refs/heads/template^{tree}"], app.bare);
        const commit = await must(["commit-tree", tree], app.bare, { input: "Initial commit" });
        await must(["update-ref", "refs/heads/main", commit], app.bare);
        await must(["update-ref", "-d", "refs/heads/template"], app.bare);
        apps.set(app.id, app);
      }
      const remotePath = `${GIT_PATH}/acme/app-${name}.git`;
      return json(res, 200, {
        created: !existing,
        app: { id: app.id, name, purpose: input.purpose, expiresAt: new Date().toISOString() },
        repository: {
          owner: "acme",
          name: `app-${name}`,
          id: null,
          webUrl: `https://github.example/acme/app-${name}`,
          defaultBranch: "main",
        },
        template: { name: app.template, commit: await branchHead(app.bare, "main") },
        git: { remotePath, remoteUrl: `${remoteOrigin ?? origin}${remotePath}` },
        warnings: [{ code: "branch_rule_missing", message: "No rule protects main." }],
      });
    }
    const match = /^\/api\/apps\/([^/]+)\/(status|pull-requests)$/.exec(url.pathname);
    const app = match ? appOf(decodeURIComponent(match[1]!)) : undefined;
    if (!match || !app)
      return json(res, 404, {
        error: "not_found",
        error_description: "No app of yours has this id.",
      });
    if (match[2] === "status") {
      const branch = url.searchParams.get("branch");
      const candidates = pullsOf(app).filter((pull) => branch === null || pull.head === branch);
      const pull = candidates.find(({ state }) => state === "open") ?? candidates.at(-1);
      return json(res, 200, {
        app: { id: app.id, name: app.name },
        pullRequest: pull
          ? {
              number: pull.number,
              webUrl: `https://github.example/acme/app-${app.name}/pull/${pull.number}`,
              state: pull.state,
              headBranch: pull.head,
              headCommit: pull.headCommit ?? (await branchHead(app.bare, pull.head)),
              reviews: [],
              checks: [],
            }
          : null,
        links: { preview: pull ? `https://preview.example/${pull.number}` : null, live: null },
        publish: { protectedPaths: [".github/workflows"], commitIdentity: BOT_IDENTITY },
        warnings: [],
      });
    }
    if (failNextPullRequest) {
      failNextPullRequest = false;
      return json(res, 503, {
        error: "upstream_unavailable",
        error_description: "GitHub is unavailable.",
      });
    }
    const open = pullsOf(app).find((pull) => pull.head === input.head && pull.state === "open");
    if (!(await branchHead(app.bare, input.head!)))
      return json(res, 409, { error: "branch_not_found", error_description: "Branch not found." });
    const pull =
      open ??
      Object.assign(
        {
          number: pulls.length + 1,
          head: input.head!,
          title: input.title!,
          body: input.body ?? "",
          state: "open" as const,
          headCommit: null,
        },
        { app: app.id },
      );
    if (!open) pulls.push(pull);
    return json(res, 200, {
      created: !open,
      app: { id: app.id, name: app.name },
      pullRequest: {
        number: pull.number,
        webUrl: `https://github.example/acme/app-${app.name}/pull/${pull.number}`,
        headBranch: pull.head,
        baseBranch: "main",
        headCommit: await branchHead(app.bare, pull.head),
      },
      requestedReviewers: { users: [], teams: [] },
      warnings: [],
    });
  });
  const apiBase = `http://127.0.0.1:${await listen(api)}`;
  servers.push(api);

  /** Weldall: the resource registry for the person, as plain HTTP. */
  const weldall = createHttpServer(async (req, res) => {
    const url = new URL(req.url!, "http://fake");
    if (url.pathname === "/api/me/scopes") return json(res, 200, currentResources());
    if (apiMode === "old-server") {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<html>Not Found</html>");
    }
    return json(res, 404, { error: "not_found", error_description: "Not found." });
  });
  const weldallOrigin = `http://127.0.0.1:${await listen(weldall)}`;
  servers.push(weldall);

  const runBackend = (url: URL, req: IncomingMessage, body: Buffer) =>
    new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve) => {
      const child = spawn(backend, [], {
        env: {
          GIT_PROJECT_ROOT: repos,
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
        resolve({ status, headers, body: all.subarray(split + 4) });
      });
    });

  const proxy = createHttpsServer(
    { key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) },
    async (req, res) => {
      const body = await readBody(req);
      const url = new URL(req.url!, "https://proxy");
      const header = req.headers.authorization ?? "";
      const [user, password] = header.startsWith("Basic ")
        ? Buffer.from(header.slice(6), "base64").toString("utf8").split(":")
        : [];
      const repoPath = /^\/git\/acme\/([^/]+)\.git\//.exec(url.pathname)?.[1];
      const credential = password === undefined ? undefined : issued.get(password);
      // Like the real Git app: the credential names this repository and, for a push, write access.
      if (!(
        user === "weldall" &&
        credential &&
        credential.repository === repoPath &&
        (credential.access === "write" ||
          !(
            url.pathname.endsWith("/git-receive-pack") ||
            url.searchParams.get("service") === "git-receive-pack"
          ))
      )) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="Weldall git"' });
        res.end("Authentication required.");
        return;
      }
      const app = [...apps.values()].find((candidate) => `app-${candidate.name}` === repoPath);
      if (url.pathname.endsWith("/git-receive-pack") && app) {
        const { commands, capabilities } = readCommands(body);
        for (const { ref } of commands)
          if (ref === `refs/heads/${closeBeforePush}`) {
            closeBeforePush = null;
            for (const pull of pullsOf(app))
              if (`refs/heads/${pull.head}` === ref) pull.state = "closed";
          }
        const reasons = commands.map(({ ref, next }) => {
          const branch = ref.startsWith("refs/heads/") ? ref.slice(11) : null;
          if (!branch || !branch.startsWith(PUBLISH_PREFIX) || /^0+$/.test(next))
            return `weldall: only branches named ${PUBLISH_PREFIX}* can be pushed`;
          const pull = pullsOf(app).filter((candidate) => candidate.head === branch);
          if (pull.length && !pull.some(({ state }) => state === "open"))
            return "weldall: the pull request of this branch is closed or merged; publish to a new branch";
          return null;
        });
        if (reasons.some(Boolean)) {
          for (const { ref, next } of commands) pushes.push({ ref, next, accepted: false });
          const report = Buffer.concat([
            pkt("unpack ok\n"),
            ...commands.map(({ ref }, index) =>
              pkt(`ng ${ref} ${reasons[index] ?? "weldall: another branch was refused"}\n`),
            ),
            Buffer.from("0000"),
          ]);
          const sideband =
            capabilities.includes("side-band-64k") || capabilities.includes("side-band");
          res.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
          res.end(
            sideband
              ? Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), report])), Buffer.from("0000")])
              : report,
          );
          return;
        }
        for (const { ref, next } of commands) {
          const branch = ref.slice(11);
          if (branch === mergeBeforePush) {
            mergeBeforePush = null;
            const pull = pullsOf(app).find(
              (candidate) => candidate.head === branch && candidate.state === "open",
            )!;
            await squashMerge(pull, app);
          }
          pushes.push({ ref, next, accepted: true });
        }
      }
      const answer = await runBackend(url, req, body);
      res.writeHead(answer.status, answer.headers).end(answer.body);
    },
  );
  const origin = `https://127.0.0.1:${await listen(proxy)}`;
  servers.push(proxy);
  /** Where the Git app says its git route is; another origin plays a misconfigured Git app. */
  let remoteOrigin: string | null = null;

  /** The Git app as Weldall registers it (README "Set-up in Weldall"). */
  const gitAppResource = (
    key = GIT_APP_KEY,
    at = origin,
    grantedScopes = ["git-app:publish"],
  ): ResourceRegistryEntry => ({
    key,
    name: `Git app (${key})`,
    resourceIdentifier: `${at}/api`,
    authorizationServer: at,
    downstreamClientId: "weldall-cli-at-git-app",
    requestPrefixes: [`${at}/api`],
    supportedScopes: ["git-app:admin", "git-app:publish"],
    grantedScopes,
  });
  let resources: ResourceRegistryEntry[] = [gitAppResource()];
  const currentResources = () => (apiMode === "old-server" ? [] : resources);
  /** Origins that reach this fake's Git app API; others are unreachable. */
  const apiOrigins = new Set([origin]);
  const apis = () => Object.fromEntries([...apiOrigins].map((at) => [at, apiBase]));
  const openGitApp = testOpenGitApp({
    registry: async () => currentResources(),
    apis,
    requests: apiRequests,
  });

  return {
    root,
    /** The Git app's origin: its git route is `<origin>/git/`. */
    origin,
    weldallOrigin,
    /** Opens the fake Git app the way the CLI does, from the fake registry. */
    gitApps: openGitApp,
    gitAppResource,
    /** Replaces the resource registry Weldall lists for the person. */
    setResources(next: ResourceRegistryEntry[]) {
      resources = next;
    },
    /** Lets another origin reach the fake Git app's API (a moved or second Git app). */
    serveApiAt(at: string) {
      apiOrigins.add(at);
    },
    /** The Git app answers with git URLs at another origin (misconfigured). */
    answerRemotesAt(at: string | null) {
      remoteOrigin = at;
    },
    credentialRequests,
    apiRequests,
    gitWrapper,
    /** Before the next git command whose arguments contain `pattern`, runs `script` in its directory. */
    beforeGit: (pattern: string, script: string) =>
      writeFile(join(control, "pre"), `${pattern}\n${script}\n`),
    /** The next git command whose arguments contain `pattern` is killed before (or after) it runs. */
    killGit: (pattern: string, when: "before" | "after" = "before") =>
      writeFile(join(control, when === "before" ? "fail" : "fail-after"), pattern),
    apps,
    pulls,
    pushes,
    git,
    must,
    commitFiles,
    branchHead,
    /** Environment for the publish step's git: the shim on PATH, no system or user config. */
    publishEnvironment: (): NodeJS.ProcessEnv => {
      const environment = gitEnv({
        GIT_SSL_NO_VERIFY: "1",
        WELDALL_TEST_ISSUER: weldallOrigin,
        WELDALL_TEST_REGISTRY: `${weldallOrigin}/api/me/scopes`,
        WELDALL_TEST_GIT_APP_APIS: JSON.stringify(apis()),
      });
      // The person may have no git identity; publish must not need one.
      for (const name of ["AUTHOR", "COMMITTER"]) {
        delete environment[`GIT_${name}_NAME`];
        delete environment[`GIT_${name}_EMAIL`];
      }
      return environment;
    },
    /** Registers a template: a working repository whose `main` holds `files`. */
    async addTemplate(name: string, files: Record<string, string | Buffer>) {
      const directory = join(root, "templates", name);
      await mkdir(directory, { recursive: true });
      await must(["init", "-q", "-b", "main", directory], root);
      await writeTree(directory, files);
      await must(["add", "-A"], directory);
      await must(["commit", "-q", "-m", `template ${name}`], directory);
      templates.set(name, directory);
      return directory;
    },
    /** Changes the template (a newer template state for apps created later). */
    async updateTemplate(name: string, files: Record<string, string | Buffer | null>) {
      const directory = templates.get(name)!;
      await writeTree(directory, files);
      await must(["add", "-A"], directory);
      await must(["commit", "-q", "-m", "template update"], directory);
    },
    /** A local app folder as an app template creates it: a git repository whose first commit is the template. */
    async createFolder(name: string, template: string, files: Record<string, string | Buffer>) {
      const directory = join(root, "folders", name);
      await mkdir(directory, { recursive: true });
      await must(["init", "-q", "-b", "main", directory], root);
      await writeTree(directory, files);
      await must(["add", "-A"], directory);
      await must(["commit", "-q", "-m", "Template"], directory);
      await must(["config", "weldall.template", template], directory);
      await must(
        ["config", "weldall.templateCommit", await must(["rev-parse", "HEAD"], directory)],
        directory,
      );
      return directory;
    },
    async squashMerge(number: number) {
      const pull = pulls.find((candidate) => candidate.number === number)!;
      await squashMerge(pull, apps.get((pull as FakePull & { app: string }).app)!);
    },
    close(number: number) {
      const pull = pulls.find((candidate) => candidate.number === number)!;
      pull.state = "closed";
    },
    /** The next accepted push to `branch` lands right after the host merged its pull request. */
    mergeBeforeNextPush(branch: string) {
      mergeBeforePush = branch;
    },
    failNextPullRequest() {
      failNextPullRequest = true;
    },
    closeBeforeNextPush(branch: string) {
      closeBeforePush = branch;
    },
    /** An older Weldall: no Git app registered. */
    useOldServer(old: boolean) {
      apiMode = old ? "old-server" : "current";
    },
    /** A Git app without these endpoints (HTML 404). */
    useOldGitApp(old: boolean) {
      apiMode = old ? "old-git-app" : "current";
    },
    async stop() {
      await Promise.all(
        servers.map((server) => new Promise((resolve) => server.close(() => resolve(null)))),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

export type FakeWeldall = Awaited<ReturnType<typeof startFakeWeldall>>;

/** Writes files (null deletes) below `directory`. */
export async function writeTree(directory: string, files: Record<string, string | Buffer | null>) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path);
    if (content === null) {
      await rm(target, { force: true });
      continue;
    }
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
}
