import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureGitProxyRepository, GIT_CREDENTIAL_HELPER } from "../src/git/repository-setup.js";
import { Folder } from "../src/publish/folder.js";
import { PrivateGitDirectory, privateGitConfig } from "../src/publish/private-git.js";
import { GitRepository } from "../src/publish/git.js";
import { publishApp, type PublishOptions } from "../src/publish/publish.js";
import {
  assertSafeRepository,
  isAllowedConfigEntry,
  parseConfigList,
} from "../src/publish/repository-safety.js";
import { isBranchName } from "../src/publish/state.js";
import { readAppStatus } from "../src/publish/status.js";
import {
  fakeWeldallUnavailable,
  GIT,
  startFakeWeldall,
  writeTree,
  type FakeWeldall,
} from "./fixtures/fake-weldall-git.js";

/**
 * An agent in the project folder can write `.git/config` and `.git/hooks`, but the CLI runs git
 * outside the agent's sandbox: nothing stored in the folder may make publish start a program.
 */

const SCOPE = "https://git-app.example.com/git/";
const entry = (key: string, value: string | null = "x") =>
  parseConfigList(`local\0${value === null ? key : `${key}\n${value}`}\0`, ["local"])[0]!;

describe("repository config allow-list", () => {
  it("parses scopes, subsections with dots, empty values and keys without a value", () => {
    const output = [
      "global",
      "user.name\nSomeone",
      "local",
      "core.bare\nfalse",
      "local",
      `credential.${SCOPE}.helper\n`,
      "worktree",
      "core.fsmonitor",
      "",
    ].join("\0");
    expect(parseConfigList(output, ["local", "worktree"])).toEqual([
      { key: "core.bare", section: "core", subsection: null, name: "bare", value: "false" },
      {
        key: `credential.${SCOPE}.helper`,
        section: "credential",
        subsection: SCOPE,
        name: "helper",
        value: "",
      },
      { key: "core.fsmonitor", section: "core", subsection: null, name: "fsmonitor", value: null },
    ]);
  });

  it.each([
    ["core.repositoryformatversion", "0"],
    ["core.filemode", "true"],
    ["core.bare", "false"],
    ["core.logallrefupdates", "true"],
    ["core.ignorecase", "true"],
    ["core.precomposeunicode", "true"],
    ["core.symlinks", "false"],
    ["extensions.objectformat", "sha256"],
    ["user.name", "Someone"],
    ["init.defaultbranch", "main"],
    ["branch.main.remote", "origin"],
    ["branch.main.vscode-merge-base", "origin/main"],
    ["remote.weldall.url", `${SCOPE}acme/app.git`],
    ["weldall.gitapp", "git-app"],
    [`credential.https://127.0.0.1:8443/git/.helper`, ""],
    ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
    [`credential.${SCOPE}.helper`, ""],
    [`credential.${SCOPE}.helper`, GIT_CREDENTIAL_HELPER],
    [`credential.${SCOPE}.usehttppath`, "true"],
    [`http.${SCOPE}.postbuffer`, "104857600"],
    ["weldall.templatecommit", "abc"],
    ["weldall.prurl", "https://example.com/pull/1"],
    ["core.hookspath", ".husky/_"],
  ])("allows %s", (key, value) => {
    expect(isAllowedConfigEntry(entry(key, value))).toBe(true);
  });

  it.each([
    ["core.fsmonitor", "./run"],
    ["core.autocrlf", "true\n[filter]"],
    ["extensions.objectformat", null],
    ["core.worktree", "/elsewhere"],
    ["core.sshcommand", "./run"],
    ["core.pager", "./run"],
    ["core.editor", "./run"],
    ["core.askpass", "./run"],
    ["core.alternaterefscommand", "./run"],
    ["core.attributesfile", "./attributes"],
    ["filter.x.clean", "./run"],
    ["filter.x.process", "./run"],
    ["diff.x.textconv", "./run"],
    ["merge.x.driver", "./run"],
    ["include.path", "./more"],
    ["includeif.gitdir:/.path", "./more"],
    ["url.https://elsewhere.example/.insteadof", SCOPE],
    ["extensions.worktreeconfig", "true"],
    [`credential.${SCOPE}.helper`, "!./run"],
    [`credential.${SCOPE}.helper`, null],
    ["credential.helper", GIT_CREDENTIAL_HELPER],
    [`http.${SCOPE}.extraheader`, "Authorization: x"],
    ["http.postbuffer", "1"],
    // Credential and http settings only for the shape of a Git app's git route.
    ["credential.https://git-app.example.com/.helper", ""],
    ["credential.https://git-app.example.com/git/acme/.usehttppath", "true"],
    ["credential.http://git-app.example.com/git/.helper", GIT_CREDENTIAL_HELPER],
    ["credential.https://user@git-app.example.com/git/.helper", ""],
    ["credential.git-app.example.com.helper", ""],
    ["http.https://git-app.example.com/.postbuffer", "1"],
    [`remote.${SCOPE}github/acme/app.git.pushurl`, "https://elsewhere.example/x.git"],
    ["remote.origin.uploadpack", "./run"],
    ["remote.origin.receivepack", "./run"],
    ["weldall.other", "x"],
    ["weldall.x.appid", "x"],
    ["gpg.program", "./run"],
    ["sequence.editor", "./run"],
    ["submodule.recurse", "true"],
  ])("refuses %s", (key, value) => {
    expect(isAllowedConfigEntry(entry(key, value))).toBe(false);
  });
});

describe("private git directory config", () => {
  it("takes over only the working-tree settings and switches maintenance off", () => {
    const entries = parseConfigList(
      [
        "local",
        "core.repositoryformatversion\n0",
        "local",
        "core.ignorecase\ntrue",
        "local",
        "core.hookspath\n.husky/_",
        "local",
        `credential.${SCOPE}.helper\n${GIT_CREDENTIAL_HELPER}`,
        "local",
        "extensions.objectformat\nsha256",
        "",
      ].join("\0"),
      ["local"],
    );
    expect(privateGitConfig(entries)).toBe(
      [
        "[core]",
        "\tbare = false",
        "\trepositoryformatversion = 0",
        "\tignorecase = true",
        "[extensions]",
        "\tobjectformat = sha256",
        "[gc]",
        "\tauto = 0",
        "[maintenance]",
        "\tauto = false",
        "",
      ].join("\n"),
    );
  });
});

describe("recorded branch names", () => {
  it.each(["main", "release_1", "feature/a-b.c", "weldall/publish-20261118-120000-abc123", "v1+x"])(
    "accepts %s",
    (name) => expect(isBranchName(name)).toBe(true),
  );
  it.each([
    "-x",
    "+main",
    "a:refs/heads/main",
    "a b",
    "a..b",
    "a/.b",
    "a//b",
    "a.lock",
    "a/",
    "a^",
    "a~1",
    "a*",
    "a@{1}",
    "_x",
  ])("refuses %s", (name) => expect(isBranchName(name)).toBe(false));
});

const reason = fakeWeldallUnavailable();

describe.skipIf(reason !== null)(
  `git in the project folder starts no program${reason ? ` (skipped: ${reason})` : ""}`,
  { timeout: 120_000 },
  () => {
    const TEMPLATE = { "README.md": "# Template\n", "src/app.ts": "export const app = 1;\n" };
    let fake: FakeWeldall;
    let counter = 0;
    let markers: string;

    let privateGitRoot: string;

    beforeAll(async () => {
      fake = await startFakeWeldall();
      await fake.addTemplate("react", TEMPLATE);
      markers = join(fake.root, "markers");
      privateGitRoot = join(fake.root, "private-git");
    }, 60_000);
    afterAll(async () => {
      await fake?.stop();
    });

    const publish = (directory: string, options: Partial<PublishOptions> = {}) =>
      publishApp({
        directory,
        gitApps: fake.gitApps,
        git: GIT,
        environment: fake.publishEnvironment(),
        privateGitRoot,
        app: { name: `safety${counter}`, purpose: "Tests the git safety checks" },
        ...options,
      });
    const folder = async () => fake.createFolder(`safety${++counter}`, "react", TEMPLATE);
    const repository = (directory: string) =>
      new GitRepository(GIT, directory, fake.publishEnvironment());
    /** A script outside the folder that leaves `markers/<name>` behind and passes stdin on. */
    async function program(name: string) {
      await mkdir(markers, { recursive: true });
      const path = join(fake.root, "programs", name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(
        path,
        `#!/bin/sh\nmkdir -p '${markers}'\ntouch '${join(markers, name)}'\ncat\n`,
      );
      await chmod(path, 0o755);
      return path;
    }
    const ran = async () => (await readdir(markers).catch(() => [] as string[])).sort();
    const clearMarkers = () => rm(markers, { recursive: true, force: true });
    beforeEach(() => clearMarkers());
    /** git as a person runs it in the folder, without publish's protection. */
    const plainGitWithPrivateIndex = (directory: string, args: string[]) =>
      fake.must(args, directory, { env: { GIT_INDEX_FILE: join(fake.root, `index-${counter}`) } });

    it("refuses core.fsmonitor before any git command reads the folder; the options alone also keep it silent", async () => {
      const directory = await folder();
      await writeTree(directory, { "src/app.ts": "export const app = 2;\n", "new.txt": "new\n" });
      const script = await program("fsmonitor");
      await fake.must(["config", "core.fsmonitor", script], directory);
      // The vector is live for plain git.
      await fake.must(["ls-files", "--others", "--exclude-standard"], directory);
      expect(await ran()).toEqual(["fsmonitor"]);
      await clearMarkers();
      const apps = fake.apps.size;

      await expect(publish(directory)).rejects.toMatchObject({
        code: "unsafe_git_config",
        message: expect.stringContaining("core.fsmonitor"),
        details: { keys: "core.fsmonitor" },
      });
      await expect(publish(directory, { syncOnly: true })).rejects.toMatchObject({
        code: "unsafe_git_config",
      });
      await expect(
        readAppStatus({
          gitApps: fake.gitApps,
          registry: fake.registry,
          git: GIT,
          environment: fake.publishEnvironment(),
          directory,
        }),
      ).rejects.toMatchObject({ code: "unsafe_git_config" });
      expect(fake.apps.size).toBe(apps);
      expect(await ran()).toEqual([]);

      // Without the allow-list, the commands that ran it above stay silent too.
      const git = repository(directory);
      const isolation = new PrivateGitDirectory({
        root: privateGitRoot,
        workTree: directory,
        objects: join(directory, ".git/objects"),
        index: join(directory, ".git/index"),
        exclude: join(directory, ".git/info/exclude"),
        entries: [],
      });
      git.usePrivateDirectory(isolation);
      await git.run(["ls-files", "-z", "--others", "--exclude-standard"]);
      await git.run(["ls-files", "-z", "--others", "--exclude-standard"], { isolated: true });
      await new Folder(git, join(directory, ".git")).snapshotTree();
      await isolation.dispose();
      expect(await ran()).toEqual([]);
    });

    it("refuses a filter driver that .gitattributes names, and does not show the setting's value", async () => {
      const directory = await folder();
      const script = await program("filter");
      await writeTree(directory, { ".gitattributes": "* filter=x\n", "new.txt": "new\n" });
      await fake.must(["config", "filter.x.clean", script], directory);
      await plainGitWithPrivateIndex(directory, ["read-tree", "HEAD"]);
      await plainGitWithPrivateIndex(directory, ["add", "-A"]);
      expect(await ran()).toEqual(["filter"]);
      await clearMarkers();

      const error = await publish(directory).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "unsafe_git_config",
        message: expect.stringContaining("filter.x.clean"),
      });
      expect(String((error as Error).message)).not.toContain(script);
      expect(String((error as Error).message)).toMatch(/can make git start other programs/);
      expect(await ran()).toEqual([]);
    });

    it("runs no hook of the folder during publish and sync (fetch, push, ref and index updates)", async () => {
      const directory = await folder();
      await writeTree(directory, { "src/app.ts": "export const app = 2;\n" });
      expect((await publish(directory)).outcome).toBe("published");
      for (const hook of [
        "reference-transaction",
        "post-index-change",
        "pre-push",
        "pre-auto-gc",
        "post-checkout",
        "post-merge",
        "pre-commit",
        "post-commit",
        "fsmonitor-watchman",
      ])
        await writeFile(
          join(directory, ".git/hooks", hook),
          `#!/bin/sh\nexec '${await program(hook)}' >/dev/null 2>&1\n`,
          { mode: 0o755 },
        );
      await fake.must(["update-ref", "refs/control", "HEAD"], directory);
      expect(await ran()).toEqual(["reference-transaction"]);
      await clearMarkers();

      await writeTree(directory, { "src/app.ts": "export const app = 3;\n", "new.txt": "new\n" });
      expect((await publish(directory)).outcome).toBe("published");
      expect((await publish(directory, { syncOnly: true })).outcome).toBe("synced");
      expect(await ran()).toEqual([]);
    });

    it("refuses every unexpected key, also in the worktree config and includes", async () => {
      const directory = await folder();
      const script = await program("unused");
      await fake.must(["config", "include.path", join(fake.root, "more.gitconfig")], directory);
      await fake.must(["config", "url.https://elsewhere.example/.insteadOf", SCOPE], directory);
      await fake.must(["config", `credential.${SCOPE}.helper`, `!${script}`], directory);
      await fake.must(["config", "extensions.worktreeConfig", "true"], directory);
      await fake.must(["config", "--worktree", "core.sshCommand", script], directory);

      const error = await publish(directory).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "unsafe_git_config" });
      expect((error as { details: { keys: string } }).details.keys.split(", ").sort()).toEqual(
        [
          "core.sshcommand",
          `credential.${SCOPE}.helper`,
          "extensions.worktreeconfig",
          "include.path",
          "url.https://elsewhere.example/.insteadof",
        ].sort(),
      );
      expect(String((error as Error).message)).not.toContain(script);
    });

    it("refuses credential settings scoped to another address than the folder's Git app", async () => {
      const directory = await folder();
      await writeTree(directory, { "src/app.ts": "export const app = 2;\n" });
      expect((await publish(directory)).outcome).toBe("published");
      await fake.must(
        [
          "config",
          "--add",
          "credential.https://other.example.com/git/.helper",
          GIT_CREDENTIAL_HELPER,
        ],
        directory,
      );
      // The shape is allowed, so the check before anything is asked passes ...
      await expect(assertSafeRepository(repository(directory))).resolves.toBeDefined();
      // ... and the Git app from Weldall's registry decides.
      for (const run of [
        () => publish(directory),
        () => publish(directory, { syncOnly: true }),
        () =>
          readAppStatus({
            gitApps: fake.gitApps,
            registry: fake.registry,
            git: GIT,
            environment: fake.publishEnvironment(),
            directory,
          }),
      ])
        await expect(run()).rejects.toMatchObject({
          code: "unsafe_git_config",
          details: { keys: "credential.https://other.example.com/git/.helper" },
        });
    });

    it("refuses core.worktree, which would publish another folder", async () => {
      const directory = await folder();
      const other = join(fake.root, `other${counter}`);
      await mkdir(other);
      await fake.must(["config", "core.worktree", other], directory);
      // rev-parse already names the other folder as the top level; either way nothing runs.
      await expect(publish(directory)).rejects.toMatchObject({
        code: expect.stringMatching(/^(not_top_level|unsafe_git_config)$/),
      });
    });

    it("refuses a repository that borrows objects from another location", async () => {
      const directory = await folder();
      await mkdir(join(directory, ".git/objects/info"), { recursive: true });
      await writeFile(
        join(directory, ".git/objects/info/alternates"),
        `${join(fake.root, "templates/react/.git/objects")}\n`,
      );
      await expect(publish(directory)).rejects.toMatchObject({ code: "unsafe_git_objects" });
    });

    /** Has the git wrapper append `config` to the folder's `.git/config` right before `pattern`. */
    async function appendConfigBefore(directory: string, pattern: string, config: string) {
      const file = join(fake.root, `planted-${counter}.gitconfig`);
      await writeFile(file, config);
      await fake.beforeGit(pattern, `cat '${file}' >> '${join(directory, ".git/config")}'`);
    }
    const drivers = (script: string) =>
      `[filter "x"]\n\tclean = '${script}'\n\tsmudge = '${script}'\n[merge "x"]\n\tdriver = '${script}' %O %A %B\n`;

    it("runs no filter driver added to .git/config while publish runs, the race on the lock file", async () => {
      const directory = await folder();
      const script = await program("driver");
      await writeTree(directory, {
        ".gitattributes": "* filter=x merge=x\n",
        "src/app.ts": "export const app = 2;\n",
      });
      const planted = join(fake.root, `planted-${counter}.gitconfig`);
      await writeFile(planted, drivers(script));
      // As an agent in the folder could: wait for publish's lock file, then add the drivers.
      const agent = spawn(
        "sh",
        [
          "-c",
          `i=0; while [ ! -e .git/weldall/publish.lock ] && [ $i -lt 3000 ]; do sleep 0.01; i=$((i+1)); done; cat '${planted}' >> .git/config`,
        ],
        { cwd: directory, stdio: "ignore" },
      );
      const agentDone = new Promise((resolve) => agent.on("exit", resolve));

      const result = await publish(directory);
      await agentDone;

      expect(result.outcome).toBe("published");
      expect(await ran()).toEqual([]);
      expect(await fake.must(["config", "--get", "filter.x.clean"], directory)).toContain(script);
      // The next run sees the drivers in the check.
      await expect(publish(directory)).rejects.toMatchObject({ code: "unsafe_git_config" });
      // Plain git runs them.
      await plainGitWithPrivateIndex(directory, ["read-tree", "HEAD"]);
      await plainGitWithPrivateIndex(directory, ["add", "-A"]);
      expect(await ran()).toEqual(["driver"]);
    });

    it("runs no clean filter added right before add -A", async () => {
      const directory = await folder();
      const script = await program("driver");
      await writeTree(directory, {
        ".gitattributes": "* filter=x\n",
        "src/app.ts": "export const app = 2;\n",
      });
      await appendConfigBefore(directory, "add -A", drivers(script));

      const result = await publish(directory, { git: fake.gitWrapper });

      expect(result.outcome).toBe("published");
      expect(await fake.must(["config", "--get", "filter.x.clean"], directory)).toContain(script);
      expect(await ran()).toEqual([]);
    });

    it("runs no smudge filter added right before read-tree -m -u brings the repository's files", async () => {
      const directory = await folder();
      const script = await program("driver");
      await writeTree(directory, {
        ".gitattributes": "* filter=x\n",
        "src/app.ts": "export const app = 2;\n",
      });
      const first = await publish(directory);
      const app = [...fake.apps.values()].find(({ name }) => name === `safety${counter}`)!;
      await fake.commitFiles(
        app.bare,
        first.pullRequest!.branch,
        { "src/review.ts": "from review\n" },
        "Review",
      );
      await appendConfigBefore(directory, "read-tree -m -u", drivers(script));

      const synced = await publish(directory, { git: fake.gitWrapper, syncOnly: true });

      expect(synced.outcome).toBe("synced");
      expect(await readFile(join(directory, "src/review.ts"), "utf8")).toBe("from review\n");
      expect(await fake.must(["config", "--get", "filter.x.smudge"], directory)).toContain(script);
      expect(await ran()).toEqual([]);
      // Plain git runs the smudge filter on checkout.
      await rm(join(directory, "src/review.ts"));
      await fake.must(["checkout", "--", "src/review.ts"], directory);
      expect(await ran()).toEqual(["driver"]);
    });

    it("runs no merge driver added right before merge-tree", async () => {
      const directory = await folder();
      const script = await program("driver");
      await writeTree(directory, {
        ".gitattributes": "*.ts merge=x\n",
        "src/app.ts": "export const app = 2;\n",
      });
      const first = await publish(directory);
      const app = [...fake.apps.values()].find(({ name }) => name === `safety${counter}`)!;
      await fake.commitFiles(
        app.bare,
        first.pullRequest!.branch,
        { "src/app.ts": "export const app = 'review';\n" },
        "Review",
      );
      await writeTree(directory, { "src/app.ts": "export const app = 'mine';\n" });
      await appendConfigBefore(directory, "merge-tree", drivers(script));

      const result = await publish(directory, { git: fake.gitWrapper });

      // The driver would have resolved the conflict; git's own merge reports it.
      expect(result.outcome).toBe("conflict");
      expect(result.conflict!.files.map(({ path }) => path)).toEqual(["src/app.ts"]);
      expect(await fake.must(["config", "--get", "merge.x.driver"], directory)).toContain(script);
      expect(await ran()).toEqual([]);
      // Plain merge-tree in the folder runs it.
      await fake.must(["branch", "ctl-a", "HEAD"], directory);
      await fake.must(["branch", "ctl-b", "HEAD"], directory);
      await fake.commitFiles(directory, "ctl-a", { "src/app.ts": "a\n" }, "a");
      await fake.commitFiles(directory, "ctl-b", { "src/app.ts": "b\n" }, "b");
      await fake.git(["merge-tree", "--write-tree", "ctl-a", "ctl-b"], directory);
      expect(await ran()).toEqual(["driver"]);
    });

    it("hands no credential to a promisor remote planted mid-run, and its lazy fetch runs nothing", async () => {
      const directory = await folder();
      await writeTree(directory, { "src/app.ts": "export const app = 2;\n" });
      expect((await publish(directory)).outcome).toBe("published");
      const alternateRefs = await program("alternate-refs");
      const helper = join(fake.root, "programs", `helper-${counter}`);
      await writeFile(helper, `#!/bin/sh\ncat > '${join(markers, "credential-helper")}'\n`, {
        mode: 0o755,
      });
      const planted = join(fake.root, `planted-${counter}.gitconfig`);
      await writeFile(
        planted,
        [
          "[extensions]",
          "\tpartialClone = evil",
          '[remote "evil"]',
          `\turl = ${fake.origin}/git/acme/app-safety${counter}.git`,
          "\tpromisor = true",
          "[credential]",
          `\thelper = !'${helper}'`,
          "[core]",
          `\talternateRefsCommand = '${alternateRefs}'`,
          "",
        ].join("\n"),
      );
      const missing = "de".repeat(20);
      // Right before publish looks up refs/weldall/theirs: the drivers' config, an alternate
      // object store, and a ref to an object that exists nowhere, so the lookup misses.
      await fake.beforeGit(
        "refs/weldall/theirs^{commit}",
        [
          `cat '${planted}' >> .git/config`,
          `echo '${join(fake.root, "templates/react/.git/objects")}' > .git/objects/info/alternates`,
          `echo ${missing} > .git/refs/weldall/theirs`,
        ].join("; "),
      );
      await writeTree(directory, { "src/app.ts": "export const app = 3;\n" });

      const result = await publish(directory, { git: fake.gitWrapper });

      expect(result.outcome).toBe("published");
      expect(await fake.must(["config", "--get", "remote.evil.promisor"], directory)).toBe("true");
      expect(await ran()).toEqual([]);
      // Plain git with the same settings starts the lazy fetch and runs the planted programs.
      await fake.git(["rev-parse", "-q", "--verify", `${missing}^{commit}`], directory, {
        env: { ...fake.publishEnvironment(), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
      });
      expect(await ran()).toEqual(["alternate-refs", "credential-helper"]);
      expect(await readFile(join(markers, "credential-helper"), "utf8")).toMatch(/password=wgc_/);
    });

    it("allows core.hooksPath, and the hooks it names still do not run", async () => {
      const directory = await folder();
      const hooks = join(fake.root, `hooks-${counter}`);
      await mkdir(hooks);
      for (const hook of ["reference-transaction", "post-index-change", "pre-push"])
        await writeFile(
          join(hooks, hook),
          `#!/bin/sh\nexec '${await program(hook)}' >/dev/null 2>&1\n`,
          { mode: 0o755 },
        );
      await fake.must(["config", "core.hooksPath", hooks], directory);
      await fake.must(["update-ref", "refs/control", "HEAD"], directory);
      expect(await ran()).toEqual(["reference-transaction"]);
      await clearMarkers();
      await writeTree(directory, { "src/app.ts": "export const app = 2;\n" });

      expect((await publish(directory)).outcome).toBe("published");
      expect(await ran()).toEqual([]);
    });

    it("refuses recorded values that would reach git as an option or a refspec", async () => {
      const directory = await folder();
      await fake.must(["config", "weldall.templateCommit", "--output=/tmp/x"], directory);
      await expect(publish(directory)).rejects.toMatchObject({
        code: "state_invalid",
        message: expect.stringContaining("weldall.templateCommit"),
      });

      const published = await folder();
      await writeTree(published, { "src/app.ts": "export const app = 2;\n" });
      expect((await publish(published)).outcome).toBe("published");
      await fake.must(
        ["config", "weldall.prBranch", "weldall/publish-x:refs/heads/main"],
        published,
      );
      await expect(publish(published)).rejects.toMatchObject({ code: "state_invalid" });
      await fake.must(["config", "weldall.prBranch", "-x"], published);
      await expect(
        readAppStatus({
          gitApps: fake.gitApps,
          registry: fake.registry,
          git: GIT,
          environment: fake.publishEnvironment(),
          directory: published,
        }),
      ).rejects.toMatchObject({ code: "state_invalid" });
    });

    it("accepts the config of git init with a first commit, of the set-up, of a clone and after publishing", async () => {
      const fresh = await folder();
      await expect(assertSafeRepository(repository(fresh))).resolves.toBeDefined();

      const setUp = await folder();
      await configureGitProxyRepository({
        directory: setUp,
        remoteUrl: `${fake.origin}/git/acme/app-setup.git`,
        git: GIT,
        environment: fake.publishEnvironment(),
      });
      await expect(assertSafeRepository(repository(setUp))).resolves.toBeDefined();

      const cloned = await folder();
      for (const [key, value] of [
        ["remote.origin.url", "https://example.com/acme/app.git"],
        ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
        ["branch.main.remote", "origin"],
        ["branch.main.merge", "refs/heads/main"],
        ["user.name", "Someone"],
        ["user.email", "someone@example.com"],
        ["core.autocrlf", "input"],
      ] as const)
        await fake.must(["config", key, value], cloned);
      await expect(assertSafeRepository(repository(cloned))).resolves.toBeDefined();

      const published = await folder();
      await writeTree(published, { "src/app.ts": "export const app = 2;\n" });
      expect((await publish(published)).outcome).toBe("published");
      await expect(assertSafeRepository(repository(published))).resolves.toBeDefined();
      expect(existsSync(join(published, ".git/objects/info/alternates"))).toBe(false);
      // Every run removed its private git directory; the parent is the person's alone.
      expect(await readdir(privateGitRoot)).toEqual([]);
      expect((await stat(privateGitRoot)).mode & 0o777).toBe(0o700);
    });
  },
);
