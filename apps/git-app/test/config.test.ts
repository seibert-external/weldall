import { describe, expect, it } from "vitest";
import { GitAppConfigError, loadConfig } from "../src/config.js";
import { BOT_TOKEN, forgejoConfig } from "./fixtures/forgejo-api.js";
import { GIT_APP_ORIGIN, githubHostConfig, testEnvironment } from "./fixtures/git-app.js";

async function problems(env: Record<string, string | undefined>, files = {}) {
  try {
    await loadConfig(env, (path) => {
      const content = (files as Record<string, string>)[path];
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    });
  } catch (error) {
    expect(error).toBeInstanceOf(GitAppConfigError);
    return error as GitAppConfigError;
  }
  throw new Error("expected the configuration to fail");
}

describe("configuration", () => {
  it("loads a GitHub instance with defaults for the resource identifier, scopes and port", async () => {
    const env = await testEnvironment();
    const config = await loadConfig(env);
    expect(config).toMatchObject({
      host: {
        kind: "github",
        config: { organization: "acme-apps", liveEnvironments: ["production"] },
      },
      publicOrigin: GIT_APP_ORIGIN,
      resource: `${GIT_APP_ORIGIN}/api`,
      scopes: { publish: "git-app:publish", admin: "git-app:admin" },
      port: 3002,
      weldall: { issuer: "https://weldall.example.com", machineClientId: "git-app-machine" },
    });
    expect(config.hostSecret).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(config.weldall.machineKey.jkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("reads secrets and the host configuration from files named in the environment", async () => {
    const env = await testEnvironment({
      GIT_APP_HOST: "forgejo",
      GIT_APP_HOST_CONFIG: undefined,
      GIT_APP_HOST_CONFIG_FILE: "/run/config/host.json",
      GIT_APP_HOST_SECRET: undefined,
      GIT_APP_HOST_SECRET_FILE: "/run/secrets/host",
      GIT_APP_PUBLISH_SCOPE: "git-forgejo:publish",
    });
    const config = await loadConfig(env, (path) =>
      path === "/run/config/host.json" ? JSON.stringify(forgejoConfig) : `${BOT_TOKEN}\n`,
    );
    expect(config.host.kind).toBe("forgejo");
    expect(config.hostSecret).toBe(BOT_TOKEN);
    expect(config.scopes.publish).toBe("git-forgejo:publish");
  });

  it("lists every missing variable at once", async () => {
    const error = await problems({});
    for (const name of [
      "GIT_APP_HOST is required.",
      "GIT_APP_HOST_CONFIG or GIT_APP_HOST_CONFIG_FILE is required.",
      "GIT_APP_HOST_SECRET or GIT_APP_HOST_SECRET_FILE is required.",
      "GIT_APP_PUBLIC_ORIGIN is required.",
      "GIT_APP_DOWNSTREAM_CLIENT_ID is required.",
      "GIT_APP_SIGNING_PRIVATE_JWK or GIT_APP_SIGNING_PRIVATE_JWK_FILE is required.",
      "WELDALL_ISSUER is required.",
      "WELDALL_MACHINE_CLIENT_ID is required.",
      "WELDALL_MACHINE_PRIVATE_JWK or WELDALL_MACHINE_PRIVATE_JWK_FILE is required.",
      "GIT_APP_GIT_CREDENTIAL_KEY or GIT_APP_GIT_CREDENTIAL_KEY_FILE is required.",
    ])
      expect(error.problems).toContain(name);
  });

  it("never puts a secret value into the error", async () => {
    const leakedKey = "-----BEGIN RSA PRIVATE KEY-----\nnot-a-key\n-----END RSA PRIVATE KEY-----";
    const env = await testEnvironment({
      GIT_APP_HOST_SECRET: leakedKey,
      WELDALL_MACHINE_PRIVATE_JWK: '{"kty":"EC","d":"very-secret-d"}',
    });
    const error = await problems(env);
    expect(error.problems).toEqual([
      expect.stringMatching(/^GIT_APP_HOST_SECRET: Upload the GitHub App private key/),
      "WELDALL_MACHINE_PRIVATE_JWK and WELDALL_MACHINE_PUBLIC_JWK must be a matching ES256 (P-256) JWK pair.",
    ]);
    expect(error.message).not.toContain("not-a-key");
    expect(error.message).not.toContain("very-secret-d");
  });

  it("refuses a secret given twice and an unreadable secret file", async () => {
    const both = await problems(
      await testEnvironment({ GIT_APP_HOST_SECRET_FILE: "/run/secrets/host" }),
    );
    expect(both.problems).toContain(
      "Set either GIT_APP_HOST_SECRET or GIT_APP_HOST_SECRET_FILE, not both.",
    );
    const unreadable = await problems(
      await testEnvironment({
        GIT_APP_HOST_SECRET: undefined,
        GIT_APP_HOST_SECRET_FILE: "/missing",
      }),
    );
    expect(unreadable.problems).toContain(
      "GIT_APP_HOST_SECRET_FILE names a file that cannot be read.",
    );
  });

  it("names invalid host configuration fields and the reserved setup mode", async () => {
    const invalid = await problems(
      await testEnvironment({
        GIT_APP_HOST_CONFIG: JSON.stringify({ ...githubHostConfig, reviewerTeam: "Reviewers" }),
      }),
    );
    expect(invalid.problems).toEqual([expect.stringContaining("field reviewerTeam")]);
    const reserved = await problems(
      await testEnvironment({
        GIT_APP_HOST_CONFIG: JSON.stringify({ ...githubHostConfig, setupMode: "weldall-managed" }),
      }),
    );
    expect(reserved.problems).toEqual([
      expect.stringContaining('"weldall-managed" is not available'),
    ]);
    const unknown = await problems(await testEnvironment({ GIT_APP_HOST: "gitlab" }));
    expect(unknown.problems).toContain("GIT_APP_HOST must be one of: github, forgejo.");
  });

  it("accepts a previous git credential key for verification, but not the current one again", async () => {
    const env = await testEnvironment();
    const rotated = await loadConfig({
      ...env,
      GIT_APP_GIT_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64url"),
      GIT_APP_GIT_CREDENTIAL_PREVIOUS_KEY: env.GIT_APP_GIT_CREDENTIAL_KEY,
    });
    expect(rotated.gitCredentialKeys).toHaveLength(2);
    expect(rotated.gitCredentialKeys[1]!.toString("base64")).toBe(env.GIT_APP_GIT_CREDENTIAL_KEY);
    const same = await problems({
      ...env,
      GIT_APP_GIT_CREDENTIAL_PREVIOUS_KEY: env.GIT_APP_GIT_CREDENTIAL_KEY,
    });
    expect(same.problems).toEqual([expect.stringContaining("must differ")]);
    expect(same.message).not.toContain(env.GIT_APP_GIT_CREDENTIAL_KEY);
  });

  it.each([
    [
      { GIT_APP_PUBLIC_ORIGIN: "http://git-app.example.com" },
      "GIT_APP_PUBLIC_ORIGIN must use https.",
    ],
    [
      { GIT_APP_PUBLIC_ORIGIN: "https://git-app.example.com/" },
      "GIT_APP_PUBLIC_ORIGIN must be an origin",
    ],
    [{ WELDALL_ISSUER: "https://weldall.example.com/api" }, "WELDALL_ISSUER must be an origin"],
    [
      { GIT_APP_RESOURCE_IDENTIFIER: "https://elsewhere.example.com/api" },
      "GIT_APP_RESOURCE_IDENTIFIER must be a URL on GIT_APP_PUBLIC_ORIGIN",
    ],
    [{ GIT_APP_ADMIN_SCOPE: "Admin" }, "GIT_APP_ADMIN_SCOPE must be a scope key"],
    [{ GIT_APP_ADMIN_SCOPE: "git-app:publish" }, "must differ"],
    [{ PORT: "70000" }, "PORT must be a TCP port number."],
    [
      { GIT_APP_GIT_CREDENTIAL_KEY: "too-short" },
      "GIT_APP_GIT_CREDENTIAL_KEY must be base64 of at least 32 random bytes.",
    ],
    [
      { GIT_APP_GIT_CREDENTIAL_PREVIOUS_KEY: "not base64!" },
      "GIT_APP_GIT_CREDENTIAL_PREVIOUS_KEY must be base64 of at least 32 random bytes.",
    ],
  ])("refuses %j", async (patch, message) => {
    const error = await problems(await testEnvironment(patch));
    expect(error.problems).toEqual([expect.stringContaining(message)]);
  });
});
