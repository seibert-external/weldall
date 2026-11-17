import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  GitCredentialFailure,
  isGitProxyPath,
  isIssuerHost,
  parseCredentialAttributes,
  readCredentialInput,
  runGitCredentialHelper,
  type GitCredentialRequest,
  type WeldallAnswer,
  type WeldallGitCredentialAccess,
} from "../src/git/credential-helper.js";
import { directWeldallAccess } from "../src/git/weldall-access.js";
import { CliError, ConfigurationError } from "../src/errors.js";
import type { WeldallConfig } from "../src/config.js";
import type { AccessSession } from "../src/services/session-manager.js";
import { generateEs256KeyPair } from "../src/oauth/session.js";
import { shouldRunUpdateCheck } from "../src/update-check.js";

const ISSUER = "https://weldall.example.com";
const PATH = "git/github/acme/shop.git";
const PASSWORD = `wgc_${"a".repeat(25)}.${"b".repeat(43)}`;
const EXPIRES = "2026-11-17T12:05:00.000Z";

const request = (lines: string[]) => `${lines.join("\n")}\n\n`;
const getRequest = request(["protocol=https", "host=weldall.example.com", `path=${PATH}`]);

function weldall(
  answer: WeldallAnswer | (() => Promise<WeldallAnswer>),
  issuer: string | null = ISSUER,
) {
  const requests: GitCredentialRequest[] = [];
  const access: WeldallGitCredentialAccess = {
    issuer: vi.fn(async () => issuer),
    requestCredential: vi.fn(async (input: GitCredentialRequest) => {
      requests.push(input);
      return typeof answer === "function" ? answer() : answer;
    }),
  };
  return { access, requests };
}

async function helper({
  operation = "get",
  input = getRequest,
  access,
  environment = {},
}: {
  operation?: string;
  input?: string;
  access: WeldallGitCredentialAccess;
  environment?: NodeJS.ProcessEnv;
}) {
  let stdout = "";
  let stderr = "";
  await runGitCredentialHelper({
    operation,
    input: Readable.from([Buffer.from(input)]),
    output: { write: (chunk: string) => (stdout += chunk) },
    errors: { write: (chunk: string) => (stderr += chunk) },
    environment,
    weldall: access,
  });
  return { stdout, stderr };
}

const issued: WeldallAnswer = {
  status: 200,
  body: { username: "weldall", password: PASSWORD, expiresAt: EXPIRES },
};

describe("git credential protocol parsing", () => {
  it("reads key=value lines up to the first blank line", async () => {
    const text = await readCredentialInput(
      Readable.from([Buffer.from("protocol=https\nhost=a"), Buffer.from("\n\nignored=1\n")]),
    );
    expect(text).toBe("protocol=https\nhost=a");
    expect(parseCredentialAttributes(text)).toEqual(
      new Map([
        ["protocol", "https"],
        ["host", "a"],
      ]),
    );
  });

  it("reads to the end when git closes stdin without a blank line", async () => {
    expect(await readCredentialInput(Readable.from([Buffer.from("protocol=https\n")]))).toBe(
      "protocol=https\n",
    );
  });

  it("keeps values containing '=' and the last of repeated keys", () => {
    expect(parseCredentialAttributes("path=a=b\nhost=x\nhost=y\nnoise\n=empty")).toEqual(
      new Map([
        ["path", "a=b"],
        ["host", "y"],
      ]),
    );
  });

  it("accepts only git proxy repository paths", () => {
    expect(isGitProxyPath(PATH)).toBe(true);
    expect(isGitProxyPath(`/${PATH}`)).toBe(true);
    for (const path of [
      "git/github/acme/shop",
      "git/github/acme/shop.git/info/refs",
      "git/github/acme",
      "api/github/acme/shop.git",
      "git/github/../shop.git",
      "git/github/acme/%2e%2e.git",
      "git/-x/acme/shop.git",
    ])
      expect(isGitProxyPath(path), path).toBe(false);
  });

  it("matches git's host with the issuer's host and port", () => {
    expect(isIssuerHost("weldall.example.com", ISSUER)).toBe(true);
    expect(isIssuerHost("WELDALL.example.com:443", ISSUER)).toBe(true);
    expect(isIssuerHost("127.0.0.1:8443", "https://127.0.0.1:8443")).toBe(true);
    expect(isIssuerHost("weldall.example.com:8443", ISSUER)).toBe(false);
    expect(isIssuerHost("evil.example@weldall.example.com", ISSUER)).toBe(false);
    expect(isIssuerHost("weldall.example.com.evil.test", ISSUER)).toBe(false);
    expect(isIssuerHost("", ISSUER)).toBe(false);
  });
});

describe("weldall git-credential get", () => {
  it("prints exactly the credential lines git expects and nothing on stderr", async () => {
    const { access, requests } = weldall(issued);
    const { stdout, stderr } = await helper({ access });
    expect(stdout).toBe(
      `username=weldall\npassword=${PASSWORD}\npassword_expiry_utc=${Date.parse(EXPIRES) / 1000}\n`,
    );
    expect(stderr).toBe("");
    expect(requests).toEqual([{ path: PATH, access: "read" }]);
  });

  it("omits the expiry when Weldall sends none it can read", async () => {
    const { access } = weldall({ status: 200, body: { username: "weldall", password: PASSWORD } });
    expect((await helper({ access })).stdout).toBe(`username=weldall\npassword=${PASSWORD}\n`);
  });

  it("requests write access only when the environment asks for it", async () => {
    const { access, requests } = weldall(issued);
    await helper({ access, environment: { WELDALL_GIT_ACCESS: "write" } });
    await helper({ access, environment: { WELDALL_GIT_ACCESS: "" } });
    expect(requests.map((item) => item.access)).toEqual(["write", "read"]);
  });

  it("stops git on an unknown access value", async () => {
    const { access } = weldall(issued);
    const result = await helper({ access, environment: { WELDALL_GIT_ACCESS: "admin" } });
    expect(result.stdout).toBe("quit=1\n");
    expect(result.stderr).toContain("WELDALL_GIT_ACCESS");
    expect(access.requestCredential).not.toHaveBeenCalled();
  });

  it.each([
    ["a foreign host", request(["protocol=https", "host=github.com", `path=${PATH}`])],
    ["another port", request(["protocol=https", "host=weldall.example.com:8443", `path=${PATH}`])],
    ["plain http", request(["protocol=http", "host=weldall.example.com", `path=${PATH}`])],
    ["no protocol", request(["host=weldall.example.com", `path=${PATH}`])],
  ])("stays silent for %s so git asks its other helpers", async (_case, input) => {
    const { access } = weldall(issued);
    expect(await helper({ access, input })).toEqual({ stdout: "", stderr: "" });
    expect(access.requestCredential).not.toHaveBeenCalled();
  });

  it.each([
    ["no path", request(["protocol=https", "host=weldall.example.com"]), "useHttpPath"],
    [
      "a non-proxy path",
      request(["protocol=https", "host=weldall.example.com", "path=api/me/cli"]),
      "not a Weldall git repository",
    ],
  ])("prints nothing on stdout for %s on the Weldall host", async (_case, input, hint) => {
    const { access } = weldall(issued);
    const result = await helper({ access, input });
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(hint);
    expect(access.requestCredential).not.toHaveBeenCalled();
  });

  it("gives nothing and explains when no Weldall server is configured", async () => {
    const { access } = weldall(issued, null);
    const result = await helper({ access });
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("WELDALL_ISSUER");
  });

  it.each([
    [{ status: 401, body: { error: "invalid_token" } }, "weldall login"],
    [
      { status: 403, body: { error: "connection_denied", error_description: "Not allowed." } },
      "denies you git access to this repository (Not allowed.)",
    ],
    [
      { status: 404, body: { error: "not_found", error_description: "No app of yours." } },
      "No app of yours uses this repository",
    ],
    [
      { status: 404, body: "<!DOCTYPE html><title>404</title>" },
      "does not issue git credentials yet",
    ],
    [{ status: 404, body: null }, "update the server"],
    [
      { status: 409, body: { error: "repository_not_ready", error_description: "Retry." } },
      "repository is not ready yet (Retry.)",
    ],
    [{ status: 409, body: { error: "disabled" } }, "connector is disabled"],
    [{ status: 429, body: { error: "rate_limit" } }, "Wait a minute"],
    [{ status: 400, body: { error: "invalid_request" } }, "rejected the request"],
    [{ status: 503, body: { error: "connector_unavailable" } }, "HTTP 503"],
    [
      { status: 200, body: { username: "weldall", password: "ghs_notours" } },
      "invalid git credential",
    ],
    [{ status: 200, body: { username: "weldall", password: `${PASSWORD}\nquit=0` } }, "invalid"],
    [{ status: 200, body: "not json" }, "invalid git credential"],
  ] satisfies Array<[WeldallAnswer, string]>)(
    "stops git with quit=1 on HTTP %#",
    async (answer, message) => {
      const { access } = weldall(answer);
      const result = await helper({ access });
      expect(result.stdout).toBe("quit=1\n");
      expect(result.stderr).toContain(message);
      expect(result.stderr).toMatch(/^weldall git-credential: .+\n$/);
      expect(result.stderr).not.toContain("wgc_");
      expect(result.stderr).not.toContain("ghs_");
    },
  );

  it("strips control characters from server text", async () => {
    const { access } = weldall({
      status: 409,
      body: { error: "disabled", error_description: "a\u001b[31mred\nline" },
    });
    expect((await helper({ access })).stderr).toBe(
      "weldall git-credential: The Git host connector is disabled in Weldall (a [31mred line)\n",
    );
  });

  it.each([
    [new GitCredentialFailure("login", "You are not logged in"), "weldall login"],
    [new GitCredentialFailure("network", "fetch failed: ECONNREFUSED"), "Could not reach"],
    [new GitCredentialFailure("configuration", "bad cache"), "configuration is not usable"],
    [new Error("boom"), "failed: boom"],
  ])("stops git with quit=1 when Weldall cannot be asked (%s)", async (failure, message) => {
    const { access } = weldall(async () => {
      throw failure;
    });
    const result = await helper({ access });
    expect(result.stdout).toBe("quit=1\n");
    expect(result.stderr).toContain(message);
  });
});

describe("weldall git-credential store and erase", () => {
  it.each(["store", "erase", "future-operation"])(
    "consumes %s input and does nothing",
    async (operation) => {
      const { access } = weldall(issued);
      const result = await helper({
        operation,
        access,
        input: request([
          "protocol=https",
          "host=weldall.example.com",
          `path=${PATH}`,
          "username=weldall",
          `password=${PASSWORD}`,
        ]),
      });
      expect(result).toEqual({ stdout: "", stderr: "" });
      expect(access.issuer).not.toHaveBeenCalled();
      expect(access.requestCredential).not.toHaveBeenCalled();
    },
  );
});

describe("direct Weldall access", () => {
  const config = { issuer: ISSUER } as WeldallConfig;
  const session = async (): Promise<AccessSession> => {
    const key = await generateEs256KeyPair();
    return {
      accessToken: "access-token",
      subject: "user-1",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      credentials: { version: 2, issuer: ISSUER, ...key, refreshToken: "refresh" },
    };
  };

  it("posts the path and access with a DPoP-bound login", async () => {
    const fetcher = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(issued.body), { status: 200 }),
    );
    const access = directWeldallAccess({
      selectIssuer: async () => ISSUER,
      resolveConfig: async () => config,
      getSession: session,
      fetch: fetcher as unknown as typeof fetch,
    });
    await expect(access.requestCredential({ path: PATH, access: "write" })).resolves.toEqual(
      issued,
    );
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${ISSUER}/api/me/git-credentials`);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ path: PATH, access: "write" });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("DPoP access-token");
    expect(headers.get("dpop")).toMatch(/^ey/);
  });

  it("passes failed answers through for the protocol code to explain", async () => {
    const access = directWeldallAccess({
      selectIssuer: async () => ISSUER,
      resolveConfig: async () => config,
      getSession: session,
      fetch: (async () => new Response("<html>", { status: 404 })) as unknown as typeof fetch,
    });
    await expect(access.requestCredential({ path: PATH, access: "read" })).resolves.toEqual({
      status: 404,
      body: "<html>",
    });
  });

  it.each([
    [new CliError(`You are not logged in to ${ISSUER}`), "login"],
    [new CliError("invalid_grant: refresh token expired"), "login"],
    [new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }), "network"],
  ])("reports a session failure as %s", async (error, kind) => {
    const access = directWeldallAccess({
      selectIssuer: async () => ISSUER,
      resolveConfig: async () => config,
      getSession: async () => {
        throw error;
      },
      fetch: vi.fn() as unknown as typeof fetch,
    });
    await expect(access.requestCredential({ path: PATH, access: "read" })).rejects.toMatchObject({
      kind,
    });
  });

  it("reports configuration and transport failures", async () => {
    const base = {
      selectIssuer: async () => ISSUER,
      getSession: session,
    };
    await expect(
      directWeldallAccess({
        ...base,
        resolveConfig: async () => {
          throw new ConfigurationError("Weldall discovery failed with HTTP 500");
        },
      }).requestCredential({ path: PATH, access: "read" }),
    ).rejects.toMatchObject({ kind: "configuration" });
    await expect(
      directWeldallAccess({
        ...base,
        resolveConfig: async () => {
          throw new ConfigurationError(`Unable to reach ${ISSUER}`, {
            cause: new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") }),
          });
        },
      }).requestCredential({ path: PATH, access: "read" }),
    ).rejects.toMatchObject({ kind: "network", message: "fetch failed: connect ECONNREFUSED" });
    await expect(
      directWeldallAccess({
        ...base,
        resolveConfig: async () => config,
        fetch: (async () => {
          throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
        }) as unknown as typeof fetch,
      }).requestCredential({ path: PATH, access: "read" }),
    ).rejects.toMatchObject({ kind: "network", message: "fetch failed: getaddrinfo ENOTFOUND" });
  });
});

describe("update notices", () => {
  it("never run for the credential helper", () => {
    expect(shouldRunUpdateCheck(["git-credential", "get"])).toBe(false);
  });
});
