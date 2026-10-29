import { afterEach, describe, expect, it } from "vitest";
import { mkdir, symlink, readFile, rm, copyFile } from "node:fs/promises";
import path from "node:path";
import { WeldallCli, resolveCli, trustedDirectories } from "../src/cli.js";
import { fixture, organizationInstructions } from "./fixture.mjs";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("PATH selection", () => {
  it("ignores npm/project/relative paths without hardcoding local binary directories", () => {
    expect(
      trustedDirectories(
        ":.:./bin:/project/bin:/cache/_npx/abc/node_modules/.bin:/usr/local/bin:/opt/it/bin",
        "/project",
        "linux",
      ),
    ).toEqual(["/usr/local/bin", "/opt/it/bin"]);
    expect(
      trustedDirectories(
        ".;C:\\project;C:\\cache\\node_modules\\.bin;C:\\IT\\bin",
        "C:\\project",
        "win32",
      ),
    ).toEqual(["C:\\IT\\bin"]);
    expect(trustedDirectories("/usr/local/bin", "/", "darwin")).toEqual(["/usr/local/bin"]);
  });
  it.skipIf(process.platform === "win32")(
    "canonicalizes and rejects links back into a project",
    async () => {
      const f = await fixture();
      cleanups.push(f.cleanup);
      expect(await resolveCli(f.env, f.cwd)).toBe(
        await import("node:fs/promises").then((fs) => fs.realpath(f.executable)),
      );
      const bad = path.join(f.root, "bad");
      await mkdir(bad);
      const target = path.join(f.cwd, "weldall");
      await symlink(f.executable, target);
      await symlink(target, path.join(bad, "weldall"));
      // Canonical resolution follows the local binary target; textual symlinks do not establish identity.
      expect(await resolveCli({ PATH: bad }, f.cwd)).toBe(
        await import("node:fs/promises").then((fs) => fs.realpath(f.executable)),
      );
      await rm(target);
      await copyFile(f.executable, target);
      await expect(resolveCli({ PATH: bad }, f.cwd)).rejects.toMatchObject({ code: "cli_missing" });
      await rm(path.join(bad, "weldall"));
      await expect(resolveCli({ PATH: bad }, f.cwd)).rejects.toMatchObject({ code: "cli_missing" });
    },
  );
});

describe.skipIf(process.platform === "win32")("CLI subprocess boundary", () => {
  const setup = async (env: Record<string, string> = {}) => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const cli = new WeldallCli(f.executable, { ...f.env, ...env });
    cleanups.push(() => cli.close());
    return { f, cli };
  };
  it("checks the stable CLI version before organization-context loading", async () => {
    const { f, cli } = await setup();
    await cli.initialize();
    expect(cli.executable).toBe(f.executable);
  });
  it.each(["0.19.9", "1.0.0", "0.20.0-dev", "garbage"])(
    "rejects incompatible %s",
    async (version) => {
      const { cli } = await setup({ FAKE_VERSION: version });
      await expect(cli.initialize()).rejects.toMatchObject({ code: "cli_version" });
    },
  );
  it("loads only organization instructions from one status JSON call", async () => {
    const { f, cli } = await setup();
    expect(await cli.loadOrganizationInstructions()).toBe(organizationInstructions);
    const calls = path.join(f.root, "context-calls");
    const checked = new WeldallCli(f.executable, { ...f.env, FAKE_CALLS: calls });
    cleanups.push(() => checked.close());
    expect(await checked.loadOrganizationInstructions()).toBe(organizationInstructions);
    expect((await readFile(calls, "utf8")).trim()).toBe(JSON.stringify(["status", "--json"]));
  });
  it.each([undefined, 1, 2, "1"])(
    "negotiates native discovery explicitly (%s)",
    async (version) => {
      const { cli } = await setup({
        FAKE_STATUS: JSON.stringify({
          organizationInstructions: "",
          ...(version === undefined ? {} : { nativeDiscoveryVersion: version }),
        }),
      });
      await cli.loadOrganizationInstructions();
      expect(cli.nativeDiscoveryVersion).toBe(version === 1 ? 1 : undefined);
    },
  );
  it("accepts an explicitly empty organization configuration", async () => {
    const { cli } = await setup({ FAKE_STATUS: JSON.stringify({ organizationInstructions: "" }) });
    expect(await cli.loadOrganizationInstructions()).toBe("");
  });
  it.each([
    ["{}", "cli_context"],
    ['{"organizationInstructions":null}', "organization_context"],
    ['{"organizationInstructions":42}', "invalid_response"],
    ['{"organizationInstructions":{}}', "invalid_response"],
    ["[]", "invalid_response"],
    ["null", "invalid_response"],
    ["not-json-secret", "invalid_response"],
    [JSON.stringify({ organizationInstructions: "x".repeat(100_001) }), "invalid_response"],
  ])("rejects missing or malformed context (case %#)", async (output, code) => {
    const { cli } = await setup({ FAKE_STATUS: output });
    await expect(cli.loadOrganizationInstructions()).rejects.toMatchObject({ code });
  });
  it("propagates status command failures without treating them as empty context", async () => {
    const { cli } = await setup({ FAKE_STATUS_ERROR: "1" });
    await expect(cli.loadOrganizationInstructions()).rejects.toMatchObject({
      code: "cli_failed",
      exitCode: 3,
    });
  });
  it("preserves the exit code and helpful stderr without terminal formatting", async () => {
    const { cli } = await setup({ FAKE_ERROR: "1" });
    await cli.initialize();
    await expect(cli.run(["skills", "list", "--json"])).rejects.toMatchObject({
      code: "cli_failed",
      exitCode: 3,
      stderr: "Missing scope: expenses:read\nAsk for access, then run weldall login.",
    });
  });
  it("retries only credential-store reads that fail before execution", async () => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const calls = path.join(f.root, "keychain-calls");
    const cli = new WeldallCli(f.executable, {
      ...f.env,
      FAKE_CALLS: calls,
      FAKE_KEYCHAIN_FAILURES: "2",
    });
    cleanups.push(() => cli.close());

    await expect(cli.run(["request"])).resolves.toContain('"ok":true');
    expect((await readFile(calls, "utf8")).trim().split("\n")).toHaveLength(3);
  });
  it("keeps credential-store retries within the call's timeout", async () => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const calls = path.join(f.root, "keychain-calls");
    const cli = new WeldallCli(f.executable, {
      ...f.env,
      FAKE_CALLS: calls,
      FAKE_KEYCHAIN_FAILURES: "3",
    });
    cleanups.push(() => cli.close());

    // The backoff after the second failure ends past the deadline.
    await expect(cli.run(["request"], undefined, 400)).rejects.toMatchObject({ code: "busy" });
    expect((await readFile(calls, "utf8")).trim().split("\n")).toHaveLength(2);
  });
  it("cancels a credential-store retry backoff", async () => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const calls = path.join(f.root, "keychain-cancel-calls");
    const controller = new AbortController();
    const cli = new WeldallCli(f.executable, {
      ...f.env,
      FAKE_CALLS: calls,
      FAKE_KEYCHAIN_FAILURES: "1",
    });
    cleanups.push(() => cli.close());

    const pending = cli.run(["request"], controller.signal);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await readFile(calls, "utf8")).trim()) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect((await readFile(calls, "utf8")).trim().split("\n")).toHaveLength(1);
  });
  it("does not retry other CLI failures", async () => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const calls = path.join(f.root, "failed-calls");
    const cli = new WeldallCli(f.executable, { ...f.env, FAKE_CALLS: calls, FAKE_ERROR: "1" });
    cleanups.push(() => cli.close());

    await expect(cli.run(["request"])).rejects.toMatchObject({ code: "cli_failed" });
    expect((await readFile(calls, "utf8")).trim().split("\n")).toHaveLength(1);
  });
  it("does not re-resolve or replace a CLI removed after startup", async () => {
    const { f, cli } = await setup();
    await cli.initialize();
    await rm(f.executable);
    await expect(cli.run(["skills", "list", "--json"])).rejects.toMatchObject({
      code: "cli_missing",
    });
  });
  it("bounds child output", async () => {
    const { cli } = await setup({ FAKE_LARGE: "1" });
    await expect(cli.run(["request"])).rejects.toMatchObject({ code: "output_limit" });
  });
  it("kills and reaps the child on deadline", async () => {
    const { f, cli } = await setup({ FAKE_WAIT: "1" });
    const pidFile = path.join(f.root, "pid");
    const child = new WeldallCli(f.executable, { ...f.env, FAKE_WAIT: "1", FAKE_PID: pidFile });
    cleanups.push(() => child.close());
    await expect(child.run(["request"], undefined, 300)).rejects.toMatchObject({ code: "timeout" });
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    await cli.close();
  });
  it("queues calls beyond four running ones within their timeout", async () => {
    const { cli } = await setup({ FAKE_WAIT: "1" });
    const stop = new AbortController();
    const fails = (call: Promise<string>, code: string) =>
      expect(call).rejects.toMatchObject({ code });
    const running = Array.from({ length: 4 }, () =>
      fails(cli.run(["request"], undefined, 200), "timeout"),
    );
    // Starts once a slot frees, so it ends with its own deadline, not with "busy".
    const queued = fails(cli.run(["request"], undefined, 1000), "timeout");
    const expired = fails(cli.run(["request"], undefined, 100), "busy");
    const waiting = Array.from({ length: 14 }, () =>
      fails(cli.run(["request"], stop.signal, 5000), "cancelled"),
    );
    await fails(cli.run(["request"], undefined, 1000), "busy");
    await Promise.all([...running, expired]);
    stop.abort();
    await Promise.all([queued, ...waiting]);
  });
  it("cancels active operations on close and refuses new work", async () => {
    const { cli } = await setup({ FAKE_WAIT: "1" });
    // Five calls: four running and one waiting for a slot.
    const pending = Array.from({ length: 5 }, () => cli.run(["request"]));
    const assertions = pending.map((call) =>
      expect(call).rejects.toMatchObject({ code: "cancelled" }),
    );
    await cli.close();
    await Promise.all(assertions);
    await expect(cli.run(["request"])).rejects.toMatchObject({ code: "cancelled" });
  });
});
