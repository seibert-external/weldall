import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { startControlledMockServer } from "./controlled-mock-server.mjs";

function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function assertRun(result, expectedCode, label) {
  assert.equal(result.status, expectedCode, `${label} exited unexpectedly:\n${output(result)}`);
  return result;
}

async function seedPreference(path, issuer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ issuer }, null, 2)}\n`, { mode: 0o600 });
}

const exists = (path) =>
  access(path).then(
    () => true,
    (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    },
  );

async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

const onlyCredential = async (path) => {
  const value = JSON.parse(await readFile(path, "utf8"));
  assert.equal(Object.keys(value).length, 1, "expected exactly one guarded test session");
  return Object.values(value)[0];
};

async function authenticatedFlow({ run, interruptRun, mock, paths, workspace, preferencesFile }) {
  assertRun(
    await run(["config", "set-issuer", mock.issuer]),
    0,
    "config set-issuer through controlled discovery",
  );
  assert.equal(
    await readFile(preferencesFile, "utf8"),
    `${JSON.stringify({ issuer: mock.issuer }, null, 2)}\n`,
    "set-issuer must persist the isolated preference",
  );
  const savedPreference = assertRun(
    await run(["config", "get-issuer", "--json"]),
    0,
    "saved config get-issuer",
  );
  assert.deepEqual(JSON.parse(savedPreference.stdout), {
    issuer: mock.issuer,
    source: "preferences",
  });

  const login = run(["login"]);
  let loginResult;
  try {
    const authorizationUrl = await waitForFile(paths.browser);
    const callback = mock.registerAuthorization(authorizationUrl);
    const callbackResponse = await fetch(callback);
    assert.equal(callbackResponse.status, 200, "real loopback callback must accept exact binding");
    assert.match(await callbackResponse.text(), /login complete/);
    loginResult = await login;
  } finally {
    if (loginResult === undefined) {
      login.cancel?.();
      await login.catch(() => undefined);
    }
  }
  assertRun(loginResult, 0, "login");

  const loginCredential = await onlyCredential(paths.credentials);
  assert.equal(loginCredential.refreshToken, "artifact-refresh-0");
  assert.equal(loginCredential.issuer, mock.issuer);
  assert.ok(loginCredential.privateJwk?.d, "login must persist the dynamic private device JWK");

  const whoamiPlain = assertRun(await run(["whoami"]), 0, "whoami plain");
  assert.match(whoamiPlain.stdout, /Artifact User/);
  assert.match(whoamiPlain.stdout, /artifact\.user@example\.com/);
  const rotatedCredential = await onlyCredential(paths.credentials);
  assert.equal(rotatedCredential.refreshToken, "artifact-refresh-1");
  assert.notEqual(rotatedCredential.refreshToken, loginCredential.refreshToken);

  const whoamiJson = assertRun(await run(["whoami", "--json"]), 0, "whoami JSON");
  assert.deepEqual(JSON.parse(whoamiJson.stdout), {
    issuer: mock.issuer,
    subject: "artifact-user",
    name: "Artifact User",
    email: "artifact.user@example.com",
  });
  const scopes = assertRun(await run(["scopes", "--json"]), 0, "scopes JSON");
  assert.deepEqual(JSON.parse(scopes.stdout).assignedScopes, ["files:read", "files:write"]);
  const skills = assertRun(await run(["skills", "list", "--json"]), 0, "skills JSON");
  assert.equal(JSON.parse(skills.stdout).items[0].slug, "files.transfer");

  const uploadBytes = Buffer.from([0, 1, 2, 255, 128, 13, 10, 32, 195, 188]);
  await writeFile(paths.upload, uploadBytes);
  const upload = assertRun(
    await run([
      "request",
      "-X",
      "PUT",
      "--scope",
      "files:write",
      "--upload-file",
      paths.upload,
      mock.uploadUrl,
    ]),
    0,
    "binary upload from Unicode path",
  );
  assert.deepEqual(JSON.parse(upload.stdout), { uploaded: uploadBytes.length });
  assert.deepEqual(mock.uploadedBytes, uploadBytes);

  await writeFile(paths.download, Buffer.from("existing destination must be replaced"));
  assertRun(
    await run(["request", "--scope", "files:read", "--output", paths.download, mock.downloadUrl]),
    0,
    "binary download to existing Unicode path",
  );
  assert.deepEqual(await readFile(paths.download), mock.downloadBytes);
  const downloadDebris = (await readdir(dirname(paths.download))).filter(
    (entry) => entry.startsWith(`.${basename(paths.download)}.`) && entry.endsWith(".tmp"),
  );
  assert.deepEqual(downloadDebris, [], "atomic download must leave no temporary debris");

  const oldDestination = Buffer.from("old destination survives an interrupted transfer");
  await writeFile(paths.download, oldDestination);
  const delayedDownload = mock.armDownloadDelay();
  const interrupted = interruptRun([
    "request",
    "--scope",
    "files:read",
    "--output",
    paths.download,
    mock.downloadUrl,
  ]);
  let interruptedResult;
  try {
    await Promise.race([
      delayedDownload.entered,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("delayed download did not start")), 10_000),
      ),
    ]);
    const deadline = Date.now() + 10_000;
    let partialTemporary;
    while (Date.now() < deadline && !partialTemporary) {
      for (const entry of await readdir(dirname(paths.download))) {
        if (
          entry.startsWith(`.${basename(paths.download)}.`) &&
          entry.endsWith(".tmp") &&
          (await stat(join(dirname(paths.download), entry))).size > 0
        ) {
          partialTemporary = entry;
          break;
        }
      }
      if (!partialTemporary) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(partialTemporary, "interrupted artifact download must reach a partial temp file");
    assert.equal(
      interrupted.interrupt?.(),
      true,
      "artifact child must accept native terminal Ctrl-C",
    );
    interruptedResult = await interrupted;
  } finally {
    delayedDownload.release();
    if (interruptedResult === undefined) {
      await interrupted.cancel?.();
      interruptedResult = await interrupted;
    }
  }
  // PowerShell can normalize an interrupted native child's exit status to zero
  // after ConPTY delivers Ctrl-C. The process-exit and filesystem assertions
  // below are the portable evidence that the interruption took effect.
  if (process.platform !== "win32")
    assert.notEqual(interruptedResult.status, 0, output(interruptedResult));
  assert.equal(interruptedResult.exited, true, "interrupted terminal process must not survive");
  assert.deepEqual(await readFile(paths.download), oldDestination);
  assert.deepEqual(
    (await readdir(dirname(paths.download))).filter(
      (entry) => entry.startsWith(`.${basename(paths.download)}.`) && entry.endsWith(".tmp"),
    ),
    [],
    "interrupted artifact download must remove temporary debris",
  );

  const delayed = mock.armRefreshDelay();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    delayed.release();
  };
  const first = run(["whoami", "--json"]);
  let contentionError;
  try {
    await Promise.race([
      delayed.entered,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("delayed authenticated operation did not arrive")),
          10_000,
        ),
      ),
    ]);
    const contender = await run(["scopes", "--json"]);
    assert.equal(contender.status, 1, output(contender));
    assert.match(contender.stderr, /another weldall command is running/);
  } catch (error) {
    contentionError = error;
  } finally {
    release();
  }
  const firstResult = await first;
  if (contentionError) throw contentionError;
  assertRun(firstResult, 0, "delayed authenticated operation");

  assertRun(await run(["logout"]), 0, "logout");
  assert.equal(mock.revokedCount, 1, "logout must call remote revocation exactly once");
  assert.equal(
    await exists(paths.credentials),
    false,
    "logout must remove the guarded session file",
  );
  const afterLogout = await run(["whoami", "--json"]);
  assert.equal(afterLogout.status, 1, output(afterLogout));
  assert.match(afterLogout.stderr, /You are not logged in/);
  assertRun(await run(["config", "reset-issuer"]), 0, "authenticated config reset-issuer");
  assertRun(
    await run(["config", "get-issuer", "--json"]),
    2,
    "cleared authenticated config get-issuer",
  );

  const plan = assertRun(
    await run(["plan", "--json"], { cwd: workspace, env: mock.machineEnvironment }),
    0,
    "IaC plan JSON",
  );
  assert.deepEqual(JSON.parse(plan.stdout).actions, [
    { action: "create", address: "scope.artifact_read", identity: "artifact:read" },
  ]);
  assertRun(
    await run(["state", "pull"], { cwd: workspace, env: mock.machineEnvironment }),
    0,
    "IaC state pull",
  );
  const lock = await readFile(join(workspace, "weldall.lock.yml"), "utf8");
  assert.match(lock, /installationId: 11111111-2222-4333-8444-555555555555/);
  assert.match(lock, /observedRevision: 7/);
  assert.match(lock, /scope\.artifact_read:/);

  assert.ok(
    mock.rotationCount >= 7,
    "authenticated reads and transfers must rotate refresh tokens",
  );
  for (const seam of [
    "POST /api/auth/oauth2/token",
    "GET /api/auth/oauth2/userinfo",
    "GET /api/me/scopes",
    "GET /api/me/skills",
    "PUT /api/files/upload",
    "GET /api/files/download",
    "POST /api/auth/oauth2/revoke",
    "POST /api/iac/v1/plan",
  ]) {
    const [method, path] = seam.split(" ");
    assert.ok(
      mock.requests.some((request) => request.startsWith(`${method} `) && request.endsWith(path)),
      `missing mock seam ${seam}`,
    );
  }
  mock.assertHealthy();
}

export async function runBlackBoxHarness({
  version,
  launch,
  interruptLaunch,
  expectRuntime,
  expectSystemCa,
  keyringSmoke = false,
  keyringEnvironment = {},
  hostileCwd,
  authenticated = false,
}) {
  let root;
  let mock;
  let primaryFailure;
  try {
    root = await mkdtemp(join(tmpdir(), "weldall smoke ü space "));
    const home = join(root, "isolated home ü");
    const workspace = join(root, "workspace with spaces 日本語");
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    mock = authenticated ? await startControlledMockServer() : null;
    const issuer = mock?.issuer ?? `https://black-box-${randomUUID()}.example.com`;
    const preferencesFile =
      process.platform === "darwin"
        ? join(home, ".weldall", "artifact-preferences.json")
        : join(home, ".weldall", "config.json");
    const paths = {
      browser: join(root, "captured browser URL ü.txt"),
      credentials: join(root, "guarded credentials 日本語.json"),
      upload: join(root, "upload source ü 日本語.bin"),
      download: join(root, "download destination ü 日本語.bin"),
    };
    if (!mock) await seedPreference(preferencesFile, issuer);
    const defaultCwd = hostileCwd ?? root;
    const environment = {
      NODE_ENV: "test",
      ...(process.platform === "darwin" ? { WELDALL_TEST_PREFERENCES_FILE: preferencesFile } : {}),
      ...(mock
        ? {
            WELDALL_E2E_BROWSER_URL_FILE: paths.browser,
            WELDALL_E2E_CREDENTIALS_FILE: paths.credentials,
            WELDALL_E2E_HTTP_BRIDGE: mock.bridgeEnvironment,
          }
        : {}),
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      NO_COLOR: "1",
      TERM: "dumb",
    };

    const run = (args, options = {}) =>
      Promise.resolve(
        launch(args, {
          cwd: options.cwd ?? defaultCwd,
          env: { ...environment, ...(options.env ?? {}) },
        }),
      );
    const interruptRun = (args, options = {}) => {
      assert.equal(typeof interruptLaunch, "function", "authenticated smoke requires a PTY");
      return interruptLaunch(args, {
        cwd: options.cwd ?? defaultCwd,
        env: { ...environment, ...(options.env ?? {}) },
      });
    };

    const versionResult = assertRun(await run(["--version"]), 0, "--version");
    assert.equal(versionResult.stdout.trim(), version, "version output must be exact");

    const rootHelp = assertRun(await run(["--help"]), 0, "root help");
    assert.match(rootHelp.stdout, /USAGE:/);
    assert.match(rootHelp.stdout, /weldall/);
    const initHelp = assertRun(await run(["init", "--help"]), 0, "init help");
    assert.match(initHelp.stdout, /Create a native Weldall YAML workspace/);
    assertRun(await run(["definitely-not-a-command"]), 2, "unknown command");

    if (!mock) {
      const getPreference = assertRun(
        await run(["config", "get-issuer", "--json"]),
        0,
        "config get-issuer",
      );
      assert.deepEqual(JSON.parse(getPreference.stdout), { issuer, source: "preferences" });
      assertRun(await run(["config", "reset-issuer"]), 0, "config reset-issuer");
      assertRun(await run(["config", "get-issuer", "--json"]), 2, "cleared config get-issuer");
    }

    const workspaceName = authenticated ? "Artifact Workspace" : "space ü 日本語 &|<>()^%!$;`";
    assertRun(
      await run(["init", "--issuer", issuer, "--name", workspaceName], { cwd: workspace }),
      0,
      "IaC init",
    );
    const validation = assertRun(
      await run(["validate", "--json"], { cwd: workspace }),
      0,
      "IaC validate JSON",
    );
    assert.deepEqual(JSON.parse(validation.stdout), {
      valid: true,
      objectCount: 0,
      workspace: { name: workspaceName, issuer },
    });
    assert.ok((await readFile(join(workspace, "weldall.yml"), "utf8")).includes(workspaceName));

    const rejectedHook = await run([], {
      env: { NODE_ENV: "production", WELDALL_TEST_RUNTIME_DIAGNOSTICS: "1" },
    });
    assert.equal(rejectedHook.status, 1, "runtime hook must fail outside NODE_ENV=test");
    assert.match(rejectedHook.stderr, /only allowed when NODE_ENV=test/);

    const diagnosticsEnvironment = {
      ...keyringEnvironment,
      WELDALL_TEST_RUNTIME_DIAGNOSTICS: "1",
      ...(keyringSmoke ? { WELDALL_TEST_KEYRING_SMOKE: randomUUID().replaceAll("-", "") } : {}),
    };
    const diagnosticsRun = assertRun(
      await run([], { cwd: hostileCwd ?? workspace, env: diagnosticsEnvironment }),
      0,
      "runtime diagnostics",
    );
    const diagnostics = JSON.parse(diagnosticsRun.stdout);
    assert.equal(diagnostics.runtime.name, expectRuntime);
    assert.equal(diagnostics.autoloadSentinels.dotenv, false);
    assert.equal(diagnostics.autoloadSentinels.bunfig, false);
    if (expectSystemCa) assert.ok(diagnostics.execArgv.includes("--use-system-ca"));
    if (keyringSmoke) assert.equal(diagnostics.keyringRoundTrip, true);

    if (mock)
      await authenticatedFlow({
        run,
        interruptRun,
        mock,
        paths,
        workspace,
        preferencesFile,
      });
    return { root, diagnostics };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      mock?.close() ?? Promise.resolve(),
      root ? rm(root, { recursive: true, force: true }) : Promise.resolve(),
    ]);
    const cleanupFailures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupFailures],
        primaryFailure === undefined
          ? "Black-box harness cleanup failed"
          : "Black-box harness failed and cleanup also failed",
        primaryFailure === undefined ? undefined : { cause: primaryFailure },
      );
    }
  }
}
