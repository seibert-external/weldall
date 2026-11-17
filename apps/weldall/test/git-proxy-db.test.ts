import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import { createApp } from "../src/server/app-registry/service";
import type { AuthorizedConnectorActor } from "../src/server/connectors/contracts";
import type { GitHost, PullRequestState } from "../src/server/connectors/git-host";
import { issueGitCredential } from "../src/server/git-proxy/credentials";
import { createGitProxy } from "../src/server/git-proxy/handler";
import { createTransferLimiter, GIT_PROXY_LIMITS } from "../src/server/git-proxy/limits";
import { pktLine } from "../src/server/git-proxy/pkt-line";
import { GIT_PUBLISH_BRANCH_PREFIX, GIT_PUSH_REASONS } from "../src/server/git-proxy/rules";
import {
  gitUnavailableReason,
  listen,
  runGit,
  serveHandler,
  startGitHttpBackend,
} from "./fixtures/git-http";

const target = "postgresql://postgres@localhost:5433/postgres";
// Use the operator-approved local database or CI's existing disposable test service; never reset either here.
const approvedTarget =
  process.env.POSTGRES_URL === target ||
  /^postgresql:\/\/postgres@localhost:5433\/weldall_connector_test_[a-f0-9]{32}$/.test(
    process.env.POSTGRES_URL ?? "",
  ) ||
  (process.env.CI === "true" &&
    process.env.POSTGRES_URL === "postgresql://postgres:postgres@localhost:5432/postgres");
const gitMissing = gitUnavailableReason();
const skipReason = !approvedTarget
  ? "no approved test database"
  : gitMissing
    ? `real git unavailable: ${gitMissing}`
    : null;

const prefix = `gitproxy-${randomUUID()}`;
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
const key = `${prefix}-gh`;
const upstreamAuthorization = `Basic ${Buffer.from("x-access-token:upstream-test-token").toString("base64")}`;
const publish = (name: string) => `${GIT_PUBLISH_BRANCH_PREFIX}${name}`;

let work: string;
let home: string;
let upstreamServer: Server;
let proxyServer: Server;
let upstream: ReturnType<typeof startGitHttpBackend>;
let proxyUrl: string;
let upstreamUrl: string;
let aliceAppId: string;
let pullRequests: Record<string, PullRequestState | null>;
let limiter = createTransferLimiter(GIT_PROXY_LIMITS);
let proxy = createGitProxy();

const fakeHost: GitHost = {
  setupMode: "customer-managed",
  protectedPaths: [],
  readCommitIdentity: () => Promise.reject(new Error("not used")),
  checkSetup: () => Promise.reject(new Error("not used")),
  async getForwardingTarget({ repository }) {
    // The registry spelling reaches the host, whatever case the URL used.
    return {
      url: new URL(`${upstreamUrl}/${repository.owner}/${repository.name}.git`),
      authorization: upstreamAuthorization,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    };
  },
  async readBranchPullRequestState({ branch }) {
    if (branch in pullRequests) return pullRequests[branch]!;
    return null;
  },
  createRepository: () => Promise.reject(new Error("not used")),
  resolveNewRepository: () => {
    throw new Error("not used");
  },
  openPullRequest: () => Promise.reject(new Error("not used")),
  readStatus: () => Promise.reject(new Error("not used")),
};

const useProxy = (options: Parameters<typeof createGitProxy>[0] = {}) => {
  limiter = options.limiter ?? createTransferLimiter({ ...GIT_PROXY_LIMITS, ...options.limits });
  proxy = createGitProxy({ openHost: async () => fakeHost, ...options, limiter });
};

const person = (id: string): AuthorizedConnectorActor =>
  ({
    type: "user",
    id,
    email: `${id}@example.com`,
    requestId: randomUUID(),
    scopeKeys: [],
  }) as never;
const remote = (owner = "acme", name = "demo") => `${proxyUrl}/git/${key}/${owner}/${name}.git`;

async function credential(userId: string, access: "read" | "write", name = "demo") {
  return (
    await issueGitCredential({
      actor: person(userId),
      input: { path: `git/${key}/acme/${name}.git`, access },
    })
  ).password;
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

const upstreamRepo = () => path.join(work, "upstream", "Acme", "demo.git");
const upstreamRef = async (ref: string) =>
  (
    await runGit(["rev-parse", "--verify", "--quiet", ref], { cwd: upstreamRepo(), home })
  ).stdout.trim();

async function pushAudits(eventType: string) {
  return db.auditEvent.findMany({
    where: { actorId: { startsWith: prefix }, eventType },
    orderBy: { occurredAt: "asc" },
  });
}

const receivePackPosts = () =>
  upstream.requests.filter(
    ({ method, url }) => method === "POST" && url.endsWith("/git-receive-pack"),
  );

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
        authorization: `Basic ${Buffer.from(`x:${password}`).toString("base64")}`,
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
async function cloneAs(userId = alice) {
  const dir = path.join(work, `clone-${++cloneCount}`);
  const result = await git(["clone", remote(), dir], {
    password: await credential(userId, "read"),
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
  `git proxy with real git against git http-backend${skipReason ? ` (skipped: ${skipReason})` : ""}`,
  () => {
    beforeAll(async () => {
      if (!approvedTarget) throw new Error("Unsafe database target");
      work = await mkdtemp(path.join(tmpdir(), "weldall-git-proxy-"));
      home = path.join(work, "home");
      await runGit(["init", "-q", home], { cwd: work, home: work });
      // Upstream repository with one commit on main.
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
        authorization: upstreamAuthorization,
      });
      upstreamServer = upstream.server;
      upstreamUrl = await listen(upstreamServer);
      proxyServer = serveHandler(() => proxy);
      proxyUrl = await listen(proxyServer);

      for (const id of [alice, bob])
        await db.user.create({
          data: { id, name: id, email: `${id}@example.com`, emailVerified: true },
        });
      const connector = await db.connector.create({
        data: {
          key,
          name: "Git host",
          providerType: "github-app",
          enabled: true,
          providerConfig: {},
          envelopeProvider: "LOCAL_ENV",
          createdBy: alice,
          updatedBy: alice,
        },
      });
      const app = (name: string, ownerId: string) =>
        createApp({
          name,
          purpose: "Test",
          ownerId,
          // Registry spelling differs in case from the URLs the tests use.
          repository: { connectorId: connector.id, owner: "Acme", name },
          defaultBranch: "main",
          template: { name: "starter", commit: "c".repeat(40) },
        });
      aliceAppId = (await app("demo", alice)).id;
      await app("bobs", bob);
      await app("damo", bob);
      await app("my_app", alice);
      await app("my-app", bob);
    }, 30_000);

    afterAll(async () => {
      await new Promise((resolve) => proxyServer?.close(resolve));
      await new Promise((resolve) => upstreamServer?.close(resolve));
      if (!approvedTarget) return;
      await db.gitCredential.deleteMany({ where: { userId: { startsWith: prefix } } });
      await db.app.deleteMany({ where: { ownerId: { startsWith: prefix } } });
      await db.connector.deleteMany({ where: { key } });
      await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
      await db.auditEvent.deleteMany({ where: { actorId: { startsWith: prefix } } });
      if (work) await rm(work, { recursive: true, force: true });
    });

    beforeEach(async () => {
      // Tests issue more credentials than the per-minute limit allows one person.
      await db.gitCredential.deleteMany({ where: { userId: { startsWith: prefix } } });
      pullRequests = {};
      useProxy();
    });

    it("answers git's first request without credentials with a Basic challenge", async () => {
      const response = await fetch(`${remote()}/info/refs?service=git-upload-pack`);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
      expect(await fetch(`${remote()}/HEAD`).then(({ status }) => status)).toBe(404);
    });

    it("clones and fetches through the proxy and audits each fetch once", async () => {
      const before = (await pushAudits("git_fetch.completed")).length;
      const dir = await cloneAs();
      expect((await runGit(["log", "--format=%s"], { cwd: dir, home })).stdout.trim()).toBe(
        "Add README.md",
      );
      // Someone else adds a commit upstream, so the fetch has something to transfer.
      const seed = path.join(work, "seed");
      await commitFile(seed, "CHANGELOG.md", "upstream change\n");
      await runGit(["push", "-q", upstreamRepo(), "main"], { cwd: seed, home });
      const fetched = await git(
        ["-c", "http.extraHeader=Cookie: session=client-cookie", "fetch", "origin"],
        { cwd: dir, password: await credential(alice, "read") },
      );
      expect(fetched.code).toBe(0);
      // Clone and fetch, each once; protocol v2's ls-refs POST is not a fetch. Entries are
      // written when the response stream ends, possibly just after git exits.
      await expect
        .poll(async () => (await pushAudits("git_fetch.completed")).length - before)
        .toBe(2);
      const audits = await pushAudits("git_fetch.completed");
      expect(audits.at(-2)!.metadata).toMatchObject({
        appId: aliceAppId,
        repositoryOwner: "Acme",
        repositoryName: "demo",
        upstreamStatus: 200,
      });
      expect((audits.at(-2)!.metadata as { responseBytes: number }).responseBytes).toBeGreaterThan(
        0,
      );
      // Neither the client's credential nor its cookies reach the host.
      const forwarded = upstream.requests.at(-1)!;
      expect(forwarded.headers.authorization).toBe(upstreamAuthorization);
      expect(forwarded.headers.cookie).toBeUndefined();
    });

    it("forwards a push to a publish branch and audits the ref update", async () => {
      const dir = await cloneAs();
      await commitFile(dir, "app.ts", "export const app = 1;\n");
      const head = (await runGit(["rev-parse", "HEAD"], { cwd: dir, home })).stdout.trim();
      const pushed = await git(["push", "origin", `HEAD:refs/heads/${publish("one")}`], {
        cwd: dir,
        password: await credential(alice, "write"),
      });
      expect(pushed.stderr).toContain(`* [new branch]      HEAD -> ${publish("one")}`);
      expect(pushed.code).toBe(0);
      expect(await upstreamRef(`refs/heads/${publish("one")}`)).toBe(head);
      await expect
        .poll(async () => (await pushAudits("git_push.completed")).length)
        .toBeGreaterThan(0);
      const [audit] = (await pushAudits("git_push.completed")).slice(-1);
      expect(audit).toMatchObject({ outcome: "success", subjectId: aliceAppId, actorId: alice });
      expect(audit!.metadata).toMatchObject({
        refUpdates: [
          { ref: `refs/heads/${publish("one")}`, oldCommit: "0".repeat(40), newCommit: head },
        ],
        refUpdateCount: 1,
        upstreamStatus: 200,
      });
      // A second push to the same branch updates it (its pull request is open).
      pullRequests[publish("one")] = "open";
      await commitFile(dir, "more.ts", "export const more = 1;\n");
      const again = await git(["push", "origin", `HEAD:refs/heads/${publish("one")}`], {
        cwd: dir,
        password: await credential(alice, "write"),
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
          password: await credential(alice, "write"),
        });
        expect(pushed.code).not.toBe(0);
        expect(pushed.stderr).toContain(`! [remote rejected] HEAD -> ${shown} (${reason})`);
        expect(await upstreamRef("refs/heads/main")).toBe(mainBefore);
        expect(await upstreamRef(refspec.split(":")[1]!)).toBe(shown === "main" ? mainBefore : "");
        expect(receivePackPosts()).toHaveLength(receivePacks);
        const [denied] = (await pushAudits("git_push.denied")).slice(-1);
        expect(denied!.metadata).toMatchObject({ reason: expect.stringContaining(reason) });
      },
    );

    it("refuses deleting a branch and pushing to a merged pull request's branch", async () => {
      const dir = await cloneAs();
      await commitFile(dir, "x.txt", "x\n");
      expect(
        (
          await git(["push", "origin", `HEAD:refs/heads/${publish("del")}`], {
            cwd: dir,
            password: await credential(alice, "write"),
          })
        ).code,
      ).toBe(0);
      const deleted = await git(["push", "origin", `:refs/heads/${publish("del")}`], {
        cwd: dir,
        password: await credential(alice, "write"),
      });
      expect(deleted.stderr).toContain(
        `! [remote rejected] ${publish("del")} (${GIT_PUSH_REASONS.deletion})`,
      );
      expect(await upstreamRef(`refs/heads/${publish("del")}`)).not.toBe("");

      pullRequests[publish("del")] = "merged";
      await commitFile(dir, "y.txt", "y\n");
      const merged = await git(["push", "origin", `HEAD:refs/heads/${publish("del")}`], {
        cwd: dir,
        password: await credential(alice, "write"),
      });
      expect(merged.stderr).toContain(`(${GIT_PUSH_REASONS.pullRequestClosed})`);
    });

    it("refuses wrong, expired, read-only and foreign credentials", async () => {
      const dir = await cloneAs();
      await commitFile(dir, "z.txt", "z\n");
      const push = (password: string, url = "origin") =>
        git(["push", url, `HEAD:refs/heads/${publish("creds")}`], { cwd: dir, password });

      const wrong = await push(`wgc_${"a".repeat(25)}.${"b".repeat(43)}`);
      expect(wrong.stderr).toContain("Authentication failed");

      const expired = await credential(alice, "write");
      await db.gitCredential.update({
        where: { id: expired.slice(4, expired.indexOf(".")) },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      expect((await push(expired)).stderr).toContain("Authentication failed");
      expect((await pushAudits("git_push.denied")).at(-1)).toMatchObject({
        reasonCode: "invalid_grant",
      });

      const readOnly = await push(await credential(alice, "read"));
      expect(readOnly.stderr).toContain("remote error: weldall: this git credential is read-only");

      // Bob's credential for his own app does not open Alice's repository.
      const foreign = await push(await credential(bob, "write", "bobs"));
      expect(foreign.stderr).toContain(
        "remote error: weldall: this git credential is not valid for this repository",
      );
      const cloneForeign = await git(["ls-remote", remote()], {
        password: await credential(bob, "read", "bobs"),
      });
      expect(cloneForeign.code).not.toBe(0);

      // An app that changed owner after the credential was issued is refused.
      const issued = await credential(alice, "write");
      await db.app.update({ where: { id: aliceAppId }, data: { ownerId: bob } });
      try {
        expect((await push(issued)).stderr).toContain(
          "weldall: this app belongs to another person",
        );
      } finally {
        await db.app.update({ where: { id: aliceAppId }, data: { ownerId: alice } });
      }
      expect(await upstreamRef(`refs/heads/${publish("creds")}`)).toBe("");
    });

    it("leaves the expected old state to the host and audits its refusal", async () => {
      const head = await upstreamRef("refs/heads/main");
      // A pack without objects: the new branch points at a commit the host already has.
      const header = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
      const emptyPack = Buffer.concat([header, createHash("sha1").update(header).digest()]);
      const create = `${"0".repeat(40)} ${head} refs/heads/${publish("stale")}`;
      const first = await rawPush(await credential(alice, "write"), create, emptyPack);
      expect(first.status).toBe(200);
      expect(await upstreamRef(`refs/heads/${publish("stale")}`)).toBe(head);
      // Creating it again claims an old state (no branch) that no longer holds.
      const second = await rawPush(await credential(alice, "write"), create, emptyPack);
      expect(second.status).toBe(200);
      expect(second.body).toContain(`ng refs/heads/${publish("stale")}`);
      // The entry is written when the response stream ends.
      await expect
        .poll(async () => (await pushAudits("git_push.failed")).at(-1)?.metadata)
        .toMatchObject({
          reason: expect.stringContaining(`The Git host refused: refs/heads/${publish("stale")}`),
          upstreamStatus: 200,
        });
    });

    const emptyPack = () => {
      const header = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
      return Buffer.concat([header, createHash("sha1").update(header).digest()]);
    };
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
        await credential(alice, "write"),
        `${"0".repeat(40)} ${head} ${branch}`,
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
    });

    it.each([
      ["no status report", "quiet", GIT_PUSH_REASONS.noStatusReport, 403],
      [
        "an unknown capability",
        "report-status no-thin",
        "unsupported push capability no-thin",
        200,
      ],
    ])("refuses a push with %s", async (_name, capabilities, reason, status) => {
      const head = await upstreamRef("refs/heads/main");
      const branch = `refs/heads/${publish(`caps-${capabilities.length}`)}`;
      const result = await rawPush(
        await credential(alice, "write"),
        `${"0".repeat(40)} ${head} ${branch}`,
        emptyPack(),
        { capabilities },
      );
      expect(result.status).toBe(status);
      expect(result.body).toContain(reason);
      expect(await upstreamRef(branch)).toBe("");
    });

    it("checks, audits and forwards the same ref name byte for byte", async () => {
      const head = await upstreamRef("refs/heads/main");
      const result = await rawPush(
        await credential(alice, "write"),
        `${"0".repeat(40)} ${head} refs/heads/${publish("nb")}\u00a0`,
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
          await credential(alice, "write"),
          `${"0".repeat(40)} ${head} ${branch}`,
          emptyPack(),
          { abortAfterMs: 500 },
        );
        await expect.poll(() => upstreamRef(branch), { timeout: 5_000 }).toBe(head);
        await expect
          .poll(async () => (await pushAudits("git_push.completed")).at(-1)?.metadata, {
            timeout: 5_000,
          })
          .toMatchObject({ refUpdates: [{ ref: branch, newCommit: head }] });
        expect((await pushAudits("git_push.forwarded")).at(-1)!.metadata).toMatchObject({
          refUpdates: [{ ref: branch }],
        });
        await expect.poll(() => limiter.active).toBe(0);
      } finally {
        await rm(path.join(work, "slow"), { force: true });
      }
    }, 15_000);

    it("refuses a push when its forwarded entry cannot be written", async () => {
      const head = await upstreamRef("refs/heads/main");
      const branch = `refs/heads/${publish("noaudit")}`;
      const password = await credential(alice, "write");
      // Make the audit store reject exactly the forwarded entry.
      await db.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION weldall_test_block_forwarded() RETURNS trigger AS $$
         BEGIN IF NEW."eventType" = 'git_push.forwarded' THEN RAISE EXCEPTION 'blocked'; END IF;
         RETURN NEW; END $$ LANGUAGE plpgsql`,
      );
      await db.$executeRawUnsafe(
        `CREATE TRIGGER weldall_test_block_forwarded BEFORE INSERT ON "AuditEvent"
         FOR EACH ROW EXECUTE FUNCTION weldall_test_block_forwarded()`,
      );
      try {
        const result = await rawPush(password, `${"0".repeat(40)} ${head} ${branch}`, emptyPack());
        expect(result.body).toContain(GIT_PUSH_REASONS.auditUnavailable);
      } finally {
        await db.$executeRawUnsafe(`DROP TRIGGER weldall_test_block_forwarded ON "AuditEvent"`);
        await db.$executeRawUnsafe(`DROP FUNCTION weldall_test_block_forwarded()`);
      }
      expect(await upstreamRef(branch)).toBe("");
      expect(receivePackPosts().at(-1)?.url).not.toContain("noaudit");
    });

    it("treats _ and % in a path literally", async () => {
      const issue = (name: string, userId = alice) =>
        issueGitCredential({
          actor: person(userId),
          input: { path: `git/${key}/acme/${name}.git`, access: "read" },
        }).then(
          () => "issued",
          (error: { code: string }) => error.code,
        );
      expect(await issue("dem_")).toBe("not_found");
      expect(await issue("d_mo")).toBe("not_found");
      // `%` never even passes the path syntax.
      expect(await issue("de%")).toBe("invalid_request");
      // `my_app` stays reachable for its owner although `my-app` belongs to someone else.
      expect(await issue("my_app")).toBe("issued");
      expect(await issue("MY_APP")).toBe("issued");
      expect(await issue("my-app")).toBe("not_found");
      expect(await issue("my-app", bob)).toBe("issued");
    });

    it("stops a push above the size limit before the host stores it", async () => {
      useProxy({ limits: { pushMaxBytes: 64 * 1024 } });
      const dir = await cloneAs();
      await commitFile(dir, "big.bin", randomBytes(256 * 1024));
      const pushed = await git(["push", "origin", `HEAD:refs/heads/${publish("big")}`], {
        cwd: dir,
        password: await credential(alice, "write"),
      });
      expect(pushed.code).not.toBe(0);
      expect(pushed.stderr).toContain("413");
      expect(await upstreamRef(`refs/heads/${publish("big")}`)).toBe("");
      // Git announced the size, so the proxy refused before reading anything.
      expect((await pushAudits("git_push.denied")).at(-1)!.metadata).toMatchObject({
        reason: expect.stringContaining("exceeds the 64 KB limit"),
      });
      // Without a declared size the proxy counts while forwarding and cuts the upstream request.
      const head = await upstreamRef("refs/heads/main");
      const chunked = await rawPush(
        await credential(alice, "write"),
        `${"0".repeat(40)} ${head} refs/heads/${publish("big")}`,
        randomBytes(256 * 1024),
      );
      expect(chunked.status).toBe(413);
      expect(chunked.body).toContain("weldall: the push exceeds the 64 KB limit");
      await expect
        .poll(async () => (await pushAudits("git_push.failed")).at(-1)?.metadata, {
          timeout: 5_000,
        })
        .toMatchObject({ reason: expect.stringContaining("exceeds the 64 KB limit") });
      expect(await upstreamRef(`refs/heads/${publish("big")}`)).toBe("");
      expect(limiter.active).toBe(0);
    });

    it("refuses transfers above the concurrency limit with Retry-After", async () => {
      const shared = createTransferLimiter({
        maxConcurrentTransfers: 16,
        maxConcurrentTransfersPerUser: 1,
      });
      useProxy({ limiter: shared });
      const held = shared.acquire(alice);
      try {
        const response = await fetch(`${remote()}/info/refs?service=git-upload-pack`, {
          headers: {
            authorization: `Basic ${Buffer.from(`x:${await credential(alice, "read")}`).toString("base64")}`,
          },
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
      const password = await credential(alice, "write");
      const head = await upstreamRef("refs/heads/main");
      await rawPush(
        password,
        `${"0".repeat(40)} ${head} refs/heads/${publish("abort")}`,
        randomBytes(64 * 1024),
        { abortAfterMs: 300, endBody: false },
      );
      await expect
        .poll(async () => (await pushAudits("git_push.failed")).at(-1)?.metadata, {
          timeout: 5_000,
        })
        .toMatchObject({ reason: expect.stringContaining("client closed the connection") });
      expect(limiter.active).toBe(0);
      expect(await upstreamRef(`refs/heads/${publish("abort")}`)).toBe("");
    });
  },
);
