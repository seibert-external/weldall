import { describe, expect, it, vi } from "vitest";
import { WELDALL_GIT_CREDENTIAL_PREFIX } from "../src/hosts/git-host.js";
import { errorForLog, jsonLogger } from "../src/log.js";
import {
  REDACTION_PLACEHOLDER as R,
  redactCredentials,
  redactCredentialsDeep,
} from "../src/redaction.js";

// Fake credentials are assembled at run time so no file holds a string that looks like a real one.
const fill = (length: number, alphabet = "aZ09_") =>
  Array.from({ length }, (_, index) => alphabet[index % alphabet.length]).join("");
const githubPrefixes = [
  "gh" + "p_",
  "gh" + "o_",
  "gh" + "u_",
  "gh" + "s_",
  "gh" + "r_",
  "github" + "_pat_",
];
const tokenLengths = [8, 36, 82, 300, 1_000];
const githubTokens = githubPrefixes.flatMap((prefix) =>
  tokenLengths.map((length) => ({ name: `${prefix}… (${length})`, token: prefix + fill(length) })),
);
const gitCredential = WELDALL_GIT_CREDENTIAL_PREFIX + fill(43, "Ab3-_");
const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iss: "123", exp: 1 })}.${fill(342, "xY7-_")}`;
const unsignedJwt = `${b64url({ alg: "none" })}.${b64url({ sub: "a" })}.`;
const pemBody = Array.from({ length: 6 }, () => fill(64, "MIIEvQIBADANBgkq+/=")).join("\n");
const pem = (label: string) => `-----BEGIN ${label}-----\n${pemBody}\n-----END ${label}-----`;
const basic = (user: string, secret: string) => Buffer.from(`${user}:${secret}`).toString("base64");
const installationToken = "gh" + "s_" + fill(40);
/** Shaped like a Forgejo access token: 40 hex digits, indistinguishable from a SHA-1. */
const forgejoToken = fill(40, "0123456789abcdef");

describe("credential redaction", () => {
  const positions = [
    { name: "alone", wrap: (secret: string) => secret, expected: R },
    {
      name: "in a sentence",
      wrap: (s: string) => `token ${s} was used.`,
      expected: `token ${R} was used.`,
    },
    {
      name: "at the start of a line",
      wrap: (s: string) => `line one\n${s}\nline three`,
      expected: `line one\n${R}\nline three`,
    },
    {
      name: "in JSON",
      wrap: (s: string) => JSON.stringify({ value: s, n: 1 }),
      expected: `{"value":"${R}","n":1}`,
    },
    {
      name: "in a query string",
      wrap: (s: string) => `https://host/x?access_token=${s}&b=1`,
      expected: `https://host/x?access_token=${R}&b=1`,
    },
    {
      name: "after a colon",
      wrap: (s: string) => `GITHUB_TOKEN:${s}`,
      expected: `GITHUB_TOKEN:${R}`,
    },
  ];

  it.each(
    [
      ...githubTokens,
      { name: "Weldall git credential", token: gitCredential },
      { name: "JWT", token: jwt },
      { name: "unsigned JWT", token: unsignedJwt },
    ].flatMap(({ name, token }) =>
      positions.map((position) => ({ ...position, name: `${name} ${position.name}`, token })),
    ),
  )("redacts $name", ({ token, wrap, expected }) => {
    expect(redactCredentials(wrap(token))).toBe(expected);
  });

  it.each([
    ["PKCS#8", pem("PRIVATE KEY")],
    ["PKCS#1", pem("RSA PRIVATE KEY")],
    ["EC", pem("EC PRIVATE KEY")],
    ["encrypted", pem("ENCRYPTED PRIVATE KEY")],
  ])("redacts a multi-line %s PEM block", (_, block) => {
    expect(redactCredentials(`key:\n${block}\nafter`)).toBe(`key:\n${R}\nafter`);
    expect(redactCredentials(JSON.stringify({ privateKey: block }))).toBe(`{"privateKey":"${R}"}`);
  });

  it("redacts a PEM block that was cut off before its END line", () => {
    const cut = pem("PRIVATE KEY").slice(0, 200);
    expect(redactCredentials(`prefix ${cut}`)).toBe(`prefix ${R}`);
  });

  it.each([
    [
      "Authorization header",
      `Authorization: Basic ${basic("x-access-token", installationToken)}`,
      `Authorization: ${R}`,
    ],
    ["lower-case header", `authorization: bearer ${fill(12)}`, `authorization: ${R}`],
    [
      "header in JSON",
      JSON.stringify({ Authorization: `Bearer ${fill(20)}` }),
      `{"Authorization":"${R}"}`,
    ],
    [
      "git extraheader",
      `git -c http.extraheader="Authorization: Basic ${basic("u", "p")}" push`,
      `git -c http.extraheader="Authorization: ${R}" push`,
    ],
    [
      "Proxy-Authorization",
      `Proxy-Authorization: Basic ${basic("u", "secret")}`,
      `Proxy-Authorization: ${R}`,
    ],
    [
      "bare Basic credential",
      `sent Basic ${basic("x-access-token", installationToken)} upstream`,
      `sent Basic ${R} upstream`,
    ],
    ["bare Bearer token", `Bearer ${fill(64)}`, `Bearer ${R}`],
    [
      "decoded installation credential",
      `x-access-token:${installationToken}`,
      `x-access-token:${R}`,
    ],
    ["decoded opaque credential", `x-access-token:${fill(24)}`, `x-access-token:${R}`],
    [
      "token in a git URL",
      `https://x-access-token:${installationToken}@github.com/acme/app.git`,
      `https://${R}@github.com/acme/app.git`,
    ],
    [
      "opaque token in a git URL",
      `https://x-access-token:${fill(30)}@github.com/acme/app.git`,
      `https://${R}@github.com/acme/app.git`,
    ],
    [
      "token as URL user",
      `https://${gitCredential}@weldall.example.com/git/app`,
      `https://${R}@weldall.example.com/git/app`,
    ],
    ["decoded Forgejo proxy credential", `weldall:${forgejoToken}`, `weldall:${R}`],
    [
      "Forgejo token scheme after an Authorization label",
      `the request carried Authorization header token ${forgejoToken} and failed`,
      `the request carried Authorization header token ${R} and failed`,
    ],
    ["Forgejo Authorization header", `authorization: token ${forgejoToken}`, `authorization: ${R}`],
    ["Forgejo Basic credential", `Basic ${basic("weldall", forgejoToken)}`, `Basic ${R}`],
    [
      "URL in JSON",
      JSON.stringify({ remote: `https://u:${fill(10)}@h/r.git` }),
      `{"remote":"https://${R}@h/r.git"}`,
    ],
  ])("redacts a %s", (_, input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
  });

  const sha1 = "3f786850e387550fdab836ed7e6dc881de23001b";
  const sha256 = "a".repeat(32) + "0123456789abcdef".repeat(2);
  it.each([
    ["a SHA-1 commit id", sha1],
    ["a SHA-256 commit id", sha256],
    ["a ref update line", `${"0".repeat(40)} ${sha1} refs/heads/publish/expense-tracker`],
    ["branch refs", "refs/heads/main refs/heads/feature/ghs-thing refs/heads/github-pat-docs"],
    ["a prefix without a token", "tokens start with gh" + "s_ or github" + "_pat_"],
    ["a short prefixed word", "gh" + "p_abc"],
    ["an underscore-joined identifier", "my_gh" + "s_" + fill(20)],
    ["base64-looking words", "SGVsbG8gV29ybGQ dGVzdA== YWJjZGVmZ2hpams"],
    ["Basic followed by a word", "Basic authentication failed for the Basic dGVzdA== plan"],
    ["Bearer in prose", "Bearer tokens are rejected"],
    ["DPoP in a scope description", "Requires DPoP proof-of-possession for every call"],
    ["a hyphenated word after Bearer", "Bearer authentication-required"],
    ["an identifier after DPoP", "DPoP token_endpoint_auth_method"],
    ["a capitalised compound after Bearer", "Bearer Token-Exchange.Endpoint-Settings"],
    ["an e-mail address", "person@example.com"],
    ["a URL without credentials", "https://github.com/acme/app.git"],
    ["a reason", "Push to the default branch main is not allowed."],
    ["a commit id after a token label", `token ${sha1} was pushed`],
    ["a commit id after an Authorization error", `Authorization failed; commit ${sha1}`],
    [
      "a commit id after an Authorization label on an earlier line",
      `Authorization checked.\ntoken ${sha1}`,
    ],
    ["a longer hex id after weldall:", `weldall:${sha256}`],
    ["a ref update by the weldall user", `weldall pushed ${"0".repeat(40)} ${sha1}`],
  ])("leaves %s alone", (_, text) => {
    expect(redactCredentials(text)).toBe(text);
  });

  it.each([
    ["mixed-case letters", "Bearer " + "abcDEFghiJKLmnoPQR"],
    ["letters with a digit", "DPoP " + "proof-of-possession1"],
  ])("still redacts a Bearer/DPoP token of %s", (_, text) => {
    expect(redactCredentials(text)).toMatch(/^(?:Bearer|DPoP) \[\*\*\*\]$/);
  });

  // Quadratic patterns would take seconds here (64 KB of spaces took 6.9 s before bounding).
  it.each([
    ["spaces", " ".repeat(1 << 20)],
    ["newlines", "\n".repeat(1 << 20)],
    ["mixed whitespace", " \t\r\n".repeat(1 << 18)],
    ["Bearer before spaces", "Bearer" + " ".repeat(1 << 20)],
    ["Basic before newlines", "Basic" + "\n".repeat(1 << 20)],
    ["repeated JWT starts", "eyJ-".repeat(1 << 18)],
    ["repeated GitHub prefixes", ("gh" + "p_").repeat(1 << 18)],
    ["a URL without userinfo end", "https://" + "a".repeat(1 << 20)],
    ["repeated authorization labels", "authorization: ".repeat(1 << 16)],
    ["a PEM header without END", "-----BEGIN PRIVATE KEY-----".repeat(1 << 15)],
  ])("redacts 1 MB of %s in linear time", (_, text) => {
    const started = performance.now();
    redactCredentials(text);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("redacts every string inside nested data and keeps the shape", () => {
    expect(
      redactCredentialsDeep({
        reason: `GitHub said ${installationToken}`,
        list: [jwt, "plain", 3],
        nested: { ok: true, value: null },
      }),
    ).toEqual({
      reason: `GitHub said ${R}`,
      list: [R, "plain", 3],
      nested: { ok: true, value: null },
    });
  });

  it("redacts Git host credentials in the Git app's log and logs no error text", () => {
    const lines: string[] = [];
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });
    try {
      jsonLogger("warn", `git proxy credential test ${installationToken}`, {
        detail: `push with ${installationToken} via https://x-access-token:${fill(30)}@github.com/a/b.git`,
        key: `loaded ${pem("RSA PRIVATE KEY")}`,
        credential: `helper returned ${gitCredential}`,
        ...errorForLog(
          new Error(
            `upstream echoed Authorization: Basic ${basic("x-access-token", installationToken)}`,
          ),
        ),
      });
    } finally {
      write.mockRestore();
    }
    const logged = lines.join("");
    for (const secret of [
      installationToken,
      gitCredential,
      "BEGIN RSA PRIVATE KEY",
      basic("x-access-token", installationToken),
      "upstream echoed",
    ])
      expect(logged).not.toContain(secret);
    expect(JSON.parse(logged)).toMatchObject({
      level: "warn",
      detail: `push with ${R} via https://${R}@github.com/a/b.git`,
      credential: `helper returned ${R}`,
      errorName: "Error",
    });
  });
});
