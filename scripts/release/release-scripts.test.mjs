import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { compareReleaseVersions, sortReleaseEntries } from "./packages.mjs";

const execFileAsync = promisify(execFile);
const root = new URL("../../", import.meta.url);
const run = async (script, args = [], env = {}) => {
  const { stdout } = await execFileAsync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return stdout;
};

const withServer = async (handler, callback) => {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
};

const json = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

const readJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const preparedPlan = (temp, overrides = {}) => {
  const entry = {
    name: "@weldall/sdk",
    version: "0.1.0",
    directory: "packages/sdk",
    tag: "sdk-v0.1.0",
    targetCommit: "a".repeat(40),
    ...overrides,
  };
  const packageDirectory = join(temp, "packed", "package");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: entry.name, version: entry.version }),
  );
  const tarball = join(temp, "package.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", join(temp, "packed"), "package"]);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  const plan = join(temp, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify({ schemaVersion: 1, packages: [{ ...entry, tarball, integrity }] }),
  );
  return { plan, integrity };
};

test("release entries publish in first-parent chronology and package order", () => {
  const entries = [
    { name: "@weldall/ci", version: "0.2.0", targetCommit: "new" },
    { name: "@weldall/sdk", version: "0.2.0", targetCommit: "new" },
    { name: "@weldall/sdk", version: "0.1.0", targetCommit: "old" },
  ];
  sortReleaseEntries(entries, ["old", "new"]);
  assert.deepEqual(
    entries.map(({ name, version }) => `${name}@${version}`),
    ["@weldall/sdk@0.1.0", "@weldall/sdk@0.2.0", "@weldall/ci@0.2.0"],
  );
  assert(compareReleaseVersions("0.2.0", "0.1.0") > 0);
  assert(compareReleaseVersions("1.0.0", "1.0.0-rc.1") > 0);
  assert(compareReleaseVersions("1.0.0-rc.2", "1.0.0-rc.1") > 0);
});

test("release PRs are created through the Forgejo API", async () => {
  const temp = mkdtempSync(join(tmpdir(), "weldall-release-script-"));
  const planFile = join(temp, "plan.txt");
  writeFileSync(planFile, "Release plan");
  let created;
  try {
    await withServer(
      async (request, response) => {
        if (request.method === "GET") return json(response, 200, []);
        created = await readJson(request);
        return json(response, 201, { number: 7, html_url: "https://forgejo.example/pr/7" });
      },
      async (serverUrl) => {
        const output = await run("scripts/release/open-release-pr.mjs", [], {
          FORGEJO_SERVER_URL: serverUrl,
          FORGEJO_REPOSITORY: "weldall/repository",
          RELEASE_BOT_TOKEN: "test-token",
          RELEASE_PLAN_FILE: planFile,
        });
        assert.match(output, /Created release PR #7/);
      },
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  assert.equal(created.base, "main");
  assert.equal(created.head, "release/pnpm");
  assert.match(created.body, /Release plan/);
});

test("existing release PRs are updated", async () => {
  let updated;
  await withServer(
    async (request, response) => {
      if (request.method === "GET")
        return json(response, 200, [
          {
            number: 3,
            html_url: "https://forgejo.example/pr/3",
            head: { label: "weldall:release/pnpm" },
            base: { ref: "main" },
          },
        ]);
      updated = await readJson(request);
      return json(response, 200, { number: 3 });
    },
    async (serverUrl) => {
      const output = await run("scripts/release/open-release-pr.mjs", [], {
        FORGEJO_SERVER_URL: serverUrl,
        FORGEJO_REPOSITORY: "weldall/repository",
        RELEASE_BOT_TOKEN: "test-token",
      });
      assert.match(output, /Updated release PR #3/);
    },
  );
  assert.equal(updated.title, "chore(release): version packages");
});

test("npm publishing accepts only the prepared tarball integrity", async () => {
  const temp = mkdtempSync(join(tmpdir(), "weldall-npm-publish-"));
  const { plan, integrity } = preparedPlan(temp);
  try {
    await withServer(
      (request, response) =>
        request.url.endsWith("/0.1.0")
          ? json(response, 200, { dist: { integrity } })
          : json(response, 200, { "dist-tags": { latest: "0.1.0" } }),
      async (registry) => {
        const output = await run("scripts/release/publish-packages.mjs", [plan], {
          NPM_REGISTRY_URL: registry,
          NODE_AUTH_TOKEN: "test-token",
        });
        assert.match(output, /already published with matching integrity/);
      },
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("zero versions are rejected before npm publication", async () => {
  const temp = mkdtempSync(join(tmpdir(), "weldall-zero-release-"));
  const { plan } = preparedPlan(temp, { version: "0.0.0" });
  try {
    await assert.rejects(
      run("scripts/release/publish-packages.mjs", [plan], {
        NODE_AUTH_TOKEN: "test-token",
      }),
      /Invalid package entry/,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Forgejo tags and releases are tied to the immutable release commit", async () => {
  const temp = mkdtempSync(join(tmpdir(), "weldall-forgejo-release-"));
  const { plan, integrity } = preparedPlan(temp);
  const tags = new Map();
  const releases = new Map();
  try {
    await withServer(
      async (request, response) => {
        if (!request.url.startsWith("/api/v1/repos/"))
          return json(response, 200, { dist: { integrity } });
        const releaseMatch = request.url.match(/\/releases\/tags\/(.+)$/);
        if (request.method === "GET" && releaseMatch) {
          const tag = decodeURIComponent(releaseMatch[1]);
          return releases.has(tag)
            ? json(response, 200, releases.get(tag))
            : json(response, 404, { message: "not found" });
        }
        const tagMatch = request.url.match(/\/tags\/(.+)$/);
        if (request.method === "GET" && tagMatch) {
          const tag = decodeURIComponent(tagMatch[1]);
          return tags.has(tag)
            ? json(response, 200, { name: tag, commit: { id: tags.get(tag) } })
            : json(response, 404, { message: "not found" });
        }
        if (request.method === "POST" && request.url.endsWith("/releases")) {
          const release = await readJson(request);
          tags.set(release.tag_name, release.target_commitish);
          releases.set(release.tag_name, release);
          return json(response, 201, {
            ...release,
            html_url: `https://forgejo.example/releases/${release.tag_name}`,
          });
        }
        return json(response, 404, { message: "unexpected request" });
      },
      async (serverUrl) => {
        const env = {
          NPM_REGISTRY_URL: serverUrl,
          FORGEJO_SERVER_URL: serverUrl,
          FORGEJO_REPOSITORY: "weldall/repository",
          RELEASE_BOT_TOKEN: "test-forgejo-token",
        };
        const first = await run("scripts/release/create-forgejo-releases.mjs", [plan], env);
        assert.match(first, /Created tag and Forgejo release/);
        const second = await run("scripts/release/create-forgejo-releases.mjs", [plan], env);
        assert.match(second, /Forgejo release already exists/);
      },
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  assert.equal(tags.get("sdk-v0.1.0"), "a".repeat(40));
  assert.equal(releases.size, 1);
});

test("release selection recovers every incomplete persistent manifest", async () => {
  const repository = mkdtempSync(join(tmpdir(), "weldall-release-selection-"));
  try {
    mkdirSync(join(repository, "scripts", "release"), { recursive: true });
    mkdirSync(join(repository, ".releases"), { recursive: true });
    copyFileSync(
      new URL("./select-release-manifests.mjs", import.meta.url),
      join(repository, "scripts", "release", "select-release-manifests.mjs"),
    );
    copyFileSync(
      new URL("./packages.mjs", import.meta.url),
      join(repository, "scripts", "release", "packages.mjs"),
    );
    const manifestPath = join(repository, ".releases", "release-123456789abc.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        packages: [
          {
            name: "@weldall/sdk",
            version: "0.1.0",
            directory: "packages/sdk",
            tag: "sdk-v0.1.0",
          },
        ],
      }),
    );
    execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: repository,
    });
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "-m", "release"], { cwd: repository, stdio: "ignore" });
    const target = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    let complete = false;
    await withServer(
      (request, response) => {
        if (!request.url.startsWith("/api/v1/repos/"))
          return complete
            ? json(response, 200, { dist: { integrity: "test" } })
            : json(response, 404, { message: "not published" });
        if (!complete) return json(response, 404, { message: "not found" });
        if (request.url.includes("/releases/tags/"))
          return json(response, 200, { tag_name: "sdk-v0.1.0" });
        return json(response, 200, { name: "sdk-v0.1.0", commit: { id: target } });
      },
      async (serverUrl) => {
        const output = join(repository, "selection.txt");
        const env = {
          ...process.env,
          FORGEJO_SERVER_URL: serverUrl,
          FORGEJO_REPOSITORY: "weldall/repository",
          RELEASE_BOT_TOKEN: "test-token",
          NPM_REGISTRY_URL: serverUrl,
        };
        await execFileAsync(
          process.execPath,
          ["scripts/release/select-release-manifests.mjs", output],
          {
            cwd: repository,
            env,
          },
        );
        assert.equal(readFileSync(output, "utf8"), ".releases/release-123456789abc.json\n");
        complete = true;
        await execFileAsync(
          process.execPath,
          ["scripts/release/select-release-manifests.mjs", output],
          {
            cwd: repository,
            env,
          },
        );
        assert.equal(readFileSync(output, "utf8"), "");
      },
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("deleting publishable source still requires a change intent", async () => {
  const repository = mkdtempSync(join(tmpdir(), "weldall-intent-deletion-"));
  try {
    mkdirSync(join(repository, "packages", "sdk"), { recursive: true });
    mkdirSync(join(repository, "scripts", "release"), { recursive: true });
    writeFileSync(join(repository, "packages", "sdk", "index.js"), "export {};\n");
    copyFileSync(
      new URL("./check-change-intents.mjs", import.meta.url),
      join(repository, "scripts", "release", "check-change-intents.mjs"),
    );
    execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: repository,
    });
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repository, stdio: "ignore" });
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    rmSync(join(repository, "packages", "sdk", "index.js"));
    execFileSync("git", ["add", "-A"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "delete"], { cwd: repository, stdio: "ignore" });
    await assert.rejects(
      execFileAsync(process.execPath, ["scripts/release/check-change-intents.mjs", base], {
        cwd: repository,
        encoding: "utf8",
      }),
      /without a matching change intent for: @weldall\/sdk/,
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("committed release manifests cannot be modified", async () => {
  const repository = mkdtempSync(join(tmpdir(), "weldall-manifest-immutability-"));
  try {
    mkdirSync(join(repository, ".releases"), { recursive: true });
    mkdirSync(join(repository, "scripts", "release"), { recursive: true });
    const manifest = join(repository, ".releases", "release-123456789abc.json");
    writeFileSync(manifest, '{"schemaVersion":1,"packages":[]}\n');
    copyFileSync(
      new URL("./check-release-manifests.mjs", import.meta.url),
      join(repository, "scripts", "release", "check-release-manifests.mjs"),
    );
    copyFileSync(
      new URL("./packages.mjs", import.meta.url),
      join(repository, "scripts", "release", "packages.mjs"),
    );
    execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: repository,
    });
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repository, stdio: "ignore" });
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    writeFileSync(manifest, '{"schemaVersion":1,"packages":["rewritten"]}\n');
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "-m", "rewrite"], { cwd: repository, stdio: "ignore" });
    await assert.rejects(
      execFileAsync(process.execPath, ["scripts/release/check-release-manifests.mjs", base], {
        cwd: repository,
        encoding: "utf8",
      }),
      /Release manifests are immutable/,
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("only a workflow-confirmed generated release PR may skip intent enforcement", async () => {
  const output = await run("scripts/release/check-change-intents.mjs", [], {
    CHANGE_RELEASE_PR: "true",
  });
  assert.match(output, /intent enforcement is skipped/);
  await assert.rejects(
    run("scripts/release/check-change-intents.mjs", [], {
      CHANGE_HEAD_REF: "release/pnpm",
    }),
    /merge-base SHA is required/,
  );
});
