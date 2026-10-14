import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sdkDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = resolve(sdkDir, "../..");
const temp = mkdtempSync(join(tmpdir(), "weldall-sdk-examples-"));

// CI jobs can share a runner's network namespace. Avoid fixed example ports.
const availablePort = async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return String(port);
};

const waitForUrl = async (url, child) => {
  let exit;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (exit) throw new Error(`example server exited before startup: ${JSON.stringify(exit)}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`example server did not become ready: ${url}`);
};

const smokeServer = async (target, command, args, url, env = {}, verify) => {
  const child = spawn(command, args, {
    cwd: target,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  try {
    await waitForUrl(url, child);
    await verify?.();
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) resolveExit();
      else child.once("exit", resolveExit);
    });
  }
};

try {
  execFileSync("pnpm", ["pack", "--pack-destination", temp], {
    cwd: sdkDir,
    stdio: "inherit",
  });
  const tarball = join(
    temp,
    readdirSync(temp).find((name) => name.endsWith(".tgz")),
  );
  for (const name of ["basic", "hono", "next", "astro", "starlight-weldall-search"]) {
    const target = join(temp, name);
    cpSync(join(root, "examples", name), target, {
      recursive: true,
      filter: (source) =>
        !source.includes("node_modules") &&
        !source.includes("/.astro") &&
        !source.includes("/.next") &&
        !source.includes("/.turbo") &&
        !source.includes("/dist"),
    });
    const manifestPath = join(target, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dependencies["@weldall/sdk"] = `file:${tarball}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      join(target, "pnpm-workspace.yaml"),
      "allowBuilds:\n  esbuild: true\n  sharp: true\nonlyBuiltDependencies:\n  - esbuild\n  - sharp\n",
    );
    execFileSync("pnpm", ["install", "--prefer-offline", "--no-frozen-lockfile"], {
      cwd: target,
      stdio: "inherit",
    });
    execFileSync("pnpm", ["build"], {
      cwd: target,
      stdio: "inherit",
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        ASTRO_TELEMETRY_DISABLED: "1",
      },
    });

    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    if (name === "basic") {
      execFileSync("node", ["dist/index.js"], { cwd: target, stdio: "inherit" });
    } else if (name === "hono") {
      await smokeServer(
        target,
        "node",
        ["dist/index.js"],
        `${origin}/.well-known/oauth-protected-resource`,
        { PORT: port },
      );
    } else if (name === "next") {
      await smokeServer(
        target,
        "pnpm",
        ["exec", "next", "start", "-H", "127.0.0.1", "-p", port],
        `${origin}/`,
        { NEXT_TELEMETRY_DISABLED: "1" },
      );
    } else if (name === "astro") {
      await smokeServer(target, "node", ["dist/server/entry.mjs"], `${origin}/`, {
        HOST: "127.0.0.1",
        PORT: port,
        ASTRO_TELEMETRY_DISABLED: "1",
      });
    } else {
      const signingKey = execFileSync("pnpm", ["--silent", "print-dev-key"], {
        cwd: target,
        encoding: "utf8",
      });
      JSON.parse(signingKey);
      await smokeServer(
        target,
        "node",
        ["dist/server/entry.mjs"],
        `${origin}/`,
        {
          HOST: "127.0.0.1",
          PORT: port,
          ASTRO_TELEMETRY_DISABLED: "1",
          WELDALL_SIGNING_KEY: signingKey,
        },
        async () => {
          const response = await fetch(`${origin}/api/search?q=umsatz`);
          if (response.status !== 401) {
            throw new Error(`starlight unauthenticated search returned ${response.status}`);
          }
          const content = await fetch(`${origin}/api/content?path=/team/overview/`);
          if (content.status !== 401) {
            throw new Error(`starlight unauthenticated content returned ${content.status}`);
          }
        },
      );
    }
    console.log(`fresh tarball build and runtime smoke passed: ${name} (${basename(tarball)})`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
