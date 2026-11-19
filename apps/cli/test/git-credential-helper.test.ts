import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  describeRejection,
  isGitProxyPath,
  originOfGitHost,
  parseCredentialAttributes,
  readCredentialInput,
  runGitCredentialHelper,
  type GitCredentialAccess,
  type GitCredentialRequest,
} from "../src/git/credential-helper.js";
import { GitAppAccessError, type GitAppAnswer } from "../src/git/git-apps.js";
import { shouldRunUpdateCheck } from "../src/update-check.js";

const ISSUER = "https://weldall.example.com";
const ORIGIN = "https://git-app.example.com";
const PATH = "git/acme/shop.git";
const PASSWORD = `wgc_${"a".repeat(25)}.${"b".repeat(43)}`;
const EXPIRES = "2026-11-17T12:05:00.000Z";

const request = (lines: string[]) => `${lines.join("\n")}\n\n`;
const getRequest = request(["protocol=https", "host=git-app.example.com", `path=${PATH}`]);

function weldall(
  answer: GitAppAnswer | (() => Promise<GitAppAnswer>),
  issuer: string | null = ISSUER,
) {
  const requests: GitCredentialRequest[] = [];
  const access: GitCredentialAccess = {
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
  access: GitCredentialAccess;
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

const issued: GitAppAnswer = {
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

  it("accepts only Git app repository paths, without a connector segment", () => {
    expect(isGitProxyPath(PATH)).toBe(true);
    expect(isGitProxyPath(`/${PATH}`)).toBe(true);
    for (const path of [
      "git/github/acme/shop.git",
      "git/acme/shop",
      "git/acme/shop.git/info/refs",
      "git/acme",
      "api/acme/shop.git",
      "git/../shop.git",
      "git/acme/%2e%2e.git",
      "git/acme/..git",
    ])
      expect(isGitProxyPath(path), path).toBe(false);
  });

  it("turns git's host into an https origin, with the port when not 443", () => {
    expect(originOfGitHost("git-app.example.com")).toBe(ORIGIN);
    expect(originOfGitHost("GIT-APP.example.com:443")).toBe(ORIGIN);
    expect(originOfGitHost("127.0.0.1:8443")).toBe("https://127.0.0.1:8443");
    expect(originOfGitHost("git-app.example.com:8443")).toBe("https://git-app.example.com:8443");
    expect(originOfGitHost("evil.example@git-app.example.com")).toBeNull();
    expect(originOfGitHost("git-app.example.com/x")).toBeNull();
    expect(originOfGitHost("")).toBeNull();
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
    expect(requests).toEqual([{ origin: ORIGIN, path: PATH, access: "read" }]);
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
    [
      "a foreign repository path",
      request(["protocol=https", "host=github.com", "path=acme/shop.git"]),
    ],
    [
      "a path outside /git/",
      request(["protocol=https", "host=git-app.example.com", "path=api/git-credentials"]),
    ],
    [
      "a path with a connector segment",
      request(["protocol=https", "host=git-app.example.com", "path=git/github/acme/shop.git"]),
    ],
    ["plain http", request(["protocol=http", "host=git-app.example.com", `path=${PATH}`])],
    ["no protocol", request(["host=git-app.example.com", `path=${PATH}`])],
    [
      "a host with user info",
      request(["protocol=https", "host=a@git-app.example.com", `path=${PATH}`]),
    ],
  ])("stays silent and offline for %s so git asks its other helpers", async (_case, input) => {
    const { access } = weldall(issued);
    expect(await helper({ access, input })).toEqual({ stdout: "", stderr: "" });
    expect(access.issuer).not.toHaveBeenCalled();
    expect(access.requestCredential).not.toHaveBeenCalled();
  });

  it("explains a missing path and asks nothing", async () => {
    const { access } = weldall(issued);
    const result = await helper({
      access,
      input: request(["protocol=https", "host=git-app.example.com"]),
    });
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("useHttpPath");
    expect(access.requestCredential).not.toHaveBeenCalled();
  });

  it("passes the origin of another host and port on, for the access to check against Weldall", async () => {
    const { access, requests } = weldall(issued);
    await helper({
      access,
      input: request(["protocol=https", "host=other.example.com:8443", `path=${PATH}`]),
    });
    expect(requests).toEqual([
      { origin: "https://other.example.com:8443", path: PATH, access: "read" },
    ]);
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
      { status: 403, body: { error: "access_denied", error_description: "Not allowed." } },
      "denies you git access to this repository (Not allowed.)",
    ],
    [
      { status: 404, body: { error: "not_found", error_description: "No app of yours." } },
      "No app of yours uses this repository",
    ],
    [{ status: 404, body: "<!DOCTYPE html><title>404</title>" }, "does not issue git credentials"],
    [{ status: 404, body: null }, "not a Git app, or an older one"],
    [
      { status: 409, body: { error: "repository_not_ready", error_description: "Retry." } },
      "repository is not ready yet (Retry.)",
    ],
    [
      { status: 409, body: { error: "invalid_target", error_description: "Other organisation." } },
      "not one this Git app keeps (Other organisation.)",
    ],
    [{ status: 429, body: { error: "rate_limit" } }, "Wait a minute"],
    [{ status: 400, body: { error: "invalid_request" } }, "rejected the request"],
    [
      { status: 503, body: { error: "audit_unavailable", error_description: "Audit down." } },
      "audit log is unavailable",
    ],
    [{ status: 503, body: { error: "weldall_unavailable" } }, "HTTP 503"],
    [
      { status: 200, body: { username: "weldall", password: "ghs_notours" } },
      "invalid git credential",
    ],
    [{ status: 200, body: { username: "weldall", password: `${PASSWORD}\nquit=0` } }, "invalid"],
    [{ status: 200, body: "not json" }, "invalid git credential"],
  ] satisfies Array<[GitAppAnswer, string]>)(
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
      body: { error: "repository_not_ready", error_description: "a\u001b[31mred\nline" },
    });
    expect((await helper({ access })).stderr).toBe(
      "weldall git-credential: The app's repository is not ready yet (a [31mred line)\n",
    );
  });

  it("accepts a credential near the Git app's maximum length and refuses longer ones", () => {
    const long = `wgc_${"k".repeat(8)}.${"p".repeat(2_000)}.${"m".repeat(43)}`;
    expect(long.length).toBeLessThan(4_096);
    expect(describeRejection({ status: 418, body: null }, ORIGIN)).toContain("HTTP 418");
    return Promise.all([
      helper({
        access: weldall({ status: 200, body: { username: "weldall", password: long } }).access,
      }).then((result) => expect(result.stdout).toBe(`username=weldall\npassword=${long}\n`)),
      helper({
        access: weldall({
          status: 200,
          body: { username: "weldall", password: `wgc_${"p".repeat(4_100)}` },
        }).access,
      }).then((result) => expect(result.stdout).toBe("quit=1\n")),
    ]);
  });

  it.each([
    [new GitAppAccessError("login", "You are not logged in"), "weldall login"],
    [new GitAppAccessError("network", "fetch failed: ECONNREFUSED"), "Could not reach"],
    [new GitAppAccessError("configuration", "bad cache"), "configuration is not usable"],
    [
      new GitAppAccessError(
        "not_registered",
        "https://evil.example is not a Git app registered in Weldall for you.",
      ),
      "not a Git app registered in Weldall",
    ],
    [
      new GitAppAccessError("refused", "You lack the permission git-app:publish"),
      "git-app:publish",
    ],
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
          "host=git-app.example.com",
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

describe("update notices", () => {
  it("never run for the credential helper", () => {
    expect(shouldRunUpdateCheck(["git-credential", "get"])).toBe(false);
  });
});
