/**
 * A local stand-in for Weldall, a registry registered in it, and the Git host, for publish tests
 * with the real `/usr/bin/git`:
 *
 * - Weldall: the resource registry for the person (the registry as a registered resource with its
 *   own origin, authorization server and scopes) and the app list `GET /api/me/apps`, whose
 *   `registries` (endpoint, permissions, git route and git credential endpoint) are the only place
 *   the CLI finds a registry;
 * - the registry's protected resource metadata, which announces an apps API like a real registry's
 *   does; the CLI must never read it (`metadataReads` counts the reads);
 * - the registry's git route `https://<origin>/git/<owner>/<repository>.git` on 127.0.0.1 in front
 *   of `git http-backend`, which asks for Basic auth, accepts only credentials the fake registry
 *   issued for that repository, and refuses pushes like the real registry (publish branches only,
 *   none to a branch whose pull request is merged or closed), with the same `weldall: <reason>`
 *   status lines;
 * - the registry's API (`/api/apps`, `/api/apps/{id}`, `/api/apps/{id}/status`,
 *   `/api/apps/{id}/pull-requests`, `/api/apps/{id}/confirm`, `/api/git-credentials`,
 *   `/api/admin/apps`, `/api/admin/apps/{id}/owner`, `/api/admin/checklist`), reached over plain
 *   HTTP through `testOpenRegistry` (the stand-in's certificate is self-signed; the token exchange
 *   is left out, see `test-registries.ts`);
 * - helpers that play the reviewer and the Git host: commit to a branch, squash-merge or close a
 *   pull request; the administrator: change the resource registry; and the registry's answers:
 *   queue a refusal for the next matching request.
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
import { testOpenRegistry } from "./test-registries.js";

export const GIT = "/usr/bin/git";
const GIT_PATH = "/git";
export const REGISTRY_KEY = "registry";
export const SCOPES = {
  agents: "registry:agents",
  publish: "registry:publish",
  admin: "registry:admin",
} as const;
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
  description: string;
  scopes: string[];
  url: string | null;
  template: string;
  /** Repository name below the organisation, e.g. `app-expenses`. */
  repository: string;
  bare: string;
  owner: string | null;
  removedAt: string | null;
}

/** An answer the fake registry gives once, for the next request that matches. */
export interface QueuedAnswer {
  method: string;
  path: RegExp;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** The request is handled as usual first and only its answer is replaced (a lost answer). */
  afterHandling?: boolean;
}

/** The repository slug the registry derives from an app's name. */
export const slugOf = (name: string) =>
  `app-${name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;

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
  let apiMode: "current" | "old-server" | "old-registry" = "current";
  /**
   * What Weldall lists in `registries`: each registry resource publishing changes, keeping apps
   * without publishing changes, none at all, or an answer without the key (an older server).
   */
  let listing: "changes" | "apps" | "none" | "absent" = "changes";
  /** Replaces keys of every listed registry (a listing that does not match the registration). */
  let listingPatch: Record<string, unknown> = {};
  /** Reads of the registry's own metadata; the CLI must never make one. */
  const metadataReads: string[] = [];
  const queued: QueuedAnswer[] = [];
  const created: Array<Record<string, unknown>> = [];
  let markerFile = false;
  /** Statuses the git route answers the next requests with (429/503 with Retry-After). */
  const gitLimits: number[] = [];
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

  /** Answers that replace what a handled request would have answered. */
  const replaced = new WeakMap<import("node:http").ServerResponse, QueuedAnswer>();
  const json = (
    res: import("node:http").ServerResponse,
    status: number,
    value: unknown,
    headers: Record<string, string> = {},
  ) => {
    const instead = replaced.get(res);
    if (instead) {
      res.writeHead(instead.status, { "content-type": "application/json", ...instead.headers });
      res.end(JSON.stringify(instead.body));
      return;
    }
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(value));
  };
  const refuse = (
    res: import("node:http").ServerResponse,
    status: number,
    error: string,
    description: string,
  ) => json(res, status, { error, error_description: description });

  /** The person the fake registry serves; another owner's app is someone else's. */
  const PERSON = "user-1";
  const entry = (app: FakeApp) => ({
    id: app.id,
    name: app.name,
    description: app.description,
    scopes: app.scopes,
    url: app.url,
    repository: {
      name: `acme/${app.repository}`,
      url: `https://github.example/acme/${app.repository}`,
    },
    template: app.template,
    revision: 1,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    confirmedAt: confirmed.get(app.id) ?? null,
    expiresAt: confirmed.has(app.id) ? "2027-02-16T09:00:00.000Z" : "2027-02-01T10:00:00.000Z",
    state: "active",
    removedAt: app.removedAt,
    removedReason: app.removedAt ? "marker_missing" : null,
  });
  const administered = (app: FakeApp) => ({
    ...entry(app),
    owner: app.owner,
    ownerAssignedBy: null,
    ownerAssignedAt: null,
    confirmedBy: confirmed.has(app.id) ? app.owner : null,
  });
  const ownApps = () => [...apps.values()].filter((app) => app.owner === PERSON);

  /** The registry's metadata and API, as plain HTTP (see the module note). */
  const api = createHttpServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url!, "http://fake");
    const at = String(req.headers["x-test-origin"] ?? origin);
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      metadataReads.push(at);
      return json(res, 200, {
        resource: `${at}/api`,
        authorization_servers: [at],
        scopes_supported: [SCOPES.agents, SCOPES.publish, SCOPES.admin],
        weldall_agents_api: { endpoint: `${at}/api/agents`, scope: SCOPES.agents },
        weldall_apps_api: {
          endpoint: `${at}/api/apps`,
          scope: SCOPES.publish,
          git: `${at}/git/`,
          gitCredentials: `${at}/api/git-credentials`,
        },
      });
    }
    if (apiMode === "old-registry") {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<html>Not Found</html>");
    }
    apiRequests.push({
      origin: at,
      scope: String(req.headers["x-test-scope"] ?? ""),
      method: req.method!,
      path: `${url.pathname}${url.search}`,
      ...(body.length ? { body: JSON.parse(body.toString("utf8")) as unknown } : {}),
    });
    const next = queued.findIndex(
      (answer) => answer.method === req.method && answer.path.test(url.pathname),
    );
    if (next !== -1) {
      const [answer] = queued.splice(next, 1);
      if (answer!.afterHandling) replaced.set(res, answer!);
      else return json(res, answer!.status, answer!.body, answer!.headers);
    }
    const input = body.length ? (JSON.parse(body.toString("utf8")) as Record<string, unknown>) : {};
    if (url.pathname === "/api/git-credentials" && req.method === "POST") {
      credentialRequests.push({
        path: String(input.path),
        access: typeof input.access === "string" ? input.access : "read",
      });
      const repository = /^git\/acme\/([^/]+)\.git$/.exec(String(input.path ?? ""))?.[1];
      const app = ownApps().find((candidate) => candidate.repository === repository);
      if (!app) return refuse(res, 404, "not_found", "No app of yours uses this repository.");
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
    const admin = req.headers["x-test-scope"] === SCOPES.admin;
    if (url.pathname.startsWith("/api/admin/") && !admin)
      return refuse(res, 403, "insufficient_scope", "Admin scope required.");
    if (url.pathname === "/api/admin/checklist" && req.method === "GET") {
      const appId = url.searchParams.get("app");
      const app = appId === null ? null : appOf(appId);
      if (appId !== null && !app) return refuse(res, 404, "not_found", "No app has this id.");
      return json(res, 200, {
        host: { kind: "github", organization: "acme" },
        repository: app ? { owner: "acme", name: app.repository } : null,
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
    if (url.pathname === "/api/admin/apps" && req.method === "GET") {
      const all = [...apps.values()].filter(
        (app) => url.searchParams.get("owner") !== "none" || app.owner === null,
      );
      const page = Number(url.searchParams.get("page") ?? 1);
      const pageSize = Number(url.searchParams.get("pageSize") ?? 50);
      return json(res, 200, {
        resource: `${at}/api`,
        apps: all.slice((page - 1) * pageSize, page * pageSize).map(administered),
        total: all.length,
        page,
        pageSize,
        reverificationDays: 90,
        expiringSoonDays: 14,
      });
    }
    const owner = /^\/api\/admin\/apps\/([^/]+)\/owner$/.exec(url.pathname);
    if (owner && req.method === "PUT") {
      const app = appOf(decodeURIComponent(owner[1]!));
      if (!app) return refuse(res, 404, "not_found", "No app has this id.");
      if (input.owner === "nobody-known")
        return refuse(res, 409, "owner_not_allowed", "Weldall does not know the owner.");
      app.owner = String(input.owner);
      return json(res, 200, { app: administered(app) });
    }
    if (url.pathname === "/api/apps" && req.method === "GET")
      return json(res, 200, {
        resource: `${at}/api`,
        apps: ownApps().map(entry),
        reverificationDays: 90,
        expiringSoonDays: 14,
      });
    const confirm = /^\/api\/apps\/([^/]+)\/confirm$/.exec(url.pathname);
    if (confirm && req.method === "POST") {
      const app = appOf(decodeURIComponent(confirm[1]!));
      if (!app || app.owner !== PERSON)
        return refuse(res, 404, "not_found", "No app of yours has this id.");
      confirmed.set(app.id, "2026-11-18T09:00:00.000Z");
      return json(res, 200, { app: entry(app) });
    }
    if (url.pathname === "/api/apps" && req.method === "POST") {
      created.push(input);
      const name = String(input.name);
      const repository = slugOf(name);
      const existing = [...apps.values()].find((app) => app.repository === repository);
      if (existing && existing.owner !== PERSON)
        return refuse(res, 409, "app_exists", "Another person already has an app of this name.");
      let app = existing;
      if (!app) {
        const templateDir = templates.get(String(input.template));
        if (!templateDir) return refuse(res, 400, "unknown_template", "Unknown template.");
        appCounter += 1;
        app = {
          id: `app_${String(appCounter).padStart(20, "0")}`,
          name,
          description: String(input.description),
          scopes: Array.isArray(input.scopes) ? (input.scopes as string[]) : [],
          url: typeof input.url === "string" ? input.url : null,
          template: String(input.template),
          repository,
          bare: join(repos, "acme", `${repository}.git`),
          owner: PERSON,
          removedAt: null,
        };
        await must(["init", "-q", "--bare", "-b", "main", app.bare], root);
        await must(["fetch", "-q", templateDir, "main:refs/heads/template"], app.bare);
        // GitHub's template copy: the template's content as a new first commit, then the
        // registry's marker file on top.
        const tree = await must(["rev-parse", "refs/heads/template^{tree}"], app.bare);
        const commit = await must(["commit-tree", tree], app.bare, { input: "Initial commit" });
        await must(["update-ref", "refs/heads/main", commit], app.bare);
        await must(["update-ref", "-d", "refs/heads/template"], app.bare);
        if (markerFile)
          await commitFiles(
            app.bare,
            "main",
            { "weldall-app.yml": `version: 1\nname: ${name}\ndescription: Tests\n` },
            `Add weldall-app.yml\n\nWeldall-App-Id: ${app.id}`,
          );
        apps.set(app.id, app);
      }
      return json(res, 200, { created: !existing, app: entry(app) });
    }
    const one = /^\/api\/apps\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const app = appOf(decodeURIComponent(one[1]!));
      if (!app || app.owner !== PERSON)
        return refuse(res, 404, "not_found", "No app of yours has this id.");
      return json(res, 200, { app: entry(app) });
    }
    const match = /^\/api\/apps\/([^/]+)\/(status|pull-requests)$/.exec(url.pathname);
    const app = match ? appOf(decodeURIComponent(match[1]!)) : undefined;
    if (!match || !app || app.owner !== PERSON)
      return refuse(res, 404, "not_found", "No app of yours has this id.");
    if (match[2] === "status") {
      const branch = url.searchParams.get("branch");
      const candidates = pullsOf(app).filter((pull) => branch === null || pull.head === branch);
      const pull = candidates.find(({ state }) => state === "open") ?? candidates.at(-1);
      return json(res, 200, {
        app: { id: app.id, name: app.name },
        pullRequest: pull
          ? {
              number: pull.number,
              webUrl: `https://github.example/acme/${app.repository}/pull/${pull.number}`,
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
      return refuse(res, 503, "upstream_unavailable", "GitHub is unavailable.");
    }
    const open = pullsOf(app).find((pull) => pull.head === input.head && pull.state === "open");
    if (!(await branchHead(app.bare, String(input.head))))
      return refuse(res, 409, "branch_not_found", "Branch not found.");
    const pull =
      open ??
      Object.assign(
        {
          number: pulls.length + 1,
          head: String(input.head),
          title: String(input.title),
          body: typeof input.body === "string" ? input.body : "",
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
        webUrl: `https://github.example/acme/${app.repository}/pull/${pull.number}`,
        headBranch: pull.head,
        baseBranch: "main",
        headCommit: await branchHead(app.bare, pull.head),
      },
      requestedReviewers: { users: [], teams: ["reviewers"] },
      warnings: [],
    });
  });
  const apiBase = `http://127.0.0.1:${await listen(api)}`;
  servers.push(api);

  /** The registries Weldall lists: every registry resource (one that supports the publish scope). */
  const listedRegistries = () =>
    listing === "none"
      ? []
      : currentResources()
          .filter((resource) => resource.supportedScopes.includes(SCOPES.publish))
          .map((resource) => {
            const at = resource.authorizationServer;
            return {
              key: resource.key,
              name: resource.name,
              resource: resource.resourceIdentifier,
              endpoint: `${at}/api/apps`,
              scope: SCOPES.publish,
              allowed: resource.grantedScopes.includes(SCOPES.publish),
              adminScope: SCOPES.admin,
              adminAllowed: resource.grantedScopes.includes(SCOPES.admin),
              git: listing === "changes" ? `${at}/git/` : null,
              gitCredentials: listing === "changes" ? `${at}/api/git-credentials` : null,
              ...listingPatch,
            };
          });

  /** Weldall: the resource registry and the app list for the person, as plain HTTP. */
  const weldall = createHttpServer(async (req, res) => {
    const url = new URL(req.url!, "http://fake");
    if (url.pathname === "/api/me/scopes") return json(res, 200, currentResources());
    if (url.pathname === "/api/me/apps" && apiMode !== "old-server")
      return json(res, 200, {
        items: [],
        warnings: [],
        ...(listing === "absent" ? {} : { registries: listedRegistries() }),
      });
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
      // The git route's limits answer before anything else, as the registry's proxy does.
      if (gitLimits.length) {
        const status = gitLimits.shift()!;
        res.writeHead(status, { "content-type": "text/plain", "retry-after": "1" });
        res.end("weldall: too many git requests of yours in the last minute; retry in 1 s\n");
        return;
      }
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
      const app = [...apps.values()].find((candidate) => candidate.repository === repoPath);
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
  /** The registry as Weldall registers it (the registry's README, "Run it locally"). */
  const registryResource = (
    key = REGISTRY_KEY,
    at = origin,
    grantedScopes: string[] = [SCOPES.agents, SCOPES.publish],
  ): ResourceRegistryEntry => ({
    key,
    name: `Registry (${key})`,
    resourceIdentifier: `${at}/api`,
    authorizationServer: at,
    downstreamClientId: "weldall-cli-at-registry",
    requestPrefixes: [`${at}/api`],
    supportedScopes: [SCOPES.admin, SCOPES.agents, SCOPES.publish],
    grantedScopes,
  });
  let resources: ResourceRegistryEntry[] = [registryResource()];
  const currentResources = () => (apiMode === "old-server" ? [] : resources);
  /** Origins that reach this fake registry's metadata and API; others are unreachable. */
  const apiOrigins = new Set([origin]);
  const apis = () => Object.fromEntries([...apiOrigins].map((at) => [at, apiBase]));
  const openRegistry = testOpenRegistry({
    registry: async () => currentResources(),
    apps: async () => {
      const response = await fetch(`${weldallOrigin}/api/me/apps`);
      return response.status === 404 ? null : ((await response.json()) as unknown);
    },
    apis,
  });

  return {
    root,
    /** The registry's origin: its git route is `<origin>/git/`. */
    origin,
    weldallOrigin,
    /** Opens the fake registry the way the CLI does, from the fake resource registry. */
    registries: openRegistry,
    registryResource,
    /** Replaces the resource registry Weldall lists for the person. */
    setResources(next: ResourceRegistryEntry[]) {
      resources = next;
    },
    /** Lets another origin reach the fake registry (a moved or second registry). */
    serveApiAt(at: string) {
      apiOrigins.add(at);
    },
    /** Makes another origin unreachable again. */
    unserveApiAt(at: string) {
      if (at !== origin) apiOrigins.delete(at);
    },
    /**
     * What Weldall lists in `registries`: registries publishing changes (default), keeping apps
     * only, none, or an answer without the key.
     */
    listRegistries(what: "changes" | "apps" | "none" | "absent") {
      listing = what;
    },
    /** Replaces keys of every registry Weldall lists. */
    patchListing(patch: Record<string, unknown>) {
      listingPatch = patch;
    },
    /** The next request matching `method` and `path` gets this answer instead. */
    queueAnswer(answer: QueuedAnswer) {
      queued.push(answer);
    },
    /** The next git requests are refused with these statuses and `Retry-After: 1`. */
    limitGitRequests(...statuses: number[]) {
      gitLimits.push(...statuses);
    },
    /** Created apps get the registry's `weldall-app.yml` on their default branch. */
    addMarkerFile(on: boolean) {
      markerFile = on;
    },
    /** Every `POST /api/apps` body. */
    created,
    metadataReads,
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
        WELDALL_TEST_APPS: `${weldallOrigin}/api/me/apps`,
        WELDALL_TEST_REGISTRY_APIS: JSON.stringify(apis()),
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
    /** An older Weldall: no registry registered, no app list. */
    useOldServer(old: boolean) {
      apiMode = old ? "old-server" : "current";
    },
    /** A registry without these endpoints (HTML 404). */
    useOldRegistry(old: boolean) {
      apiMode = old ? "old-registry" : "current";
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
