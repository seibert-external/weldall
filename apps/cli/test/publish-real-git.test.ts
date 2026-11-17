import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishApp, type PublishOptions } from "../src/publish/publish.js";
import { readAppStatus } from "../src/publish/status.js";
import type { PublishError } from "../src/publish/errors.js";
import { publishJson } from "../src/publish/report.js";
import { createPublishApi } from "../src/publish/weldall-api.js";
import {
  BOT_IDENTITY,
  fakeWeldallUnavailable,
  GIT,
  startFakeWeldall,
  writeTree,
  type FakeWeldall,
} from "./fixtures/fake-weldall-git.js";

/**
 * The spike's publish cases (SCHRITTE.md, "Publish von Hand und Rückweg") with the real
 * `/usr/bin/git`, through an imitation of the git proxy and fake Weldall endpoints.
 */

const reason = fakeWeldallUnavailable();
const lines = (count: number, change: Record<number, string> = {}) =>
  Array.from({ length: count }, (_, index) => change[index + 1] ?? `line ${index + 1}`).join("\n") +
  "\n";
const png = (fill: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, fill, fill, 0, 1, 2]);
const TEMPLATE = {
  "README.md": "# Template\n\nIntro\n",
  "src/app.ts": "export const app = 1;\n",
  "src/notes.ts": lines(10),
  "src/legacy.ts": "export const legacy = true;\n",
  "src/a.ts": "a\n",
  "src/b.ts": "b\n",
  "src/c.ts": "c\n",
  "src/d.ts": "d\n",
  ".github/workflows/ci.yml": "name: ci\n",
  ".env.example": "API_KEY=\n",
  ".npmrc": "auto-install-peers=true\n",
  ".gitignore": "node_modules/\n",
  "logo.png": png(1),
};
// Built at runtime so no credential-shaped literal sits in the source.
const fakeGitHubToken = ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

describe.skipIf(reason !== null)(
  `publish with real git${reason ? ` (skipped: ${reason})` : ""}`,
  { timeout: 120_000 },
  () => {
    let fake: FakeWeldall;
    let counter = 0;

    beforeAll(async () => {
      fake = await startFakeWeldall();
      await fake.addTemplate("react", TEMPLATE);
    }, 60_000);
    afterAll(async () => {
      await fake?.stop();
    });

    const publish = (directory: string, options: Partial<PublishOptions> = {}) =>
      publishApp({
        directory,
        api: fake.api,
        git: GIT,
        environment: fake.publishEnvironment(),
        app: { name: options.app?.name ?? "unused", purpose: "Tests publishing" },
        ...options,
      });
    /** A new folder from the template, published once (PR #n with `changes`). */
    async function published(
      changes: Record<string, string | Buffer | null> = { "src/app.ts": "export const app = 2;\n" },
    ) {
      counter += 1;
      const name = `app${counter}`;
      const folder = await fake.createFolder(name, "react", TEMPLATE);
      await writeTree(folder, changes);
      const first = await publish(folder, { app: { name, purpose: "Tests" } });
      expect(first.outcome).toBe("published");
      return {
        folder,
        name,
        first,
        bare: [...fake.apps.values()].find((app) => app.name === name)!.bare,
      };
    }
    const inFolder = (folder: string, args: string[]) => fake.must(args, folder);
    const status = (folder: string) => inFolder(folder, ["status", "--porcelain"]);
    const changedOnBranch = async (bare: string, branch: string) =>
      (await fake.must(["diff-tree", "-r", "--name-status", "--no-renames", "main", branch], bare))
        .split("\n")
        .filter(Boolean)
        .map((line) => line.replace("\t", " "));
    const show = (bare: string, revision: string) => fake.must(["show", revision], bare);

    it("first publish: creates the repository, pushes only the changes against the template, opens the pull request", async () => {
      counter += 1;
      const name = `app${counter}`;
      const folder = await fake.createFolder(name, "react", TEMPLATE);
      // A committed change, an uncommitted change and a new untracked file.
      await writeTree(folder, { "src/app.ts": "export const app = 2;\n" });
      await inFolder(folder, ["commit", "-qam", "my change"]);
      // Over 1 MiB: Apple Git's chunked push breaks unless http.postBuffer is in effect.
      await writeTree(folder, {
        "README.md": "# Expenses\n\nIntro\n",
        "src/new.ts": "new\n",
        "assets/photo.bin": randomBytes(3 * 1024 * 1024),
      });
      const before = await inFolder(folder, ["rev-list", "--count", "HEAD"]);

      const result = await publish(folder, { app: { name, purpose: "Tests" } });

      expect(result).toMatchObject({
        outcome: "published",
        app: {
          id: expect.any(String),
          name,
          repositoryUrl: `https://github.example/acme/app-${name}`,
        },
        pullRequest: { number: expect.any(Number), created: true },
        conflict: null,
        refused: null,
        links: { preview: expect.stringContaining("https://preview.example/"), live: null },
      });
      expect(result.files).toEqual([
        { path: "README.md", change: "modified" },
        { path: "assets/photo.bin", change: "added" },
        { path: "src/app.ts", change: "modified" },
        { path: "src/new.ts", change: "added" },
      ]);
      expect(JSON.stringify(result)).not.toContain("wgc_");
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          { code: "branch_rule_missing", message: "No rule protects main." },
        ]),
      );
      const app = fake.apps.get(result.app!.id)!;
      const branch = result.pullRequest!.branch;
      expect(branch).toMatch(/^weldall\/publish-/);
      expect(await changedOnBranch(app.bare, branch)).toEqual([
        "M README.md",
        "A assets/photo.bin",
        "M src/app.ts",
        "A src/new.ts",
      ]);
      // One commit on top of the repository's state, attributed to the bot, with the trailer.
      const commit = await fake.must(
        ["log", "-1", "--format=%P%n%an <%ae>%n%cn <%ce>%n%B", branch],
        app.bare,
      );
      const [parent, author, committer, ...message] = commit.split("\n");
      expect(parent).toBe(await fake.branchHead(app.bare, "main"));
      expect(author).toBe(`${BOT_IDENTITY.name} <${BOT_IDENTITY.email}>`);
      expect(committer).toBe(author);
      expect(message.join("\n")).toContain(`Weldall-App: ${result.app!.id}`);
      expect(result.commit).toBe(await fake.branchHead(app.bare, branch));

      // The folder took over the result: base = pushed commit, clean, history kept.
      expect(await inFolder(folder, ["rev-parse", "refs/weldall/base"])).toBe(result.commit);
      expect(await inFolder(folder, ["rev-parse", "HEAD^{tree}"])).toBe(
        await fake.must(["rev-parse", `${branch}^{tree}`], app.bare),
      );
      expect(await status(folder)).toBe("");
      expect(Number(await inFolder(folder, ["rev-list", "--count", "HEAD"]))).toBeGreaterThan(
        Number(before),
      );
      expect(await inFolder(folder, ["config", "weldall.prBranch"])).toBe(branch);
      expect(await inFolder(folder, ["config", "remote.weldall.url"])).toBe(
        `${fake.issuer}/git/github/acme/app-${name}.git`,
      );
    });

    it("reads the status of the folder's pull request, or of an app id without a folder", async () => {
      const { folder, first } = await published();
      const options = { api: fake.api, git: GIT, environment: fake.publishEnvironment() };

      const status = await readAppStatus({ ...options, directory: folder });

      expect(status).toEqual({
        outcome: "status",
        app: { id: first.app!.id, name: first.app!.name },
        pullRequest: expect.objectContaining({
          number: first.pullRequest!.number,
          state: "open",
          headBranch: first.pullRequest!.branch,
          reviews: [],
          checks: [],
        }),
        links: { preview: expect.stringContaining("https://preview.example/"), live: null },
        warnings: [],
      });
      expect(
        await readAppStatus({ ...options, directory: "/nonexistent", appId: first.app!.id }),
      ).toEqual(status);
      const fresh = await fake.createFolder(`unpublished${++counter}`, "react", TEMPLATE);
      await expect(readAppStatus({ ...options, directory: fresh })).rejects.toMatchObject({
        code: "not_published",
        hint: expect.stringContaining("weldall app publish"),
      });
    });

    it("later publish after a squash merge: a new branch and pull request with only the new changes", async () => {
      const { folder, bare, first } = await published();
      await fake.squashMerge(first.pullRequest!.number);
      await writeTree(folder, { "src/notes.ts": lines(10, { 4: "four" }) });

      const second = await publish(folder);

      expect(second.outcome).toBe("published");
      expect(second.pullRequest).toMatchObject({ created: true });
      expect(second.pullRequest!.number).not.toBe(first.pullRequest!.number);
      expect(second.pullRequest!.branch).not.toBe(first.pullRequest!.branch);
      expect(await changedOnBranch(bare, second.pullRequest!.branch)).toEqual(["M src/notes.ts"]);
    });

    it("keeps a reviewer's change in the open pull request, also in a file the person changes in other lines", async () => {
      const { folder, bare, first } = await published({
        "src/notes.ts": lines(10, { 9: "mine 9" }),
      });
      const branch = first.pullRequest!.branch;
      const reviewer = await fake.commitFiles(
        bare,
        branch,
        { "src/notes.ts": lines(10, { 2: "reviewer 2", 9: "mine 9" }) },
        "Review fix",
      );
      await writeTree(folder, { "src/notes.ts": lines(10, { 7: "mine 7", 9: "mine 9" }) });
      const pullCount = fake.pulls.length;

      const second = await publish(folder);

      // Same branch, fast-forward onto the reviewer's commit, no second pull request.
      expect(second.outcome).toBe("published");
      expect(second.pullRequest).toMatchObject({
        branch,
        created: false,
        number: first.pullRequest!.number,
      });
      expect(fake.pulls).toHaveLength(pullCount);
      expect(await fake.must(["rev-parse", `${second.commit}^`], bare)).toBe(reviewer);
      expect(await show(bare, `${branch}:src/notes.ts`)).toBe(
        lines(10, { 2: "reviewer 2", 7: "mine 7", 9: "mine 9" }).trimEnd(),
      );
      expect(await readFile(join(folder, "src/notes.ts"), "utf8")).toBe(
        lines(10, { 2: "reviewer 2", 7: "mine 7", 9: "mine 9" }),
      );

      // After the squash merge the reviewer's line stays and only the next change is published.
      await fake.squashMerge(first.pullRequest!.number);
      await writeTree(folder, {
        "src/notes.ts": lines(10, { 2: "reviewer 2", 5: "mine 5", 7: "mine 7", 9: "mine 9" }),
      });
      const third = await publish(folder);
      expect(third.outcome).toBe("published");
      expect(third.conflict).toBeNull();
      expect(
        await fake.must(["diff", "main", third.pullRequest!.branch, "--", "src/notes.ts"], bare),
      ).toMatch(/-line 5\n\+mine 5/);
    });

    it("keeps foreign commits on the default branch out of the pull request and brings them into the folder", async () => {
      const { folder, bare, first } = await published();
      await fake.squashMerge(first.pullRequest!.number);
      await fake.commitFiles(bare, "main", { Dockerfile: "FROM node\n" }, "Foreign change");
      await writeTree(folder, { "src/app.ts": "export const app = 3;\n" });

      const second = await publish(folder);

      expect(await changedOnBranch(bare, second.pullRequest!.branch)).toEqual(["M src/app.ts"]);
      expect(second.folder.updated).toContain("Dockerfile");
      expect(await readFile(join(folder, "Dockerfile"), "utf8")).toBe("FROM node\n");
    });

    it("stops on a text conflict without publishing or touching the folder, and publishes after the resolution", async () => {
      const { folder, bare, first } = await published();
      await fake.squashMerge(first.pullRequest!.number);
      await fake.commitFiles(bare, "main", { "README.md": "# Template\n\nTheirs\n" }, "Theirs");
      await writeTree(folder, { "README.md": "# Template\n\nMine\n" });
      const pushes = fake.pushes.length;
      const head = await inFolder(folder, ["rev-parse", "HEAD"]);

      const stopped = await publish(folder);

      expect(stopped.outcome).toBe("conflict");
      expect(stopped.conflict).toEqual({
        written: false,
        files: [
          expect.objectContaining({
            path: "README.md",
            kind: "content",
            choices: ["folder", "local", "repo"],
          }),
        ],
      });
      expect(fake.pushes).toHaveLength(pushes);
      expect(await inFolder(folder, ["rev-parse", "HEAD"])).toBe(head);
      expect(await readFile(join(folder, "README.md"), "utf8")).toBe("# Template\n\nMine\n");

      const written = await publish(folder, { resolve: true });
      expect(written.conflict?.written).toBe(true);
      expect(await readFile(join(folder, "README.md"), "utf8")).toMatch(
        /<<<<<<< refs\/weldall\/local\nMine\n=======\nTheirs\n>>>>>>> refs\/weldall\/repo/,
      );
      await expect(publish(folder, { decisions: { "README.md": "folder" } })).rejects.toMatchObject(
        {
          code: "conflict_markers_left",
        },
      );

      await writeTree(folder, { "README.md": "# Template\n\nMine and theirs\n" });
      const resolved = await publish(folder, { decisions: { "README.md": "folder" } });
      expect(resolved.outcome).toBe("published");
      expect(resolved.notices.map(({ code }) => code)).toContain("conflict_resolved");
      expect(await show(bare, `${resolved.pullRequest!.branch}:README.md`)).toBe(
        "# Template\n\nMine and theirs",
      );
      expect(await status(folder)).toBe("");
    });

    it("needs an explicit decision for binary and modify/delete conflicts", async () => {
      const { folder, bare, first } = await published();
      await fake.squashMerge(first.pullRequest!.number);
      await fake.commitFiles(bare, "main", { "logo.png": png(7), "src/legacy.ts": null }, "Theirs");
      await writeTree(folder, {
        "logo.png": png(9),
        "src/legacy.ts": "export const legacy = false;\n",
      });

      const written = await publish(folder, { resolve: true });
      expect(written.conflict?.files).toEqual([
        expect.objectContaining({ path: "logo.png", kind: "binary", choices: ["local", "repo"] }),
        expect.objectContaining({
          path: "src/legacy.ts",
          kind: "modify-delete",
          choices: ["local", "repo"],
        }),
      ]);

      // No markers to look for: without a decision per file nothing is published.
      const undecided = await publish(folder);
      expect(undecided.outcome).toBe("conflict");
      expect(undecided.conflict?.files.map(({ decided }) => decided)).toEqual([false, false]);
      const partly = await publish(folder, { decisions: { "logo.png": "repo" } });
      expect(partly.conflict?.files.map(({ decided }) => decided)).toEqual([true, false]);
      await expect(
        publish(folder, { decisions: { "logo.png": "folder", "src/legacy.ts": "repo" } }),
      ).rejects.toMatchObject({ code: "invalid_decision" });

      const resolved = await publish(folder, {
        decisions: { "logo.png": "repo", "src/legacy.ts": "local" },
      });
      expect(resolved.outcome).toBe("published");
      const branch = resolved.pullRequest!.branch;
      expect(await changedOnBranch(bare, branch)).toEqual(["A src/legacy.ts"]);
      expect(await readFile(join(folder, "logo.png"))).toEqual(png(7));
    });

    it("merges again from the old base when the resolution was discarded, so no repository change is reverted", async () => {
      const { folder, bare, first } = await published();
      await fake.squashMerge(first.pullRequest!.number);
      await fake.commitFiles(
        bare,
        "main",
        { "README.md": "# Template\n\nTheirs\n", "docs/guide.md": "guide\n" },
        "Theirs",
      );
      await writeTree(folder, { "README.md": "# Template\n\nMine\n" });
      await publish(folder, { resolve: true });
      expect(await readFile(join(folder, "docs/guide.md"), "utf8")).toBe("guide\n");

      // The agent throws the merge result away instead of resolving it.
      await inFolder(folder, ["checkout", "--", "."]);
      await inFolder(folder, ["clean", "-fdq"]);
      const pushes = fake.pushes.length;
      const again = await publish(folder, { decisions: { "README.md": "folder" } });

      expect(again.outcome).toBe("conflict");
      expect(again.notices).toEqual([
        expect.objectContaining({ code: "resolution_discarded", paths: ["docs/guide.md"] }),
      ]);
      expect(fake.pushes).toHaveLength(pushes);

      await publish(folder, { resolve: true });
      await writeTree(folder, { "README.md": "# Template\n\nBoth\n" });
      const resolved = await publish(folder, { decisions: { "README.md": "folder" } });
      expect(resolved.outcome).toBe("published");
      expect(await changedOnBranch(bare, resolved.pullRequest!.branch)).toEqual(["M README.md"]);
    });

    it("opens the pull request on the next run when it failed after the push", async () => {
      counter += 1;
      const name = `app${counter}`;
      const folder = await fake.createFolder(name, "react", TEMPLATE);
      await writeTree(folder, { "src/app.ts": "export const app = 4;\n" });
      fake.failNextPullRequest();
      const failure = await publish(folder, { app: { name, purpose: "Tests" } }).catch(
        (error: unknown) => error,
      );
      const branch = await inFolder(folder, ["config", "weldall.prBranch"]);
      expect(failure).toMatchObject({
        code: "pull_request_not_opened",
        message: expect.stringContaining(`was pushed to branch ${branch}`),
        details: {
          commit: expect.stringMatching(/^[0-9a-f]{40}$/),
          branch,
          cause: "upstream_unavailable",
        },
      });
      expect(JSON.parse(publishJson(failure as PublishError)).error).toMatchObject({
        code: "pull_request_not_opened",
        details: { branch, cause: "upstream_unavailable" },
      });
      const pushes = fake.pushes.length;

      const retry = await publish(folder);

      expect(retry).toMatchObject({
        outcome: "published",
        commit: null,
        pullRequest: { branch, created: true },
      });
      expect(fake.pushes).toHaveLength(pushes);
    });

    it("offers the changes of a pull request closed without merging again", async () => {
      const { folder, bare, first } = await published({ "src/app.ts": "export const app = 5;\n" });
      fake.close(first.pullRequest!.number);

      const again = await publish(folder);

      expect(again.outcome).toBe("published");
      expect(again.notices.map(({ code }) => code)).toEqual(["pull_request_closed"]);
      expect(again.pullRequest!.branch).not.toBe(first.pullRequest!.branch);
      expect(await changedOnBranch(bare, again.pullRequest!.branch)).toEqual(["M src/app.ts"]);
    });

    it("falls back to the pull request's base when it was merged before the last push landed", async () => {
      const { folder, bare, first } = await published({ "src/a.ts": "a changed\n" });
      const branch = first.pullRequest!.branch;
      await writeTree(folder, { "src/b.ts": "b changed\n" });
      fake.mergeBeforeNextPush(branch);
      const raced = await publish(folder);
      expect(raced.outcome).toBe("published");
      expect(raced.pullRequest?.branch).toBe(branch);

      const next = await publish(folder);

      expect(next.notices.map(({ code }) => code)).toEqual(["merged_without_last_publish"]);
      expect(next.outcome).toBe("published");
      expect(await changedOnBranch(bare, next.pullRequest!.branch)).toEqual(["M src/b.ts"]);
    });

    it("leaves base and folder alone when the proxy refuses a push to a closed pull request, then retries cleanly", async () => {
      const { folder, bare, first } = await published({ "src/a.ts": "a changed\n" });
      const branch = first.pullRequest!.branch;
      await writeTree(folder, { "src/b.ts": "b changed\n" });
      const base = await inFolder(folder, ["rev-parse", "refs/weldall/base"]);
      const head = await inFolder(folder, ["rev-parse", "HEAD"]);
      fake.closeBeforeNextPush(branch);

      const refusal = await publish(folder).catch((error: unknown) => error);
      expect(refusal, String(refusal)).toMatchObject({ code: "pull_request_closed" });
      expect(await inFolder(folder, ["rev-parse", "refs/weldall/base"])).toBe(base);
      expect(await inFolder(folder, ["rev-parse", "HEAD"])).toBe(head);
      expect(await readFile(join(folder, "src/b.ts"), "utf8")).toBe("b changed\n");

      const retry = await publish(folder);
      expect(retry.outcome).toBe("published");
      expect(await changedOnBranch(bare, retry.pullRequest!.branch)).toEqual([
        "M src/a.ts",
        "M src/b.ts",
      ]);
    });

    it("publishes workflow files from the repository and names the local changes that were not published", async () => {
      counter += 1;
      const name = `app${counter}`;
      // The folder came from an older template; the repository has the newer workflow.
      const folder = await fake.createFolder(name, "react", TEMPLATE);
      await fake.updateTemplate("react", { ".github/workflows/ci.yml": "name: ci v2\n" });
      await writeTree(folder, {
        ".github/workflows/ci.yml": "name: mine\n",
        "src/app.ts": "export const app = 9;\n",
      });

      const result = await publish(folder, { app: { name, purpose: "Tests" } });
      await fake.updateTemplate("react", { ".github/workflows/ci.yml": "name: ci\n" });

      expect(result.outcome).toBe("published");
      expect(result.notices).toEqual([
        expect.objectContaining({
          code: "protected_files_not_published",
          paths: [".github/workflows/ci.yml"],
        }),
      ]);
      const bare = fake.apps.get(result.app!.id)!.bare;
      expect(await changedOnBranch(bare, result.pullRequest!.branch)).toEqual(["M src/app.ts"]);
      expect(await readFile(join(folder, ".github/workflows/ci.yml"), "utf8")).toBe(
        "name: ci v2\n",
      );
      expect(await inFolder(folder, ["show", "HEAD~1:.github/workflows/ci.yml"])).toBe(
        "name: mine",
      );
    });

    it("refuses files that look like secrets or dumps, lists them, and publishes nothing", async () => {
      const { folder } = await published();
      await writeTree(folder, {
        ".env": "API_KEY=real\n",
        ".env.example": "API_KEY=\nOTHER=\n",
        "deploy/id_rsa": "key\n",
        "src/config.ts": `export const token = "${fakeGitHubToken}";\n`,
        "data/export.sqlite": "SQLite format 3",
      });
      const pushes = fake.pushes.length;

      const refused = await publish(folder);

      expect(refused.outcome).toBe("refused");
      expect(refused.refused?.map(({ path }) => path)).toEqual([
        ".env",
        "data/export.sqlite",
        "deploy/id_rsa",
        "src/config.ts",
      ]);
      expect(fake.pushes).toHaveLength(pushes);
      expect(await readFile(join(folder, ".env"), "utf8")).toBe("API_KEY=real\n");

      await writeTree(folder, {
        ".gitignore": "node_modules/\n.env\ndata/\n",
        "deploy/id_rsa": null,
        "src/config.ts": "export const token = process.env.TOKEN;\n",
      });
      const accepted = await publish(folder);
      expect(accepted.outcome).toBe("published");
      expect(accepted.files.map(({ path }) => path)).toEqual([
        ".env.example",
        ".gitignore",
        "src/config.ts",
      ]);
    });

    it("stops with a clear error when the base ref is lost, without guessing", async () => {
      const { folder } = await published();
      await inFolder(folder, ["update-ref", "-d", "refs/weldall/base"]);
      await writeTree(folder, { "src/app.ts": "export const app = 7;\n" });
      const pushes = fake.pushes.length;

      await expect(publish(folder)).rejects.toMatchObject({ code: "base_missing" });
      expect(fake.pushes).toHaveLength(pushes);
    });

    it("handles deletions and renames on both sides and says what the repository removed", async () => {
      const { folder, bare, first } = await published();
      await fake.squashMerge(first.pullRequest!.number);
      await fake.commitFiles(
        bare,
        "main",
        { "src/c.ts": null, "src/d.ts": null, "src/d2.ts": "d\n" },
        "Theirs",
      );
      await inFolder(folder, ["rm", "-q", "src/a.ts"]);
      await inFolder(folder, ["mv", "src/b.ts", "src/b2.ts"]);

      const result = await publish(folder);

      expect(result.outcome).toBe("published");
      expect(await changedOnBranch(bare, result.pullRequest!.branch)).toEqual([
        "D src/a.ts",
        "D src/b.ts",
        "A src/b2.ts",
      ]);
      expect(result.notices).toEqual([
        expect.objectContaining({ code: "removed_by_repository", paths: ["src/c.ts", "src/d.ts"] }),
      ]);
      expect(result.folder).toEqual({ updated: ["src/d2.ts"], removed: ["src/c.ts", "src/d.ts"] });
    });

    it("syncs the repository's state into the folder without publishing", async () => {
      const { folder, bare, first } = await published();
      await fake.squashMerge(first.pullRequest!.number);
      await fake.commitFiles(
        bare,
        "main",
        { "src/app.ts": null, Dockerfile: "FROM node\n" },
        "Revert and add",
      );
      await writeTree(folder, { "src/local.ts": "unpublished\n" });
      const pushes = fake.pushes.length;

      const synced = await publish(folder, { syncOnly: true });

      expect(synced.outcome).toBe("synced");
      expect(fake.pushes).toHaveLength(pushes);
      expect(synced.notices).toEqual([
        expect.objectContaining({ code: "removed_by_repository", paths: ["src/app.ts"] }),
      ]);
      expect(await inFolder(folder, ["rev-parse", "refs/weldall/base"])).toBe(
        await fake.branchHead(bare, "main"),
      );
      expect(await readFile(join(folder, "src/local.ts"), "utf8")).toBe("unpublished\n");
      expect(await readFile(join(folder, "Dockerfile"), "utf8")).toBe("FROM node\n");
      expect(
        await inFolder(folder, ["config", "--get", "weldall.prBranch"]).catch(() => null),
      ).toBeNull();
    });

    it("refuses to start without the template agreement, next to a foreign remote, or for another issuer", async () => {
      counter += 1;
      const name = `app${counter}`;
      const folder = await fake.createFolder(name, "react", TEMPLATE);
      const apps = fake.apps.size;

      await inFolder(folder, ["config", "--unset", "weldall.templateCommit"]);
      await expect(publish(folder, { app: { name, purpose: "Tests" } })).rejects.toMatchObject({
        code: "template_missing",
        message: expect.stringContaining("weldall.templateCommit"),
      });
      await inFolder(folder, [
        "config",
        "weldall.templateCommit",
        await inFolder(folder, ["rev-list", "--max-parents=0", "HEAD"]),
      ]);

      await inFolder(folder, ["remote", "add", "weldall", "https://example.invalid/other.git"]);
      await expect(publish(folder, { app: { name, purpose: "Tests" } })).rejects.toMatchObject({
        code: "remote_conflict",
      });
      expect(await inFolder(folder, ["config", "remote.weldall.url"])).toBe(
        "https://example.invalid/other.git",
      );
      expect(fake.apps.size).toBe(apps);
      await inFolder(folder, ["remote", "remove", "weldall"]);

      await expect(publish(folder, { syncOnly: true })).rejects.toMatchObject({
        code: "not_published",
      });
      await expect(
        publish(folder, {
          app: { name, purpose: "Tests" },
          api: createPublishApi("https://weldall.other.example", fake.send),
        }),
      ).rejects.toMatchObject({ code: "issuer_mismatch" });
    });

    it("fails clearly against a Weldall server without the publish endpoints", async () => {
      counter += 1;
      const name = `app${counter}`;
      const folder = await fake.createFolder(name, "react", TEMPLATE);
      fake.useOldServer(true);
      try {
        await expect(publish(folder, { app: { name, purpose: "Tests" } })).rejects.toMatchObject({
          code: "server_unsupported",
        });
      } finally {
        fake.useOldServer(false);
      }
    });

    // Regressions found by attacking the built command (review of step 3f).

    it("keeps edits made while the push runs and publishes them next time", async () => {
      const { folder, bare, first } = await published();
      await fake.squashMerge(first.pullRequest!.number);
      await writeTree(folder, { "src/a.ts": "a v2\n" });
      await fake.beforeGit(
        "push --porcelain",
        "printf 'a v3\\n' > src/a.ts\nprintf 'new\\n' > src/new.ts",
      );

      const raced = await publish(folder, { git: fake.gitWrapper });

      expect(raced.outcome).toBe("published");
      expect(raced.notices.map(({ code }) => code)).toEqual(["edited_during_publish"]);
      expect(await readFile(join(folder, "src/a.ts"), "utf8")).toBe("a v3\n");
      expect(await readFile(join(folder, "src/new.ts"), "utf8")).toBe("new\n");
      expect(await show(bare, `${raced.pullRequest!.branch}:src/a.ts`)).toBe("a v2");

      const next = await publish(folder);
      expect(next.outcome).toBe("published");
      expect(next.conflict).toBeNull();
      expect(await show(bare, `${next.pullRequest!.branch}:src/a.ts`)).toBe("a v3");
      expect(await show(bare, `${next.pullRequest!.branch}:src/new.ts`)).toBe("new");
    });

    it("does not overwrite edits that conflict with what the publish brought in", async () => {
      const { folder, bare, first } = await published();
      await fake.commitFiles(
        bare,
        first.pullRequest!.branch,
        { "src/b.ts": "b reviewer\n" },
        "Review",
      );
      await writeTree(folder, { "src/a.ts": "a v2\n" });
      await fake.beforeGit("push --porcelain", "printf 'b mine\\n' > src/b.ts");

      const raced = await publish(folder, { git: fake.gitWrapper });

      expect(raced.outcome).toBe("published");
      expect(raced.notices.map(({ code }) => code)).toEqual(["folder_not_updated"]);
      expect(await readFile(join(folder, "src/b.ts"), "utf8")).toBe("b mine\n");
      expect(await readFile(join(folder, "src/a.ts"), "utf8")).toBe("a v2\n");
    });

    it("reuses the recorded branch when a run was killed right after its push", async () => {
      const { folder, bare, first } = await published();
      await fake.squashMerge(first.pullRequest!.number);
      await writeTree(folder, { "src/a.ts": "a v2\n" });
      await fake.killGit("push --porcelain", "after");
      await expect(publish(folder, { git: fake.gitWrapper })).rejects.toBeDefined();
      const branch = await inFolder(folder, ["config", "weldall.prBranch"]);
      const heads = await fake.must(["for-each-ref", "--format=%(refname)", "refs/heads"], bare);

      const retry = await publish(folder);

      expect(retry).toMatchObject({ outcome: "published", pullRequest: { branch, created: true } });
      expect(await fake.must(["for-each-ref", "--format=%(refname)", "refs/heads"], bare)).toBe(
        heads,
      );
    });

    it("restarts cleanly when a run was killed while writing the conflict", async () => {
      const { folder, bare, first } = await published();
      await fake.commitFiles(
        bare,
        first.pullRequest!.branch,
        { "README.md": "# Template\n\nTheirs\n", "src/b.ts": "b reviewer\n" },
        "Review",
      );
      await writeTree(folder, { "README.md": "# Template\n\nMine\n" });
      await fake.killGit("read-tree -m -u");
      await expect(publish(folder, { git: fake.gitWrapper, resolve: true })).rejects.toBeDefined();

      const again = await publish(folder);
      expect(again.outcome).toBe("conflict");
      expect(again.notices.map(({ code }) => code)).toEqual(["resolution_discarded"]);
      const written = await publish(folder, { resolve: true });
      expect(written.conflict?.written).toBe(true);
      expect(await readFile(join(folder, "README.md"), "utf8")).toContain("<<<<<<<");
    });

    it("treats the lock of a run that no longer exists as stale", async () => {
      const { folder } = await published();
      await writeFile(join(folder, ".git/weldall/publish.lock"), "999999\n");
      await writeTree(folder, { "src/a.ts": "after a crash\n" });
      expect((await publish(folder)).outcome).toBe("published");
    });

    it("refuses nested git repositories instead of publishing an empty reference", async () => {
      const { folder } = await published();
      await mkdir(join(folder, "web"));
      await fake.must(["init", "-q", "-b", "main"], join(folder, "web"));
      await writeTree(join(folder, "web"), { "index.html": "<h1>work</h1>\n" });
      await fake.must(["add", "-A"], join(folder, "web"));
      await fake.must(["commit", "-qm", "init"], join(folder, "web"));
      const refused = await publish(folder);
      expect(refused.outcome).toBe("refused");
      expect(refused.refused).toEqual([
        { path: "web", reason: expect.stringContaining("own git repository") },
      ]);

      await mkdir(join(folder, "empty"));
      await fake.must(["init", "-q"], join(folder, "empty"));
      await writeTree(join(folder, "empty"), { "x.txt": "x\n" });
      await expect(publish(folder)).rejects.toMatchObject({
        code: "nested_repository",
        message: expect.stringContaining("empty/"),
      });
    });

    it("stops before copying a huge untracked folder into git", async () => {
      const { folder } = await published();
      const chunk = randomBytes(4 * 1024 * 1024);
      for (let index = 0; index < 26; index += 1)
        await writeTree(folder, { [`.venv/lib/pkg${index}.so`]: chunk });
      const objects = await inFolder(folder, ["count-objects"]);

      await expect(publish(folder)).rejects.toMatchObject({
        code: "too_large",
        message: expect.stringContaining(".venv/ (104 MB)"),
      });
      expect(await inFolder(folder, ["count-objects"])).toBe(objects);
    });

    it("lets a changed template file with a refused name through and still scans its content", async () => {
      const { folder } = await published();
      await writeTree(folder, { ".npmrc": "auto-install-peers=true\nshamefully-hoist=true\n" });
      expect((await publish(folder)).outcome).toBe("published");
      await writeTree(folder, {
        ".npmrc": `//registry.npmjs.org/:_authToken=${fakeGitHubToken}\n`,
      });
      expect((await publish(folder)).refused).toEqual([
        { path: ".npmrc", reason: expect.stringContaining("GitHub token") },
      ]);
    });

    it("refuses symbolic links to absolute paths and outside the folder", async () => {
      const { folder } = await published();
      await symlink("/etc/hosts", join(folder, "hosts-link"));
      await symlink("../../outside.txt", join(folder, "src/up-link"));
      await symlink("app.ts", join(folder, "src/app-link.ts"));
      const refused = await publish(folder);
      expect(refused.refused?.map(({ path }) => path)).toEqual(["hosts-link", "src/up-link"]);
    });

    it("decides file/directory conflicts only with the repository's version", async () => {
      const { folder, bare, first } = await published();
      await fake.commitFiles(
        bare,
        first.pullRequest!.branch,
        { "docs/x.md": "repo dir\n" },
        "Review",
      );
      await writeTree(folder, { docs: "local file\n" });
      const written = await publish(folder, { resolve: true });
      const files = written.conflict!.files;
      expect(files.map(({ path, choices }) => [path, choices])).toEqual([
        ["docs", ["repo"]],
        ["docs~refs_weldall_local", ["repo"]],
      ]);
      await expect(
        publish(folder, { decisions: { docs: "folder", "docs~refs_weldall_local": "repo" } }),
      ).rejects.toMatchObject({ code: "invalid_decision" });
      // The agent keeps the local content under a new name, then takes the repository's side.
      await rename(join(folder, "docs~refs_weldall_local"), join(folder, "docs-notes.txt"));
      const resolved = await publish(folder, {
        decisions: { docs: "repo", "docs~refs_weldall_local": "repo" },
      });
      expect(resolved.outcome).toBe("published");
      const tree = await fake.must(
        ["ls-tree", "-r", "--name-only", resolved.pullRequest!.branch],
        bare,
      );
      expect(tree).toContain("docs/x.md");
      expect(tree).toContain("docs-notes.txt");
      expect(tree).not.toContain("~refs_weldall");
    });

    it("ignores GIT_DIR and GIT_WORK_TREE that point at another repository", async () => {
      const { folder } = await published();
      const other = join(fake.root, `other-${counter}`);
      await mkdir(other);
      await fake.must(["init", "-q"], other);
      const before = await readFile(join(other, ".git/config"), "utf8");
      await writeTree(folder, { "src/a.ts": "with GIT_DIR set\n" });
      const result = await publish(folder, {
        environment: {
          ...fake.publishEnvironment(),
          GIT_DIR: join(other, ".git"),
          GIT_WORK_TREE: other,
        },
      });
      expect(result.outcome).toBe("published");
      expect(await readFile(join(other, ".git/config"), "utf8")).toBe(before);
      expect(existsSync(join(other, ".git/refs/weldall"))).toBe(false);
    });

    it.each(["closed", "squash-merged"] as const)(
      "keeps the base when the takeover was refused and the pull request is then %s",
      async (ending) => {
        const { folder, bare, first } = await published();
        await fake.squashMerge(first.pullRequest!.number);
        await fake.commitFiles(
          bare,
          "main",
          { "src/b.ts": "b foreign\n", "src/notes.ts": lines(10, { 9: "foreign 9" }) },
          "Foreign",
        );
        await writeTree(folder, { "src/a.ts": "a v2\n" });
        await fake.beforeGit("push --porcelain", "printf 'b typed\\n' > src/b.ts");
        const refused = await publish(folder, { git: fake.gitWrapper });
        expect(refused.notices.map(({ code }) => code)).toEqual(["folder_not_updated"]);
        if (ending === "closed") fake.close(refused.pullRequest!.number);
        else await fake.squashMerge(refused.pullRequest!.number);

        const next = await publish(folder);

        // No silent revert of the foreign lines: the person's b.ts edit conflicts with them.
        expect(next.outcome).toBe("conflict");
        expect(next.conflict!.files.map(({ path }) => path)).toEqual(["src/b.ts"]);
        await writeTree(folder, { "src/b.ts": "b foreign\n" });
        const after = await publish(folder);
        expect(after.outcome).toBe(ending === "closed" ? "published" : "nothing_to_publish");
        if (after.pullRequest && after.commit) {
          const branch = after.pullRequest.branch;
          expect(await show(bare, `${branch}:src/notes.ts`)).toContain("foreign 9");
          expect(await show(bare, `${branch}:src/b.ts`)).toBe("b foreign");
        }
        expect(await readFile(join(folder, "src/notes.ts"), "utf8")).toContain("foreign 9");
      },
    );
  },
);
