import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LOGIN_SCOPE, type AppHostApp } from "@weldall/sdk";
import { createGitCredentialSigner } from "../src/git/credentials.js";
import { createTransferLimiter, GIT_PROXY_LIMITS } from "../src/git/limits.js";
import { pktLine } from "../src/git/pkt-line.js";
import { GIT_PUSH_REASONS } from "../src/git/rules.js";
import type { GitHost, PullRequestState } from "../src/hosts/git-host.js";
import type { ConfiguredHost } from "../src/hosts/index.js";
import { GIT_PUBLISH_BRANCH_PREFIX } from "../src/publish-branches.js";
import {
  createTestGitApp,
  GIT_APP_ORIGIN,
  GIT_APP_RESOURCE,
  PUBLISH_SCOPE,
} from "./fixtures/git-app.js";
import { gitUnavailableReason, listen, runGit, startGitHttpBackend } from "./fixtures/git-http.js";

/**
 * The git proxy driven by the real git client through the Git app's own HTTP server
 * (`@hono/node-server`), against `git http-backend` as the Git host and the in-process fake
 * Weldall. Ported from the server's `git-proxy-db.test.ts`.
 */

const skipReason = gitUnavailableReason();
const ORGANIZATION = "acme-apps";
/** A GitHub-shaped installation token; it must reach the upstream and nothing else. */
const UPSTREAM_TOKEN = `ghs_${"U".repeat(36)}`;
const UPSTREAM_AUTHORIZATION = `Basic ${Buffer.from(`x-access-token:${UPSTREAM_TOKEN}`).toString("base64")}`;
const publish = (name: string) => `${GIT_PUBLISH_BRANCH_PREFIX}${name}`;
const zero = "0".repeat(40);

let work: string;
let home: string;
let upstreamServer: Server;
let gitAppServer: Server;
let upstream: ReturnType<typeof startGitHttpBackend>;
let upstreamUrl: string;
let base: string;
let pullRequests: Record<string, PullRequestState | null>;
/** Receive-pack requests the upstream had seen when the test started. */
let postsAtStart = 0;
const forwardingCalls: Array<{ repository: { owner: string; name: string }; access: string }> = [];
/** Every git credential issued in a test; none may appear in logs or audit entries. */
const issued: string[] = [];

const people: Record<string, string[]> = {};
const resetPeople = () => {
  for (const key of Object.keys(people)) delete people[key];
  Object.assign(people, {
    alice: [LOGIN_SCOPE, PUBLISH_SCOPE],
    bob: [LOGIN_SCOPE, PUBLISH_SCOPE],
  });
};
resetPeople();

const fakeHost: GitHost = {
  setupMode: "customer-managed",
  protectedPaths: [],
  readCommitIdentity: () => Promise.reject(new Error("not used")),
  checkSetup: () => Promise.reject(new Error("not used")),
  async getForwardingTarget({ repository, access }) {
    forwardingCalls.push({ repository, access });
    // The registry spelling reaches the host, whatever case the URL used.
    return {
      url: new URL(`${upstreamUrl}/${repository.owner}/${repository.name}.git`),
      authorization: UPSTREAM_AUTHORIZATION,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    };
  },
  async readBranchPullRequestState({ branch }) {
    return pullRequests[branch] ?? null;
  },
  createRepository: () => Promise.reject(new Error("not used")),
  resolveNewRepository: () => {
    throw new Error("not used");
  },
  openPullRequest: () => Promise.reject(new Error("not used")),
  readStatus: () => Promise.reject(new Error("not used")),
};
const configuredHost: ConfiguredHost = {
  kind: "github",
  host: fakeHost,
  organization: ORGANIZATION,
  templates: ["react"],
  repositoryWebUrl: ({ owner, name }) => `https://github.com/${owner}/${name}`,
};

let gitApp: Awaited<ReturnType<typeof createTestGitApp>>;
let limiter = createTransferLimiter(GIT_PROXY_LIMITS);

function seedApp(id: string, owner: string, name: string, overrides: Partial<AppHostApp> = {}) {
  const app: AppHostApp = {
    id,
    name,
    purpose: "Test",
    owner: { id: owner },
    resource: "git-app",
    repository: { owner: ORGANIZATION, name, id: null, webUrl: null },
    defaultBranch: "main",
    template: { name: "react", commit: "c".repeat(40) },
    ready: true,
    links: { preview: null, live: null },
    createdAt: "2026-11-01T00:00:00.000Z",
    confirmedAt: null,
    expiresAt: "2027-05-01T00:00:00.000Z",
    state: "active",
    ...overrides,
  };
  gitApp.weldall.apps.set(id, app);
  return app;
}

const remote = (name = "app-demo", owner = ORGANIZATION) => `${base}/git/${owner}/${name}.git`;

async function credential(person: string, access: "read" | "write", name = "app-demo") {
  const { status, json } = await gitApp.call(person, "POST", "/api/git-credentials", {
    body: { path: `git/${ORGANIZATION}/${name}.git`, access },
  });
  if (status !== 200) throw new Error(`credential refused: ${status} ${JSON.stringify(json)}`);
  issued.push(json.password);
  return json.password as string;
}

/** Git with a throwaway credential helper that prints `password` (passed via the environment). */
function git(args: string[], { cwd = work, password }: { cwd?: string; password?: string } = {}) {
  return runGit(
    [
      "-c",
      "credential.helper=",
      "-c",
      'credential.helper=!f() { echo username=weldall; echo "password=$TEST_GIT_PASSWORD"; }; f',
      "-c",
      "credential.useHttpPath=true",
      "-c",
      "http.postBuffer=104857600",
      ...args,
    ],
    { cwd, home, env: password === undefined ? {} : { TEST_GIT_PASSWORD: password } },
  );
}

const upstreamRepo = () => path.join(work, "upstream", ORGANIZATION, "app-demo.git");
const upstreamRef = async (ref: string) =>
  (
    await runGit(["rev-parse", "--verify", "--quiet", ref], { cwd: upstreamRepo(), home })
  ).stdout.trim();
const receivePackPosts = () =>
  upstream.requests.filter(
    ({ method, url }) => method === "POST" && url.endsWith("/git-receive-pack"),
  );
const events = (eventType?: string) =>
  gitApp.weldall.events.filter((event) => !eventType || event.eventType === eventType);
const basic = (password: string) =>
  `Basic ${Buffer.from(`weldall:${password}`).toString("base64")}`;

const emptyPack = () => {
  const header = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
  return Buffer.concat([header, createHash("sha1").update(header).digest()]);
};

/**
 * A receive-pack POST without git: one ref update command, then `pack` bytes, sent chunked (no
 * declared size). With `abortAfterMs` the connection is destroyed instead of finishing the body.
 */
function rawPush(
  password: string,
  command: string,
  pack: Buffer,
  {
    abortAfterMs,
    capabilities = "report-status side-band-64k",
    beforePack = Buffer.alloc(0),
    endBody = true,
  }: { abortAfterMs?: number; capabilities?: string; beforePack?: Buffer; endBody?: boolean } = {},
): Promise<{ status: number | null; body: string }> {
  return new Promise((resolve) => {
    let status: number | null = null;
    let body = "";
    const request = httpRequest(new URL(`${remote()}/git-receive-pack`), {
      // A fresh connection: a kept-alive one may still carry the unread rest of an earlier body.
      agent: false,
      method: "POST",
      headers: {
        authorization: basic(password),
        "content-type": "application/x-git-receive-pack-request",
        "transfer-encoding": "chunked",
      },
    });
    request.on("response", (response) => {
      status = response.statusCode ?? null;
      response.on("data", (chunk: Buffer) => (body += chunk.toString("latin1")));
      response.on("end", () => resolve({ status, body }));
      response.on("error", () => resolve({ status, body }));
    });
    request.on("error", () => resolve({ status, body }));
    request.write(
      Buffer.concat([pktLine(`${command}\0${capabilities}\n`), Buffer.from("0000"), beforePack]),
    );
    request.write(pack);
    if (endBody) request.end();
    if (abortAfterMs !== undefined)
      setTimeout(() => {
        request.destroy();
        resolve({ status, body });
      }, abortAfterMs);
  });
}

let cloneCount = 0;
async function cloneAs(person = "alice") {
  const dir = path.join(work, `clone-${++cloneCount}`);
  const result = await git(["clone", remote(), dir], {
    password: await credential(person, "read"),
  });
  expect(result.stderr).not.toContain("fatal");
  expect(result.code).toBe(0);
  return dir;
}

async function commitFile(dir: string, name: string, content: string | Buffer) {
  await writeFile(path.join(dir, name), content);
  await runGit(["add", name], { cwd: dir, home });
  await runGit(["commit", "-q", "-m", `Add ${name}`], { cwd: dir, home });
}

describe.skipIf(skipReason !== null)(
  `git proxy with real git against git http-backend${skipReason ? ` (skipped: real git unavailable: ${skipReason})` : ""}`,
  () => {
    beforeAll(async () => {
      work = await mkdtemp(path.join(tmpdir(), "git-app-proxy-"));
      home = path.join(work, "home");
      await runGit(["init", "-q", home], { cwd: work, home: work });
      await runGit(["init", "-q", "--bare", "-b", "main", upstreamRepo()], { cwd: work, home });
      await runGit(["config", "http.receivepack", "true"], { cwd: upstreamRepo(), home });
      // The host would act on push options; the hook records any that reach it, and can be
      // slowed down to let a client leave before the host answers.
      await runGit(["config", "receive.advertisePushOptions", "true"], {
        cwd: upstreamRepo(),
        home,
      });
      const hook = path.join(upstreamRepo(), "hooks", "pre-receive");
      await writeFile(
        hook,
        `#!/bin/sh\n[ "\${GIT_PUSH_OPTION_COUNT:-0}" != 0 ] && echo "$GIT_PUSH_OPTION_0" >> "${work}/push-options.log"\n[ -f "${work}/slow" ] && sleep 2\nexit 0\n`,
      );
      await chmod(hook, 0o755);
      const seed = path.join(work, "seed");
      await runGit(["init", "-q", "-b", "main", seed], { cwd: work, home });
      await commitFile(seed, "README.md", "# Demo\n");
      await runGit(["push", "-q", upstreamRepo(), "main"], { cwd: seed, home });

      upstream = startGitHttpBackend({
        root: path.join(work, "upstream"),
        authorization: UPSTREAM_AUTHORIZATION,
      });
      upstreamServer = upstream.server;
      upstreamUrl = await listen(upstreamServer);

      gitApp = await createTestGitApp({ host: () => configuredHost, people });
      gitAppServer = createAdaptorServer({ fetch: (request) => gitApp.fetch(request) }) as Server;
      await new Promise<void>((resolve) => gitAppServer.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(gitAppServer.address() as AddressInfo).port}`;
    }, 30_000);

    afterAll(async () => {
      await new Promise((resolve) => gitAppServer?.close(resolve));
      await new Promise((resolve) => upstreamServer?.close(resolve));
      if (work) await rm(work, { recursive: true, force: true });
    });

    const useProxy = (limits: Partial<typeof GIT_PROXY_LIMITS> = {}, shared?: typeof limiter) => {
      limiter = shared ?? createTransferLimiter({ ...GIT_PROXY_LIMITS, ...limits });
      gitApp.reset({ gitProxy: { limits, limiter } });
      seedApp("app0001", "alice", "app-demo");
      seedApp("app0002", "bob", "app-bobs");
      seedApp("app0003", "alice", "app_x");
      seedApp("app0004", "bob", "app-x");
      seedApp("app0005", "alice", "app-new", {
        ready: false,
        template: { name: "react", commit: null },
      });
    };

    beforeEach(() => {
      resetPeople();
      pullRequests = {};
      forwardingCalls.length = 0;
      issued.length = 0;
      postsAtStart = receivePackPosts().length;
      useProxy();
    });

    afterEach(async () => {
      // Entries are written when response streams end, possibly just after git exits.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const recorded = JSON.stringify({ logs: gitApp.logs, events: gitApp.weldall.events });
      for (const secret of [UPSTREAM_TOKEN, UPSTREAM_AUTHORIZATION, ...issued])
        expect(recorded).not.toContain(secret);
      expect(recorded).not.toContain("wgc_");
    });

    it("answers git's first request without credentials with a Basic challenge, unaudited", async () => {
      const response = await fetch(`${remote()}/info/refs?service=git-upload-pack`);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
      expect(await fetch(`${remote()}/HEAD`).then(({ status }) => status)).toBe(404);
      expect(gitApp.weldall.calls).toEqual([]);
    });

    it("issues a read credential by default, bound to the person's ready app, and audits it", async () => {
      const { status, json } = await gitApp.call("alice", "POST", "/api/git-credentials", {
        body: { path: `git/${ORGANIZATION}/APP-DEMO.git` },
      });
      expect(status).toBe(200);
      issued.push(json.password);
      expect(json).toEqual({
        username: "weldall",
        password: expect.stringMatching(/^wgc_/),
        expiresAt: expect.any(String),
      });
      const [entry] = events("git_credential.issued");
      expect(entry).toMatchObject({
        subject: "alice",
        appId: "app0001",
        details: { access: "read", expiresAt: json.expiresAt },
      });
      // The read credential cannot push (checked in the next test with git); here: its access.
      const push = await fetch(`${remote()}/info/refs?service=git-receive-pack`, {
        headers: { authorization: basic(json.password) },
      });
      expect(await push.text()).toContain("this git credential is read-only and cannot push");
      expect(forwardingCalls).toEqual([]);
    });

    it.each([
      ["another person's app", "app-bobs", 404],
      ["an unknown repository", "app-none", 404],
      ["a repository still being created", "app-new", 409],
      ["a path with wildcards", "app-%", 400],
    ])("refuses a credential for %s", async (_name, name, status) => {
      const result = await gitApp.call("alice", "POST", "/api/git-credentials", {
        body: { path: `git/${ORGANIZATION}/${name}.git`, access: "write" },
      });
      expect(result.status).toBe(status);
      expect(events("git_credential.denied")).toEqual([
        expect.objectContaining({ subject: "alice", details: { access: "write" } }),
      ]);
      expect(events("git_credential.issued")).toHaveLength(0);
    });

    it("issues at most 20 credentials per person and minute, also in parallel", async () => {
      const ask = () =>
        gitApp
          .call("alice", "POST", "/api/git-credentials", {
            body: { path: `git/${ORGANIZATION}/app-demo.git` },
          })
          .then(({ status, json }) => {
            if (status === 200) issued.push(json.password);
            return status;
          });
      expect(await ask()).toBe(200);
      const statuses = await Promise.all(Array.from({ length: 24 }, ask));
      expect(statuses.filter((status) => status === 200)).toHaveLength(19);
      expect(statuses.filter((status) => status === 429)).toHaveLength(5);
      expect(events("git_credential.issued")).toHaveLength(20);
    });

    it("treats _ in a repository name literally", async () => {
      const issue = (name: string, person = "alice") =>
        gitApp
          .call(person, "POST", "/api/git-credentials", {
            body: { path: `git/${ORGANIZATION}/${name}.git` },
          })
          .then(({ status, json }) => {
            if (status === 200) issued.push(json.password);
            return status;
          });
      expect(await issue("app_x")).toBe(200);
      expect(await issue("APP_X")).toBe(200);
      expect(await issue("app-x")).toBe(404);
      expect(await issue("app-x", "bob")).toBe(200);
      expect(await issue("app_demo")).toBe(404);
    });

    it("refuses to issue when Weldall does not store the issued entry", async () => {
      gitApp.weldall.fail("reportAuditEvent", new Error("network"), new Error("network"));
      const { status, json } = await gitApp.call("alice", "POST", "/api/git-credentials", {
        body: { path: `git/${ORGANIZATION}/app-demo.git`, access: "write" },
      });
      expect(status).toBe(503);
      expect(json.error).toBe("audit_unavailable");
      expect(JSON.stringify(json)).not.toContain("wgc_");
    });

    it("clones and fetches through the proxy and audits each fetch once", async () => {
      const dir = await cloneAs();
      expect((await runGit(["log", "--format=%s"], { cwd: dir, home })).stdout.trim()).toBe(
        "Add README.md",
      );
      const seed = path.join(work, "seed");
      await commitFile(seed, "CHANGELOG.md", "upstream change\n");
      await runGit(["push", "-q", upstreamRepo(), "main"], { cwd: seed, home });
      const fetched = await git(
        ["-c", "http.extraHeader=Cookie: session=client-cookie", "fetch", "origin"],
        { cwd: dir, password: await credential("alice", "read") },
      );
      expect(fetched.code).toBe(0);
      // Clone and fetch, each once; protocol v2's ls-refs POST is not a fetch.
      await expect.poll(() => events("git_fetch.completed").length).toBe(2);
      const [first] = events("git_fetch.completed");
      expect(first).toMatchObject({
        subject: "alice",
        appId: "app0001",
        details: { upstreamStatus: 200, credentialId: expect.any(String) },
      });
      expect((first!.details as { responseBytes: number }).responseBytes).toBeGreaterThan(0);
      // Neither the client's credential nor its cookies reach the host; the token is a read token.
      const forwarded = upstream.requests.at(-1)!;
      expect(forwarded.headers.authorization).toBe(UPSTREAM_AUTHORIZATION);
      expect(forwarded.headers.cookie).toBeUndefined();
      expect(new Set(forwardingCalls.map(({ access }) => access))).toEqual(new Set(["read"]));
      expect(forwardingCalls[0]!.repository).toEqual({ owner: ORGANIZATION, name: "app-demo" });
      // Every request asked Weldall again.
      expect(gitApp.weldall.callsOf("checkSubjectScopes").length).toBeGreaterThanOrEqual(4);
    });

    it("forwards a push to a publish branch only after Weldall stored git_push.forwarded", async () => {
      const dir = await cloneAs();
      await commitFile(dir, "app.ts", "export const app = 1;\n");
      const head = (await runGit(["rev-parse", "HEAD"], { cwd: dir, home })).stdout.trim();
      const original = gitApp.weldall.api.reportAuditEvent;
      const postsWhenForwarded: number[] = [];
      gitApp.weldall.api.reportAuditEvent = async (input) => {
        if (input.eventType === "git_push.forwarded")
          postsWhenForwarded.push(receivePackPosts().length);
        return original(input);
      };
      const before = receivePackPosts().length;
      const pushed = await git(["push", "origin", `HEAD:refs/heads/${publish("one")}`], {
        cwd: dir,
        password: await credential("alice", "write"),
      });
      expect(pushed.stderr).toContain(`* [new branch]      HEAD -> ${publish("one")}`);
      expect(pushed.code).toBe(0);
      expect(await upstreamRef(`refs/heads/${publish("one")}`)).toBe(head);
      expect(postsWhenForwarded).toEqual([before]);
      expect(receivePackPosts()).toHaveLength(before + 1);
      await expect.poll(() => events("git_push.completed").length).toBe(1);
      const pushEvents = events().filter(({ eventType }) => eventType.startsWith("git_push."));
      expect(pushEvents.map(({ eventType }) => eventType)).toEqual([
        "git_push.forwarded",
        "git_push.completed",
      ]);
      const refUpdates = [
        { ref: `refs/heads/${publish("one")}`, oldCommit: zero, newCommit: head },
      ];
      expect(pushEvents[0]).toMatchObject({
        subject: "alice",
        appId: "app0001",
        details: { refUpdates, refUpdateCount: 1 },
      });
      expect(pushEvents[1]).toMatchObject({
        details: { refUpdates, refUpdateCount: 1, upstreamStatus: 200 },
      });
      expect((pushEvents[1]!.details as { requestBytes: number }).requestBytes).toBeGreaterThan(0);
      expect(forwardingCalls.some(({ access }) => access === "write")).toBe(true);
      // A second push to the same branch updates it (its pull request is open).
      pullRequests[publish("one")] = "open";
      await commitFile(dir, "more.ts", "export const more = 1;\n");
      const again = await git(["push", "origin", `HEAD:refs/heads/${publish("one")}`], {
        cwd: dir,
        password: await credential("alice", "write"),
      });
      expect(again.code).toBe(0);
    });

    it.each([
      ["the default branch", "HEAD:refs/heads/main", "main", GIT_PUSH_REASONS.defaultBranch],
      [
        "another branch",
        "HEAD:refs/heads/feature",
        "feature",
        GIT_PUSH_REASONS.onlyPublishBranches,
      ],
      ["a tag", "HEAD:refs/tags/v1", "v1", GIT_PUSH_REASONS.tag],
    ])(
      "refuses a push to %s with git's readable message and leaves the host unchanged",
      async (_n, refspec, shown, reason) => {
        const dir = await cloneAs();
        await commitFile(dir, `${shown}.txt`, "change\n");
        const mainBefore = await upstreamRef("refs/heads/main");
        const receivePacks = receivePackPosts().length;
        const pushed = await git(["push", "origin", refspec], {
          cwd: dir,
          password: await credential("alice", "write"),
        });
        expect(pushed.code).not.toBe(0);
        expect(pushed.stderr).toContain(`! [remote rejected] HEAD -> ${shown} (${reason})`);
        expect(await upstreamRef("refs/heads/main")).toBe(mainBefore);
        expect(await upstreamRef(refspec.split(":")[1]!)).toBe(shown === "main" ? mainBefore : "");
        expect(receivePackPosts()).toHaveLength(receivePacks);
        expect(events("git_push.forwarded")).toHaveLength(0);
        expect(events("git_push.denied").at(-1)).toMatchObject({
          subject: "alice",
          appId: "app0001",
          reason: expect.stringContaining(reason),
        });
      },
    );

    it("refuses deleting a branch and pushing to a merged pull request's branch", async () => {
      const dir = await cloneAs();
      await commitFile(dir, "x.txt", "x\n");
      expect(
        (
          await git(["push", "origin", `HEAD:refs/heads/${publish("del")}`], {
            cwd: dir,
            password: await credential("alice", "write"),
          })
        ).code,
      ).toBe(0);
      const deleted = await git(["push", "origin", `:refs/heads/${publish("del")}`], {
        cwd: dir,
        password: await credential("alice", "write"),
      });
      expect(deleted.stderr).toContain(
        `! [remote rejected] ${publish("del")} (${GIT_PUSH_REASONS.deletion})`,
      );
      expect(await upstreamRef(`refs/heads/${publish("del")}`)).not.toBe("");

      pullRequests[publish("del")] = "merged";
      await commitFile(dir, "y.txt", "y\n");
      const merged = await git(["push", "origin", `HEAD:refs/heads/${publish("del")}`], {
        cwd: dir,
        password: await credential("alice", "write"),
      });
      expect(merged.stderr).toContain(`(${GIT_PUSH_REASONS.pullRequestClosed})`);
    });

    it("refuses wrong-repository, read-only, expired and tampered credentials", async () => {
      const dir = await cloneAs();
      await commitFile(dir, "z.txt", "z\n");
      const push = (password: string) =>
        git(["push", "origin", `HEAD:refs/heads/${publish("creds")}`], { cwd: dir, password });

      const readOnly = await push(await credential("alice", "read"));
      expect(readOnly.stderr).toContain("remote error: weldall: this git credential is read-only");

      // Bob's credential for his own app does not open Alice's repository.
      const foreign = await push(await credential("bob", "write", "app-bobs"));
      expect(foreign.stderr).toContain(
        "remote error: weldall: this git credential is not valid for this repository",
      );
      const lsForeign = await git(["ls-remote", remote()], {
        password: await credential("bob", "read", "app-bobs"),
      });
      expect(lsForeign.code).not.toBe(0);

      const signer = (now: Date) =>
        createGitCredentialSigner({
          keys: gitApp.config.gitCredentialKeys,
          resource: GIT_APP_RESOURCE,
          now: () => now,
        });
      const claims = {
        subject: "alice",
        appId: "app0001",
        repository: { owner: ORGANIZATION, name: "app-demo" },
        access: "write" as const,
      };
      const expired = signer(new Date(Date.now() - 10 * 60_000)).issue(claims).password;
      issued.push(expired);
      expect((await push(expired)).stderr).toContain("Authentication failed");
      expect(events("git_push.denied").at(-1)).toMatchObject({
        subject: "alice",
        reasonCode: "invalid_grant",
        reason: "The git credential has expired.",
      });

      const valid = signer(new Date()).issue({ ...claims, access: "read" }).password;
      const [head, payload, mac] = valid.split(".") as [string, string, string];
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as unknown[];
      decoded[5] = "w";
      const tampered = `${head}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${mac}`;
      issued.push(valid, tampered);
      const deniedBefore = events("git_push.denied").length;
      expect((await push(tampered)).stderr).toContain("Authentication failed");
      // A credential this instance did not sign is logged, never audited.
      expect(events("git_push.denied")).toHaveLength(deniedBefore);
      expect(await upstreamRef(`refs/heads/${publish("creds")}`)).toBe("");
      expect(receivePackPosts().length).toBe(postsAtStart);
    });

    it("answers made-up credentials with 401 without asking or writing to Weldall", async () => {
      const before = gitApp.weldall.calls.length;
      for (let index = 0; index < 5; index += 1) {
        const response = await fetch(
          `${remote(`whatever-${index}`)}/info/refs?service=git-upload-pack`,
          {
            headers: {
              authorization: basic(`wgc_${"a".repeat(8)}.${"b".repeat(20)}.${"c".repeat(43)}`),
            },
          },
        );
        expect(response.status).toBe(401);
        const garbage = await fetch(`${remote()}/info/refs?service=git-receive-pack`, {
          headers: { authorization: basic(`not-a-credential-${index}`) },
        });
        expect(garbage.status).toBe(401);
      }
      expect(gitApp.weldall.calls.length).toBe(before);
      expect(gitApp.weldall.events).toEqual([]);
      expect(
        gitApp.logs.filter(({ message }) => message.includes("invalid credential")),
      ).toHaveLength(10);
    });

    it("refuses at the next request once the publish scope is revoked", async () => {
      const read = await credential("alice", "read");
      const write = await credential("alice", "write");
      people.alice = [LOGIN_SCOPE];
      const cloned = await git(["clone", remote(), path.join(work, "revoked")], { password: read });
      expect(cloned.code).not.toBe(0);
      expect(cloned.stderr).toContain(
        `remote error: weldall: You lack the permission ${PUBLISH_SCOPE}`,
      );
      const ls = await fetch(`${remote()}/info/refs?service=git-receive-pack`, {
        headers: { authorization: basic(write) },
      });
      expect(await ls.text()).toContain("You lack the permission");
      people.alice = [PUBLISH_SCOPE];
      const noLogin = await fetch(`${remote()}/info/refs?service=git-upload-pack`, {
        headers: { authorization: basic(read) },
      });
      expect(await noLogin.text()).toContain("You may no longer use Weldall");
      expect(events("git_fetch.denied").at(-1)).toMatchObject({
        subject: "alice",
        reasonCode: "scope_not_granted",
      });
      expect(forwardingCalls).toEqual([]);
    });

    it("refuses a push once the app changed owner after the credential was issued", async () => {
      const dir = await cloneAs();
      await commitFile(dir, "owner.txt", "o\n");
      const password = await credential("alice", "write");
      const app = gitApp.weldall.apps.get("app0001")!;
      gitApp.weldall.apps.set("app0001", { ...app, owner: { id: "bob" } });
      const pushed = await git(["push", "origin", `HEAD:refs/heads/${publish("owner")}`], {
        cwd: dir,
        password,
      });
      expect(pushed.stderr).toContain("weldall: this app belongs to another person");
      expect(await upstreamRef(`refs/heads/${publish("owner")}`)).toBe("");
      // The rejection does not link another person's app.
      expect(events("git_push.denied").at(-1)).toMatchObject({ subject: "alice", appId: null });
    });

    it("refuses a push with a readable message when Weldall is unreachable, forwarding nothing", async () => {
      const dir = await cloneAs();
      await commitFile(dir, "w.txt", "w\n");
      const password = await credential("alice", "write");
      // Unreachable for the permission check of the ref advertisement:
      gitApp.weldall.fail("checkSubjectScopes", new Error("network"));
      const atAdvertisement = await git(["push", "origin", `HEAD:refs/heads/${publish("w")}`], {
        cwd: dir,
        password,
      });
      expect(atAdvertisement.stderr).toContain(
        "remote error: weldall: Weldall could not be reached",
      );
      // Reachable for the checks, but the forwarded entry cannot be stored (one retry):
      gitApp.weldall.fail("reportAuditEvent", new Error("network"), new Error("network"));
      const atAudit = await git(["push", "origin", `HEAD:refs/heads/${publish("w")}`], {
        cwd: dir,
        password,
      });
      expect(atAudit.code).not.toBe(0);
      expect(atAudit.stderr).toContain(
        `! [remote rejected] HEAD -> ${publish("w")} (${GIT_PUSH_REASONS.auditUnavailable})`,
      );
      // Unreachable for the checks of the receive-pack request itself:
      const original = gitApp.weldall.api.checkSubjectScopes;
      let calls = 0;
      gitApp.weldall.api.checkSubjectScopes = async (...args) => {
        // The advertisement passes; the POST that follows finds Weldall gone.
        if (++calls === 2) throw new Error("network");
        return original(...args);
      };
      gitApp.weldall.calls.length = 0;
      const atPost = await git(["push", "origin", `HEAD:refs/heads/${publish("w")}`], {
        cwd: dir,
        password,
      });
      expect(atPost.stderr).toContain(
        `! [remote rejected] HEAD -> ${publish("w")} (weldall: Weldall could not be reached`,
      );
      expect(receivePackPosts().length).toBe(postsAtStart);
      expect(await upstreamRef(`refs/heads/${publish("w")}`)).toBe("");
      expect(events("git_push.forwarded")).toHaveLength(0);
      expect(events("git_push.failed").length).toBeGreaterThan(0);
    });

    it("leaves the expected old state to the host and audits its refusal", async () => {
      const head = await upstreamRef("refs/heads/main");
      const create = `${zero} ${head} refs/heads/${publish("stale")}`;
      const first = await rawPush(await credential("alice", "write"), create, emptyPack());
      expect(first.status).toBe(200);
      expect(await upstreamRef(`refs/heads/${publish("stale")}`)).toBe(head);
      const second = await rawPush(await credential("alice", "write"), create, emptyPack());
      expect(second.status).toBe(200);
      expect(second.body).toContain(`ng refs/heads/${publish("stale")}`);
      await expect
        .poll(() => events("git_push.failed").at(-1))
        .toMatchObject({
          reason: expect.stringContaining(`The Git host refused: refs/heads/${publish("stale")}`),
          details: { upstreamStatus: 200 },
        });
    });

    const pushOptionsLog = () =>
      readFile(path.join(work, "push-options.log"), "utf8").catch(() => "");

    it.each([
      ["with a value", "report-status push-options=1", 200],
      ["behind a tab", "report-status\tpush-options", 400],
      ["behind two spaces", "report-status  push-options", 400],
      ["announced plainly", "report-status push-options", 200],
    ])("never lets push options %s reach the host", async (_name, capabilities, status) => {
      const head = await upstreamRef("refs/heads/main");
      const branch = `refs/heads/${publish(`opt-${capabilities.length}`)}`;
      const result = await rawPush(
        await credential("alice", "write"),
        `${zero} ${head} ${branch}`,
        emptyPack(),
        {
          capabilities,
          beforePack: Buffer.concat([pktLine("evil.option=1\n"), Buffer.from("0000")]),
        },
      );
      expect(result.status).toBe(status);
      if (status === 200) expect(result.body).toContain(GIT_PUSH_REASONS.pushOptions);
      expect(await pushOptionsLog()).toBe("");
      expect(await upstreamRef(branch)).toBe("");
      expect(receivePackPosts().length).toBe(postsAtStart);
    });

    it("checks, audits and forwards the same ref name byte for byte", async () => {
      const head = await upstreamRef("refs/heads/main");
      const result = await rawPush(
        await credential("alice", "write"),
        `${zero} ${head} refs/heads/${publish("nb")} `,
        emptyPack(),
      );
      expect(result.body).toContain(GIT_PUSH_REASONS.invalidBranch);
      const refs = await runGit(["for-each-ref", "--format=%(refname)"], {
        cwd: upstreamRepo(),
        home,
      });
      expect(refs.stdout).not.toContain(publish("nb"));
    });

    it("audits a push the host applied although the client left before the answer", async () => {
      await writeFile(path.join(work, "slow"), "1");
      try {
        const head = await upstreamRef("refs/heads/main");
        const branch = `refs/heads/${publish("gone")}`;
        await rawPush(
          await credential("alice", "write"),
          `${zero} ${head} ${branch}`,
          emptyPack(),
          {
            abortAfterMs: 500,
          },
        );
        await expect.poll(() => upstreamRef(branch), { timeout: 5_000 }).toBe(head);
        await expect
          .poll(() => events("git_push.completed").at(-1)?.details, { timeout: 5_000 })
          .toMatchObject({ refUpdates: [{ ref: branch, newCommit: head }] });
        expect(events("git_push.forwarded").at(-1)!.details).toMatchObject({
          refUpdates: [{ ref: branch }],
        });
        await expect.poll(() => limiter.active).toBe(0);
      } finally {
        await rm(path.join(work, "slow"), { force: true });
      }
    }, 15_000);

    it("stops a push above the size limit before the host stores it", async () => {
      useProxy({ pushMaxBytes: 64 * 1024 });
      const dir = await cloneAs();
      await commitFile(dir, "big.bin", randomBytes(256 * 1024));
      const pushed = await git(["push", "origin", `HEAD:refs/heads/${publish("big")}`], {
        cwd: dir,
        password: await credential("alice", "write"),
      });
      expect(pushed.code).not.toBe(0);
      expect(pushed.stderr).toContain("413");
      expect(await upstreamRef(`refs/heads/${publish("big")}`)).toBe("");
      // Git announced the size, so the proxy refused before reading anything.
      expect(events("git_push.denied").at(-1)).toMatchObject({
        reason: expect.stringContaining("exceeds the 64 KB limit"),
      });
      // Without a declared size the proxy counts while forwarding and cuts the upstream request.
      const head = await upstreamRef("refs/heads/main");
      const chunked = await rawPush(
        await credential("alice", "write"),
        `${zero} ${head} refs/heads/${publish("big")}`,
        randomBytes(256 * 1024),
      );
      expect(chunked.status).toBe(413);
      expect(chunked.body).toContain("weldall: the push exceeds the 64 KB limit");
      await expect
        .poll(() => events("git_push.failed").at(-1), { timeout: 5_000 })
        .toMatchObject({ reason: expect.stringContaining("exceeds the 64 KB limit") });
      expect(await upstreamRef(`refs/heads/${publish("big")}`)).toBe("");
      expect(limiter.active).toBe(0);
    });

    it("holds a transfer slot while reading a push's command list and frees it on every path", async () => {
      const shared = createTransferLimiter({
        maxConcurrentTransfers: 16,
        maxConcurrentTransfersPerUser: 1,
      });
      useProxy({}, shared);
      const password = await credential("alice", "write");
      const read = await credential("alice", "read");
      // A push that never finishes its command list.
      const stalled = httpRequest(new URL(`${remote()}/git-receive-pack`), {
        agent: false,
        method: "POST",
        headers: {
          authorization: basic(password),
          "content-type": "application/x-git-receive-pack-request",
          "transfer-encoding": "chunked",
        },
      });
      stalled.on("error", () => {});
      stalled.write("00a0");
      await expect.poll(() => shared.active).toBe(1);
      const second = await fetch(`${remote()}/info/refs?service=git-upload-pack`, {
        headers: { authorization: basic(read) },
      });
      expect(second.status).toBe(429);
      stalled.destroy();
      await expect.poll(() => shared.active).toBe(0);
      // A refused push is drained while holding the slot, and frees it afterwards.
      const head = await upstreamRef("refs/heads/main");
      const refused = await rawPush(
        password,
        `${zero} ${head} refs/heads/main`,
        randomBytes(32 * 1024),
      );
      expect(refused.body).toContain(GIT_PUSH_REASONS.defaultBranch);
      expect(shared.active).toBe(0);
    });

    it("refuses transfers above the concurrency limit with Retry-After", async () => {
      const shared = createTransferLimiter({
        maxConcurrentTransfers: 16,
        maxConcurrentTransfersPerUser: 1,
      });
      useProxy({}, shared);
      const held = shared.acquire("alice");
      try {
        const response = await fetch(`${remote()}/info/refs?service=git-upload-pack`, {
          headers: { authorization: basic(await credential("alice", "read")) },
        });
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe(
          String(GIT_PROXY_LIMITS.retryAfterSeconds),
        );
      } finally {
        if ("release" in held) held.release();
      }
    });

    it("propagates a client abort mid-push to the host and frees the transfer slot", async () => {
      const password = await credential("alice", "write");
      const head = await upstreamRef("refs/heads/main");
      await rawPush(
        password,
        `${zero} ${head} refs/heads/${publish("abort")}`,
        randomBytes(64 * 1024),
        {
          abortAfterMs: 300,
          endBody: false,
        },
      );
      await expect
        .poll(() => events("git_push.failed").at(-1), { timeout: 5_000 })
        .toMatchObject({ reason: expect.stringContaining("client closed the connection") });
      await expect.poll(() => limiter.active).toBe(0);
      expect(await upstreamRef(`refs/heads/${publish("abort")}`)).toBe("");
    });

    it("returns the git remote URL of this instance with the app", async () => {
      const { status, json } = await gitApp.call("alice", "GET", "/api/apps/app0001");
      expect(status).toBe(200);
      expect(json.git).toEqual({
        remotePath: `/git/${ORGANIZATION}/app-demo.git`,
        remoteUrl: `${GIT_APP_ORIGIN}/git/${ORGANIZATION}/app-demo.git`,
      });
    });
  },
);
