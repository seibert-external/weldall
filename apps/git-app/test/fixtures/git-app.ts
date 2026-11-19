import { generateKeyPairSync, randomBytes } from "node:crypto";
import { vi } from "vitest";
import {
  JWT_DPOP_GRANT,
  LOGIN_SCOPE,
  SKILL_ASSERTION_TYPE,
  createDpopProof,
  generateEs256KeyPair,
  issueIdJag,
  signEs256,
  type DpopKeyPair,
} from "@weldall/sdk";
import { createGitApp, type CreateGitAppOptions } from "../../src/app.js";
import { loadConfig, type GitAppConfig } from "../../src/config.js";
import { openConfiguredHost, type ConfiguredHost } from "../../src/hosts/index.js";
import { createInstallationTokenCache } from "../../src/hosts/github/tokens.js";
import type { Logger } from "../../src/log.js";
import { createFakeWeldall, type FakeWeldall } from "./fake-weldall.js";

export const WELDALL_ISSUER = "https://weldall.example.com";
export const GIT_APP_ORIGIN = "https://git-app.example.com";
export const GIT_APP_RESOURCE = `${GIT_APP_ORIGIN}/api`;
export const DOWNSTREAM_CLIENT_ID = "weldall-cli-at-git-app";
export const PUBLISH_SCOPE = "git-app:publish";
export const ADMIN_SCOPE = "git-app:admin";

/** The GitHub host configuration the GitHub fixtures (`github-api.ts`) answer for. */
export const githubHostConfig = {
  appId: "123456",
  organization: "acme-apps",
  installationId: "987654",
  templates: [{ name: "react", repository: "acme-apps/react-starter" }],
  repositoryNamePrefix: "app-",
  reviewerTeam: "app-reviewers",
  setupMode: "customer-managed",
};

const jwk = (value: object) => JSON.stringify(value);

/** Environment of a test instance; keys are generated per run, nothing is committed. */
export async function testEnvironment(overrides: Record<string, string | undefined> = {}) {
  const signing = await generateEs256KeyPair();
  const machine = await generateEs256KeyPair();
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  }).privateKey;
  return {
    GIT_APP_HOST: "github",
    GIT_APP_HOST_CONFIG: JSON.stringify(githubHostConfig),
    GIT_APP_HOST_SECRET: privateKey,
    GIT_APP_PUBLIC_ORIGIN: GIT_APP_ORIGIN,
    GIT_APP_DOWNSTREAM_CLIENT_ID: DOWNSTREAM_CLIENT_ID,
    GIT_APP_SIGNING_KID: "git-app-1",
    GIT_APP_SIGNING_PRIVATE_JWK: jwk(signing.privateJwk),
    GIT_APP_SIGNING_PUBLIC_JWK: jwk(signing.publicJwk),
    WELDALL_ISSUER,
    WELDALL_MACHINE_CLIENT_ID: "git-app-machine",
    WELDALL_MACHINE_KID: "machine-1",
    WELDALL_MACHINE_PRIVATE_JWK: jwk(machine.privateJwk),
    WELDALL_MACHINE_PUBLIC_JWK: jwk(machine.publicJwk),
    GIT_APP_GIT_CREDENTIAL_KEY: randomBytes(32).toString("base64"),
    ...overrides,
  } as Record<string, string | undefined>;
}

/** People of the fake Weldall, by Weldall user id. */
export const people = {
  alice: [LOGIN_SCOPE, PUBLISH_SCOPE],
  bob: [LOGIN_SCOPE, PUBLISH_SCOPE],
  /** Signed in, but the publish permission was removed after the token was issued. */
  eve: [LOGIN_SCOPE],
  /** Lost the login permission after the token was issued. */
  mallory: [PUBLISH_SCOPE],
  admin: [LOGIN_SCOPE, ADMIN_SCOPE],
};
export type PersonName = keyof typeof people;

/**
 * A Git app instance with a fake Weldall, the real GitHub driver (the global fetch is replaced by
 * a GitHub fixture per test) and access tokens obtained through the instance's own token
 * endpoint, as the CLI would get them.
 */
export async function createTestGitApp(
  options: {
    /** Replaces the GitHub driver (e.g. a fake host in front of `git http-backend`). */
    host?: (config: GitAppConfig) => ConfiguredHost;
    /** People of the fake Weldall; mutate the object to change permissions between calls. */
    people?: Record<string, string[]>;
    gitProxy?: CreateGitAppOptions["gitProxy"];
  } = {},
) {
  const weldallKey = await generateEs256KeyPair();
  const deviceKey = await generateEs256KeyPair();
  const config: GitAppConfig = await loadConfig(await testEnvironment());
  const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const log: Logger = (level, message, fields) =>
    logs.push({ level, message, fields: fields ?? {} });
  const holders = options.people ?? people;
  let weldall: FakeWeldall = createFakeWeldall({ resource: GIT_APP_RESOURCE, people: holders });
  let gitProxy = options.gitProxy;
  let app = build();
  let eventCount = 0;

  function build() {
    return createGitApp({
      config,
      weldall: weldall.api,
      host:
        options.host?.(config) ??
        openConfiguredHost({
          configuration: config.host,
          secret: config.hostSecret,
          tokens: createInstallationTokenCache(),
          timing: { readyTimeoutMs: 300, pollIntervalMs: 5 },
        }),
      log,
      ...(gitProxy ? { gitProxy } : {}),
      eventId: () => `event-${String(++eventCount).padStart(12, "0")}`,
    });
  }

  /** Weldall's discovery documents, for the token exchange; everything else goes to `next`. */
  function withWeldallDiscovery(next: typeof fetch) {
    return async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${WELDALL_ISSUER}/.well-known/oauth-authorization-server`)
        return Response.json({
          issuer: WELDALL_ISSUER,
          jwks_uri: `${WELDALL_ISSUER}/.well-known/jwks.json`,
        });
      if (url === `${WELDALL_ISSUER}/.well-known/jwks.json`)
        return Response.json({
          keys: [{ ...weldallKey.publicJwk, kid: "weldall-1", alg: "ES256", use: "sig" }],
        });
      return next(input, init);
    };
  }

  const tokens = new Map<string, string>();
  /** An access token of the Git app for `person`, with the scopes Weldall would grant at issue time. */
  async function tokenFor(person: string, scopes: string[]) {
    const key = `${person} ${scopes.join(" ")}`;
    const cached = tokens.get(key);
    if (cached) return cached;
    const previous = globalThis.fetch;
    vi.stubGlobal("fetch", withWeldallDiscovery(previous));
    try {
      const assertion = await issueIdJag({
        issuer: WELDALL_ISSUER,
        subject: person,
        email: `${person}@example.com`,
        audience: GIT_APP_ORIGIN,
        clientId: DOWNSTREAM_CLIENT_ID,
        resource: GIT_APP_RESOURCE,
        scopes,
        jkt: deviceKey.jkt,
        kid: "weldall-1",
        privateJwk: weldallKey.privateJwk,
      });
      const endpoint = `${GIT_APP_ORIGIN}/oauth/token`;
      const response = await app.request(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          dpop: await createDpopProof({ ...deviceKey, method: "POST", url: endpoint }),
        },
        body: new URLSearchParams({ grant_type: JWT_DPOP_GRANT, assertion }),
      });
      const body = (await response.json()) as { access_token?: string };
      if (!response.ok || !body.access_token)
        throw new Error(`token exchange failed: ${JSON.stringify(body)}`);
      tokens.set(key, body.access_token);
      return body.access_token;
    } finally {
      vi.stubGlobal("fetch", previous);
    }
  }

  /** Calls the Git app as `person` with a fresh DPoP proof. */
  async function call(
    person: PersonName | (string & {}),
    method: "GET" | "POST",
    path: string,
    { body, scopes = defaultScopes(person) }: { body?: unknown; scopes?: string[] } = {},
  ) {
    const token = await tokenFor(person, scopes);
    const url = `${GIT_APP_ORIGIN}${path}`;
    const proof = await createDpopProof({
      ...(deviceKey as DpopKeyPair),
      method,
      url: url.split("?")[0]!,
      accessToken: token,
    });
    const response = await app.request(url, {
      method,
      headers: {
        authorization: `DPoP ${token}`,
        dpop: proof,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: (await response.json()) as any };
  }

  return {
    config,
    logs,
    call,
    get weldall() {
      return weldall;
    },
    /** A fresh fake Weldall and instance, keeping keys and issued tokens. */
    reset(next: { gitProxy?: CreateGitAppOptions["gitProxy"] } = {}) {
      weldall = createFakeWeldall({ resource: GIT_APP_RESOURCE, people: holders });
      gitProxy = next.gitProxy ?? options.gitProxy;
      app = build();
      logs.length = 0;
    },
    request: (input: string, init?: RequestInit) => app.request(input, init),
    /** Fetches the skill catalog as Weldall's skill discovery does, with a signed assertion. */
    async skillCatalog(claims: Record<string, unknown> = {}) {
      const endpoint = `${GIT_APP_ORIGIN}/.well-known/weldall-skills`;
      const now = Math.floor(Date.now() / 1_000);
      const assertion = await signEs256(
        {
          iss: WELDALL_ISSUER,
          sub: WELDALL_ISSUER,
          aud: endpoint,
          resource: GIT_APP_RESOURCE,
          purpose: "skills:read",
          iat: now,
          exp: now + 60,
          jti: `skills-${randomBytes(8).toString("hex")}`,
          ...claims,
        },
        { kid: "weldall-1", privateJwk: weldallKey.privateJwk, typ: SKILL_ASSERTION_TYPE },
      );
      const previous = globalThis.fetch;
      vi.stubGlobal("fetch", withWeldallDiscovery(previous));
      try {
        return await app.request(endpoint, { headers: { authorization: `Bearer ${assertion}` } });
      } finally {
        vi.stubGlobal("fetch", previous);
      }
    },
    /** The current instance's fetch handler, for serving it over real HTTP. */
    fetch: (request: Request) => app.fetch(request),
  };
}

/** The scopes Weldall issued in the person's token: what they held when they signed in. */
function defaultScopes(person: string) {
  return person === "admin" ? [ADMIN_SCOPE] : [PUBLISH_SCOPE];
}
