import { afterEach, describe, expect, it, vi } from "vitest";
import { googleProvider } from "../src/server/connectors/providers/google";
import {
  requiredScopes,
  canonicalizeScopes,
} from "../src/server/connectors/providers/google/setup";
import { parseGoogleGrant } from "../src/server/connectors/providers/google/credentials";
import { getConnectorProvider } from "../src/server/connectors/registry";
import {
  assertConnectionOwner,
  buildConnectionMetadata,
} from "../src/server/connectors/core/connections";
import {
  parseCanonicalHttps,
  filterProxyHeaders,
  readBoundedBody,
  dispatchUpstream,
  HEADER_LIMIT,
} from "../src/server/connectors/core/transport";
import { fingerprintConnectorRequest } from "../src/server/connectors/audit";
import { revokeGoogleAuthorization } from "../src/server/connectors/providers/google/oauth";
import { connectorConfig } from "../src/server/connectors/contracts";
import { assertConnectorAccess, canAccessConnector } from "../src/server/connectors/access";
import { scopeKeySchema } from "../src/server/policy/scope-key";
import {
  parseDesiredState,
  importRequestSchema,
  moveRequestSchema,
} from "../src/server/iac/contracts";
import { createPlan } from "../src/server/iac/planner";

const read = "https://www.googleapis.com/auth/gmail.readonly";
const modify = "https://www.googleapis.com/auth/gmail.modify";
const providerConfig = { clientId: "client", allowedScopes: [modify, read], defaultScopes: [read] };
const config = {
  key: "google",
  name: "Google",
  type: "google",
  enabled: false,
  envelopeProvider: "LOCAL_ENV",
  requiredScopes: [],
  provider: providerConfig,
};
const scopes = canonicalizeScopes([...requiredScopes, read]);
const selection = { scopes };
const credentials = {
  accessToken: "private-access",
  refreshToken: "private-refresh",
  expiresAt: Date.now() + 3600000,
  grantedScopes: scopes,
};
const grant = parseGoogleGrant({ scopes });
const context = { config: providerConfig, selection, credentials, previousGrant: grant };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("managed provider boundaries", () => {
  it("canonicalizes exact sets without scope aliases or implication mappings", async () => {
    expect(
      googleProvider.validateSetupInput({
        config: providerConfig,
        value: { scopes: [...scopes].reverse().concat(read) },
      }),
    ).toEqual(selection);
    expect(await googleProvider.ensureGrantCurrent(context)).toEqual(grant);
    for (const next of [
      requiredScopes,
      [...scopes, modify],
      scopes.map((s) => (s === read ? modify : s)),
      scopes.map((s) => (s === "https://www.googleapis.com/auth/userinfo.email" ? "email" : s)),
    ]) {
      await expect(
        googleProvider.ensureGrantCurrent({
          ...context,
          credentials: { ...credentials, grantedScopes: next },
          previousGrant: { scopes: next } as never,
        }),
      ).rejects.toThrow();
    }
    expect(() =>
      googleProvider.validateSetupInput({ config: providerConfig, value: { scopes: [read] } }),
    ).toThrow("required");
    expect(() =>
      googleProvider.parseConfiguration({ ...providerConfig, defaultScopes: ["unknown"] }),
    ).toThrow();
  });
  it.each(["reduced", "expanded", "alias"])(
    "rejects %s scopes on refresh while retaining rotated credentials for cleanup",
    async (mode) => {
      const next =
        mode === "reduced"
          ? requiredScopes
          : mode === "expanded"
            ? [...scopes, modify]
            : scopes.map((scope) =>
                scope === "https://www.googleapis.com/auth/userinfo.email" ? "email" : scope,
              );
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({
          access_token: "new-access",
          refresh_token: "rotated",
          expires_in: 3600,
          token_type: "Bearer",
          scope: next.join(" "),
        }),
      );
      await expect(
        googleProvider.refreshCredentials({ ...context, secrets: { clientSecret: "secret" } }),
      ).rejects.toMatchObject({ code: "grant_mismatch", credentials: { refreshToken: "rotated" } });
    },
  );
  it("preserves an unchanged refresh scope set when OAuth omits the scope field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ access_token: "new-access", expires_in: 3600, token_type: "Bearer" }),
    );
    const result = await googleProvider.refreshCredentials({
      ...context,
      secrets: { clientSecret: "secret" },
    });
    expect(result.grant).toEqual(grant);
    expect(result.credentials.refreshToken).toBe(credentials.refreshToken);
  });
  it("rejects removed fields, secret-bearing configuration and unknown providers", () => {
    expect(connectorConfig.parse(config)).toEqual(config);
    for (const value of [
      { ...config, enabledApis: ["gmail"] },
      { ...config, type: "atlassian" },
      { ...config, requiredScopes: ["INVALID"] },
      { ...config, provider: { ...providerConfig, enabledApis: ["gmail"] } },
      { ...config, provider: { ...providerConfig, clientSecret: "secret" } },
    ])
      expect(connectorConfig.safeParse(value).success).toBe(false);
    for (const type of ["atlassian", "__proto__", "constructor", "Google", ""])
      expect(() => getConnectorProvider(type)).toThrow("Unsupported provider");
  });
  it("requires every configured Weldall scope while leaving empty policies unrestricted", () => {
    const readScope = scopeKeySchema.parse("expenses:read");
    const approveScope = scopeKeySchema.parse("expenses:approve");
    const connector = {
      requiredScopes: [{ scope: { key: readScope } }, { scope: { key: approveScope } }],
    };
    expect(
      canAccessConnector({
        connector: { requiredScopes: [] },
        actor: { scopeKeys: [] },
      }),
    ).toBe(true);
    expect(
      canAccessConnector({
        connector,
        actor: { scopeKeys: [approveScope, readScope] },
      }),
    ).toBe(true);
    expect(
      canAccessConnector({
        connector,
        actor: { scopeKeys: [readScope] },
      }),
    ).toBe(false);
    expect(() => assertConnectorAccess({ connector, actor: { scopeKeys: [readScope] } })).toThrow(
      "not available",
    );
  });
  it("binds consent to OAuth PKCE and excludes incremental grants", async () => {
    const result = await googleProvider.beginAuthorization({
      config: providerConfig,
      selection,
      secrets: { clientSecret: "secret" },
      callbackUrl: "https://weldall.example.com/callback",
    });
    const url = new URL(result.url);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(scopes);
    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
    expect(url.searchParams.get("state")).toBe(result.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(result.url).not.toContain("secret");
  });
  it.each([
    "http://gmail.googleapis.com/a",
    "https://user:pass@gmail.googleapis.com/a",
    "https://gmail.googleapis.com/a#",
    "https://gmail.googleapis.com:8443/a",
    "https://gmail.googleapis.com.evil.example/a",
    "https://evil.example/a",
    "https://127.0.0.1/a",
    "https://gmail.googleapis.com\\@evil.example/a",
    "https://gmail.googleapis.com//evil.example/a",
    "https://gmail.googleapis.com/a/../b",
    "https://gmail.googleapis.com/%2e%2e/b",
    "https://gmail.googleapis.com/%2f%2fevil.example",
    "https://gmail.googleapis.com/%252fattack",
    "https://gmail.googleapis.com/%ZZ",
    "https://gmail.googleapis.com/%C0%AF",
    "https://gmail.googleapis.com/a?x=%0",
    "https://gmail.googleapis.com./a",
    "https://%67mail.googleapis.com/a",
    "https://gmail.googleapis.com/a\n",
    "https://gmail.googleapis.com/" + "a".repeat(8192),
  ])("rejects untrusted or ambiguous URL metadata: %s", (raw) => {
    expect(() =>
      googleProvider.resolveUpstreamUrl({
        ...context,
        requestedUrl: parseCanonicalHttps(raw),
        grant,
      }),
    ).toThrow();
  });
  it("accepts arbitrary paths, versions, methods and query keys on reviewed origins", () => {
    for (const origin of [
      "https://gmail.googleapis.com",
      "https://www.googleapis.com",
      "https://calendar.googleapis.com",
    ]) {
      const requestedUrl = parseCanonicalHttps(
        `${origin}/future/v99/accounts/someone@example.com/arbitrary?newKey=yes&newKey=no&q=hello%20world`,
      );
      const upstreamUrl = googleProvider.resolveUpstreamUrl({ ...context, requestedUrl, grant });
      expect(upstreamUrl.href).toBe(requestedUrl.href);
      const init = googleProvider.buildUpstreamRequest({
        upstreamUrl,
        credentials,
        request: {
          requestedUrl,
          method: "DELETE",
          headers: new Headers({ "x-new-api-header": "yes", "x-goog-api-key": "no" }),
        },
        signal: AbortSignal.timeout(1000),
      });
      expect(init.method).toBe("DELETE");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer private-access");
      expect(new Headers(init.headers).get("x-goog-api-key")).toBeNull();
      expect(new Headers(init.headers).get("x-new-api-header")).toBe("yes");
    }
  });
  it("strips dangerous headers and Connection-nominated headers in both directions", () => {
    const headers = new Headers({
      authorization: "secret",
      host: "evil",
      cookie: "secret",
      "content-length": "10",
      connection: "x-nominated",
      "x-nominated": "private",
      "keep-alive": "yes",
      te: "trailers",
      trailer: "x",
      "transfer-encoding": "chunked",
      upgrade: "websocket",
      "proxy-authorization": "secret",
      forwarded: "for=evil",
      "x-forwarded-host": "evil",
      via: "evil",
      dpop: "proof",
      "x-weldall-upstream-url": "private",
      "x-new-header": "works",
    });
    expect([...filterProxyHeaders({ input: headers })]).toEqual([["x-new-header", "works"]]);
    const response = filterProxyHeaders({
      input: new Headers({
        "set-cookie": "secret",
        connection: "x-private",
        "x-private": "secret",
        "keep-alive": "yes",
        "transfer-encoding": "chunked",
        "content-length": "5",
        "content-encoding": "gzip",
        upgrade: "yes",
        "x-new-header": "works",
      }),
      response: true,
    });
    expect([...response]).toEqual([["x-new-header", "works"]]);
    expect(() =>
      filterProxyHeaders({ input: new Headers({ huge: "x".repeat(HEADER_LIMIT) }) }),
    ).toThrow("limit");
  });
  it("never follows or retries redirects", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
      );
    const upstreamUrl = googleProvider.resolveUpstreamUrl({
      ...context,
      grant,
      requestedUrl: parseCanonicalHttps("https://gmail.googleapis.com/a"),
    });
    await expect(
      dispatchUpstream({
        upstreamUrl,
        init: { method: "POST", redirect: "follow" },
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow("redirects");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it("cancels an in-flight dispatch at its deadline without retry", async () => {
    const upstreamUrl = googleProvider.resolveUpstreamUrl({
      ...context,
      grant,
      requestedUrl: parseCanonicalHttps("https://gmail.googleapis.com/a"),
    });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    await expect(
      dispatchUpstream({ upstreamUrl, init: { method: "POST" }, signal: AbortSignal.timeout(10) }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds requests and responses, including declared lengths and stalled reads", async () => {
    for (const response of [
      new Response("12345"),
      new Request("https://example.com", { method: "POST", body: "12345" }),
      new Response("x", { headers: { "content-length": "500" } }),
    ])
      await expect(readBoundedBody({ response, maximum: 4 })).rejects.toThrow("limit");
    await expect(
      readBoundedBody({ response: new Response("x"), maximum: 10, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    const response = new Response(new ReadableStream({ start() {} }));
    await expect(
      readBoundedBody({ response, maximum: 10, signal: AbortSignal.timeout(10) }),
    ).rejects.toThrow();
  });
  it("uses domain-separated keyed fingerprints, never URL text", () => {
    vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64"));
    const requestedUrl = parseCanonicalHttps(
      "https://gmail.googleapis.com/private@email.test/messages/secret?q=private",
    );
    const fingerprint = fingerprintConnectorRequest({ method: "GET", requestedUrl });
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintConnectorRequest({ method: "GET", requestedUrl })).toBe(fingerprint);
    expect(fingerprintConnectorRequest({ method: "POST", requestedUrl })).not.toBe(fingerprint);
    vi.stubEnv("WELDALL_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 2).toString("base64"));
    expect(fingerprintConnectorRequest({ method: "GET", requestedUrl })).not.toBe(fingerprint);
  });
  it("enforces owner authority and projects only credential-free metadata", () => {
    expect(() => assertConnectionOwner({ ownerId: "owner", actorId: "attacker" })).toThrow(
      "not found",
    );
    const value = buildConnectionMetadata({
      row: {
        id: "c",
        providerSelection: selection,
        providerGrant: grant,
        credentialId: "private",
        credential: credentials,
      } as never,
      connector: { providerType: "google", enabled: true } as never,
    });
    expect(JSON.stringify(value)).not.toMatch(/credential|secret|accessToken/);
    expect(value.grantedScopes).toEqual(scopes);
    expect(value.scopeLabels).toEqual({
      openid: "Identify your Google account",
      "https://www.googleapis.com/auth/userinfo.email": "View your email address",
      [read]: "Read your mail",
    });
  });
  it("confirms revocation only after Google accepts the token", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(new Response('{"error":"invalid_token"}', { status: 400 }));
    await expect(revokeGoogleAuthorization("token")).resolves.toBeUndefined();
    await expect(revokeGoogleAuthorization("token")).rejects.toThrow("unconfirmed");
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it("orders declared scopes before connectors that require them", () => {
    const manifest = parseDesiredState({
      apiVersion: "weldall.dev/v1",
      workspace: {
        id: "67ade6dc-0000-4000-8000-000000000000",
        name: "test",
        issuer: "https://weldall.example.com",
      },
      scopes: {
        google: { key: "workspace:google", description: "Use Google connections" },
      },
      connectors: {
        google: { ...config, requiredScopes: ["workspace:google"] },
      },
    });
    const plan = createPlan(manifest, { revision: 0, objects: [] });
    expect(plan.actions.map(({ address }) => address)).toEqual([
      "scope.google",
      "connector.google",
    ]);
  });
  it("plans nested configuration drift without declarative secrets", () => {
    const manifest = parseDesiredState({
      apiVersion: "weldall.dev/v1",
      workspace: {
        id: "67ade6dc-0000-4000-8000-000000000000",
        name: "test",
        issuer: "https://weldall.example.com",
      },
      connectors: { google: config },
    });
    const plan = createPlan(manifest, {
      revision: 1,
      objects: [
        {
          id: "c",
          kind: "connector",
          identity: "google",
          address: "connector.google",
          ownerWorkspaceId: manifest.workspace.id,
          version: 2,
          state: { ...config, name: "UI edit" },
        },
      ],
    });
    expect(plan.actions).toContainEqual(expect.objectContaining({ action: "update", drift: true }));
    expect(() =>
      parseDesiredState({
        ...manifest,
        connectors: { google: { ...config, clientSecret: "forbidden" } },
      }),
    ).toThrow();
    expect(
      importRequestSchema.safeParse({
        workspace: manifest.workspace,
        kind: "connector",
        identity: "google",
        address: "connector.google",
        operationId: crypto.randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      moveRequestSchema.safeParse({
        workspaceId: manifest.workspace.id,
        from: "connector.google",
        to: "connector.renamed",
        operationId: crypto.randomUUID(),
      }).success,
    ).toBe(true);
  });
});
