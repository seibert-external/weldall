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
import { RegistryAccessError, type RegistryAnswer } from "../src/git/registries.js";
import { shouldRunUpdateCheck } from "../src/update-check.js";

const ISSUER = "https://weldall.example.com";
const ORIGIN = "https://registry.example.com";
const PATH = "git/acme/shop.git";
const PASSWORD = `wgc_${"a".repeat(25)}.${"b".repeat(43)}`;
const EXPIRES = "2026-11-17T12:05:00.000Z";

const request = (lines: string[]) => `${lines.join("\n")}\n\n`;
/** An answer as the access returns it; `retryAfter` is null unless the test sets it. */
type Answer = Omit<RegistryAnswer, "retryAfter"> & { retryAfter?: number | null };
const full = (answer: Answer): RegistryAnswer => ({ retryAfter: null, ...answer });
const getRequest = request(["protocol=https", "host=registry.example.com", `path=${PATH}`]);

function weldall(
  answer: Answer | Answer[] | (() => Promise<Answer>),
  issuer: string | null = ISSUER,
) {
  const requests: GitCredentialRequest[] = [];
  const queue = Array.isArray(answer) ? [...answer] : null;
  const access: GitCredentialAccess = {
    issuer: vi.fn(async () => issuer),
    requestCredential: vi.fn(async (input: GitCredentialRequest) => {
      requests.push(input);
      return full(
        typeof answer === "function" ? await answer() : queue ? queue.shift()! : (answer as Answer),
      );
    }),
  };
  return { access, requests };
}

async function helper({
  operation = "get",
  input = getRequest,
  access,
  environment = {},
  sleep = async () => {},
}: {
  operation?: string;
  input?: string;
  access: GitCredentialAccess;
  environment?: NodeJS.ProcessEnv;
  sleep?: (milliseconds: number) => Promise<unknown>;
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
    sleep,
  });
  return { stdout, stderr };
}

const issued: Answer = {
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

  it("accepts only registry repository paths, without a connector segment", () => {
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
    expect(originOfGitHost("registry.example.com")).toBe(ORIGIN);
    expect(originOfGitHost("REGISTRY.example.com:443")).toBe(ORIGIN);
    expect(originOfGitHost("127.0.0.1:8443")).toBe("https://127.0.0.1:8443");
    expect(originOfGitHost("registry.example.com:8443")).toBe("https://registry.example.com:8443");
    expect(originOfGitHost("evil.example@registry.example.com")).toBeNull();
    expect(originOfGitHost("registry.example.com/x")).toBeNull();
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
      request(["protocol=https", "host=registry.example.com", "path=api/git-credentials"]),
    ],
    [
      "a path with a connector segment",
      request(["protocol=https", "host=registry.example.com", "path=git/github/acme/shop.git"]),
    ],
    ["plain http", request(["protocol=http", "host=registry.example.com", `path=${PATH}`])],
    ["no protocol", request(["host=registry.example.com", `path=${PATH}`])],
    [
      "a host with user info",
      request(["protocol=https", "host=a@registry.example.com", `path=${PATH}`]),
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
      input: request(["protocol=https", "host=registry.example.com"]),
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
      "the registry refused the request (Not allowed.)",
    ],
    [
      { status: 403, body: { error: "scope_not_held", error_description: "Missing publish." } },
      "you do not hold a permission this needs",
    ],
    [
      { status: 404, body: { error: "not_found", error_description: "No app of yours." } },
      "No app of yours uses this repository",
    ],
    [{ status: 404, body: "<!DOCTYPE html><title>404</title>" }, "does not issue git credentials"],
    [{ status: 404, body: null }, "not a registry that publishes apps, or an older one"],
    [
      { status: 409, body: { error: "repository_not_ready", error_description: "Retry." } },
      "still preparing the app's repository (Retry.)",
    ],
    [
      { status: 409, body: { error: "invalid_target", error_description: "Other organisation." } },
      "not in the organisation the registry publishes to (Other organisation.)",
    ],
    [
      { status: 409, body: { error: "app_removed" } },
      "archived, disabled or out of the registry's reach",
    ],
    [
      { status: 409, body: { error: "not_publishable" } },
      "no repository that changes can be published to",
    ],
    [{ status: 409, body: { error: "repository_moved" } }, "renamed or replaced"],
    [
      { status: 409, body: { error: "publishing_not_configured" } },
      "does not create apps or publish changes yet",
    ],
    [{ status: 429, body: { error: "rate_limit" } }, "too many requests in a short time"],
    [
      { status: 429, body: { error: "rate_limit" }, retryAfter: 45 },
      "Wait about 45 seconds, then try again",
    ],
    [
      { status: 503, body: { error: "git_host_rate_limited" }, retryAfter: 600 },
      "Wait about 10 minutes",
    ],
    [{ status: 400, body: { error: "invalid_request" } }, "did not accept the request"],
    [
      { status: 503, body: { error: "audit_unavailable", error_description: "Audit down." } },
      "audit log is unavailable",
    ],
    [{ status: 503, body: { error: "weldall_unavailable" } }, "could not reach Weldall"],
    [{ status: 503, body: { error: "something_new" } }, "HTTP 503"],
    [
      { status: 200, body: { username: "weldall", password: "ghs_notours" } },
      "invalid git credential",
    ],
    [{ status: 200, body: { username: "weldall", password: `${PASSWORD}\nquit=0` } }, "invalid"],
    [{ status: 200, body: "not json" }, "invalid git credential"],
  ] satisfies Array<[Answer, string]>)(
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

  it("replaces control and non-ASCII characters in server text", async () => {
    const { access } = weldall({
      status: 409,
      body: { error: "repository_not_ready", error_description: "a\u001b[31mred\nline\u202e" },
    });
    expect((await helper({ access })).stderr).toBe(
      "weldall git-credential: Getting a git credential: your organisation's Git is still preparing the app's repository (a?[31mred?line?). Run the same command again; it continues where it stopped.\n",
    );
  });

  it("accepts a credential near the registry's maximum length and refuses longer ones", () => {
    const long = `wgc_${"k".repeat(8)}.${"p".repeat(2_000)}.${"m".repeat(43)}`;
    expect(long.length).toBeLessThan(4_096);
    expect(describeRejection(full({ status: 418, body: null }), ORIGIN)).toContain("HTTP 418");
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
    [new RegistryAccessError("login", "You are not logged in"), "weldall login"],
    [new RegistryAccessError("network", "fetch failed: ECONNREFUSED"), "Could not reach"],
    [new RegistryAccessError("configuration", "bad cache"), "configuration is not usable"],
    [
      new RegistryAccessError(
        "not_registered",
        "https://evil.example is not a registry Weldall lists for you that publishes apps.",
      ),
      "not a registry Weldall lists for you",
    ],
    [
      new RegistryAccessError("refused", "You lack the permission registry:publish"),
      "registry:publish",
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

describe("rate limits", () => {
  it("waits a short Retry-After once and then answers git", async () => {
    const waits: number[] = [];
    const { access, requests } = weldall([
      { status: 429, body: { error: "rate_limit" }, retryAfter: 3 },
      issued,
    ]);
    const result = await helper({ access, sleep: async (ms) => waits.push(ms) });
    expect(result.stdout).toContain(`password=${PASSWORD}`);
    expect(result.stderr).toBe("");
    expect(waits).toEqual([3_000]);
    expect(requests).toHaveLength(2);
  });

  it("waits while the Git host is busy (503 with Retry-After), but only once", async () => {
    const waits: number[] = [];
    const busy = { status: 503, body: { error: "git_host_rate_limited" }, retryAfter: 2 };
    const { access, requests } = weldall([busy, busy, issued]);
    const result = await helper({ access, sleep: async (ms) => waits.push(ms) });
    expect(result.stdout).toBe("quit=1\n");
    expect(result.stderr).toContain("busy for the moment");
    expect(result.stderr).toContain("Wait about 2 seconds");
    expect(waits).toEqual([2_000]);
    expect(requests).toHaveLength(2);
  });

  it("does not make git wait for a long Retry-After or a 503 without one", async () => {
    for (const answer of [
      { status: 429, body: { error: "rate_limit" }, retryAfter: 60 },
      { status: 503, body: { error: "upstream_unavailable" } },
    ]) {
      const waits: number[] = [];
      const { access, requests } = weldall([answer, issued]);
      const result = await helper({ access, sleep: async (ms) => waits.push(ms) });
      expect(result.stdout).toBe("quit=1\n");
      expect(waits).toEqual([]);
      expect(requests).toHaveLength(1);
    }
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
          "host=registry.example.com",
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
