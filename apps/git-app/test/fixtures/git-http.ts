import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

/**
 * Real git for the git proxy tests (carried over from `apps/weldall/test/fixtures/git-http.ts`):
 * the system `git`, and `git http-backend` behind a tiny HTTP server as the upstream Git host.
 * Everything listens on 127.0.0.1 only.
 */

export const GIT = "/usr/bin/git";

/** Why the real-git tests cannot run here, or null when `git` and `git http-backend` exist. */
export function gitUnavailableReason(): string | null {
  if (!existsSync(GIT)) return `${GIT} not found`;
  const execPath = spawnSync(GIT, ["--exec-path"], { encoding: "utf8" });
  if (execPath.status !== 0) return "git --exec-path failed";
  const backend = path.join(execPath.stdout.trim(), "git-http-backend");
  return existsSync(backend) ? null : `${backend} not found`;
}

export function gitHttpBackendPath() {
  const execPath = spawnSync(GIT, ["--exec-path"], { encoding: "utf8" }).stdout.trim();
  return path.join(execPath, "git-http-backend");
}

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs git without the person's configuration and without any prompt. `env` adds variables, e.g.
 * the password a test credential helper prints.
 */
export function runGit(
  args: string[],
  { cwd, home, env = {} }: { cwd: string; home: string; env?: Record<string, string> },
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(GIT, args, {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export interface UpstreamRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  bodyBytes: number;
}

/**
 * Upstream Git host: serves every bare repository below `root` through `git http-backend`, only
 * for requests carrying `authorization`. Records each request so tests can prove what reached it.
 */
export function startGitHttpBackend({
  root,
  authorization,
}: {
  root: string;
  authorization: string;
}) {
  const requests: UpstreamRequest[] = [];
  const backend = gitHttpBackendPath();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) chunks.push(chunk as Buffer);
    } catch {
      requests.push({ method: req.method!, url: req.url!, headers: req.headers, bodyBytes: -1 });
      return;
    }
    const body = Buffer.concat(chunks);
    requests.push({
      method: req.method!,
      url: req.url!,
      headers: req.headers,
      bodyBytes: body.length,
    });
    if (req.headers.authorization !== authorization) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="upstream"' }).end();
      return;
    }
    const url = new URL(req.url!, "http://upstream");
    const child = spawn(backend, [], {
      env: {
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: root,
        PATH_INFO: decodeURIComponent(url.pathname),
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
      const headerText = all.subarray(0, split).toString("latin1");
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of headerText.split("\r\n")) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === "status") status = Number.parseInt(value, 10);
        else if (name) headers[name] = value;
      }
      res.writeHead(status, headers).end(all.subarray(split + 4));
    });
  });
  return { server, requests };
}
