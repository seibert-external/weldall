import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../src/server/observability/logger";
import {
  beginAtlassianMcpAuthorization,
  exchangeAtlassianMcpTokens,
  registerAtlassianMcpClient,
  grantFromCredentials,
} from "../src/server/connectors/providers/atlassian-mcp/oauth";
import { atlassianMcpProvider } from "../src/server/connectors/providers/atlassian-mcp";
import {
  ATLASSIAN_MCP as target,
  canonicalScopes,
  validateMcpEndpoint,
} from "../src/server/connectors/providers/atlassian-mcp/config";
const scopes = canonicalScopes([
  "read:me",
  "read:account",
  "offline_access",
  "read:jira:agent-interface",
  "search:jira:agent-interface",
]);
const callbackUrl = "https://weldall.example.com/api/connectors/atlassian-mcp/callback";
const site = "00000000-0000-4000-8000-000000000001";
const jwt = (cloudId = site, sub = "system-account") =>
  `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub, aud: [`ari:cloud:jira::site/${cloudId}`] })).toString("base64url")}.fake-provider-signature`;
function fixture() {
  const state = {
    metadata: {
      issuer: target.issuer,
      authorization_endpoint: target.authorization,
      token_endpoint: target.token,
      registration_endpoint: target.registration,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    },
    token: {
      access_token: jwt(),
      refresh_token: "rotated-refresh",
      token_type: "Bearer",
      expires_in: 28800,
      scope: scopes.join(" ") as string | undefined,
    },
    registration: {
      client_id: "public-client",
      client_secret: "unused-secret-must-not-be-retained",
      token_endpoint_auth_method: "none",
      redirect_uris: [callbackUrl],
    },
  };
  const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url) === target.resourceMetadata)
      return Response.json({
        resource: target.resource,
        authorization_servers: [target.issuer],
        scopes_supported: scopes,
      });
    if (String(url) === target.metadata) return Response.json(state.metadata);
    if (String(url) === target.registration)
      return Response.json(state.registration, { status: 201 });
    if (String(url) === target.token) {
      expect(init?.method).toBe("POST");
      return Response.json(state.token);
    }
    throw new Error("Unreviewed endpoint");
  });
  return { state, fetcher };
}
describe("Atlassian MCP public-client provider (no live requests)", () => {
  let records: Record<string, any>[];
  let detach: () => void;
  beforeEach(() => {
    records = [];
    detach = logger.attachTransport((record) => records.push(record));
  });
  afterEach(() => detach());
  it("registers once and discards an unused public-client secret", async () => {
    const { fetcher } = fixture();
    expect(await registerAtlassianMcpClient(callbackUrl, fetcher)).toEqual({
      clientId: "public-client",
    });
    expect(fetcher.mock.calls.filter(([url]) => String(url) === target.registration)).toHaveLength(
      1,
    );
    const body = JSON.parse(
      String(fetcher.mock.calls.find(([url]) => String(url) === target.registration)![1]!.body),
    );
    expect(body).toMatchObject({
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [callbackUrl],
    });
  });
  it("does not accept a confidential-client registration", async () => {
    const { fetcher, state } = fixture();
    state.registration.token_endpoint_auth_method = "client_secret_post";
    await expect(registerAtlassianMcpClient(callbackUrl, fetcher)).rejects.toMatchObject({
      code: "registration_failed",
    });
  });
  it("binds public-client PKCE to the reviewed resource, redirect and random state", async () => {
    const { fetcher } = fixture();
    const first = await beginAtlassianMcpAuthorization(
      { clientId: "public-client", callbackUrl, scopes },
      fetcher,
    );
    const second = await beginAtlassianMcpAuthorization(
      { clientId: "public-client", callbackUrl, scopes },
      fetcher,
    );
    const url = new URL(first.url);
    expect(url.origin + url.pathname).toBe(target.authorization);
    expect(url.searchParams.get("resource")).toBe(target.resource);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(first.state);
    expect(first.state).not.toBe(second.state);
    expect(first.attempt.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });
  it("exchanges without a client secret and preserves the site-bound system-account identity", async () => {
    const { fetcher } = fixture();
    const attempt = await beginAtlassianMcpAuthorization(
      { clientId: "public-client", callbackUrl, scopes },
      fetcher,
    );
    const result = await exchangeAtlassianMcpTokens(
      { scopes, callbackUrl, code: "approved-code", attempt: attempt.attempt },
      fetcher,
    );
    expect(result.grant).toEqual({
      resource: target.resource,
      cloudId: site,
      accountId: "system-account",
      scopes,
    });
    expect(result.credentials.expiresAt - Date.now()).toBeGreaterThan(28_790_000);
    const init = fetcher.mock.calls.find(([url]) => String(url) === target.token)![1]!;
    const body = new URLSearchParams(String(init.body));
    expect(body.get("client_id")).toBe("public-client");
    expect(body.get("code_verifier")).toBe(attempt.attempt.codeVerifier);
    expect(body.get("resource")).toBe(target.resource);
    expect(body.has("client_secret")).toBe(false);
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });
  it.each(["authorization", "refresh"])(
    "accepts a reduced grant during %s and before dispatch",
    async (operation) => {
      const { fetcher, state } = fixture();
      const grantedScopes = scopes.filter((scope) => scope !== "search:jira:agent-interface");
      state.token.scope = grantedScopes.join(" ");
      const attempt = await beginAtlassianMcpAuthorization(
        { clientId: "public-client", callbackUrl, scopes },
        fetcher,
      );
      const previous = {
        accessToken: jwt(),
        refreshToken: "previous-refresh",
        expiresAt: 0,
        clientId: "public-client",
        grantedScopes: scopes,
      };
      const result = await exchangeAtlassianMcpTokens(
        {
          scopes,
          ...(operation === "refresh"
            ? { previous }
            : { callbackUrl, code: "approved-code", attempt: attempt.attempt }),
        },
        fetcher,
      );
      expect(result.credentials.grantedScopes).toEqual(grantedScopes);
      expect(result.grant.scopes).toEqual(grantedScopes);
      const config = {
        allowedScopes: ["read:jira:agent-interface", "search:jira:agent-interface"],
        defaultScopes: ["read:jira:agent-interface"],
      };
      const context = {
        config,
        selection: { scopes },
        credentials: result.credentials,
        previousGrant: atlassianMcpProvider.parseGrant(result.grant),
      };
      await expect(atlassianMcpProvider.ensureGrantCurrent(context)).resolves.toEqual(result.grant);
      // A reduced grant must still match persisted state, not merely be a subset of selection.
      await expect(
        atlassianMcpProvider.ensureGrantCurrent({
          ...context,
          previousGrant: atlassianMcpProvider.parseGrant({ ...result.grant, scopes }),
        }),
      ).rejects.toMatchObject({ code: "grant_mismatch" });
      expect(
        atlassianMcpProvider.describeConnection({ selection: { scopes }, grant: result.grant }),
      ).toMatchObject({ selectedScopes: scopes, grantedScopes });
      expect(records.map((record) => record[0])).toContainEqual({
        event: "connector.oauth.scopes_reduced",
        provider: "atlassian-mcp",
        operation,
        missingScopes: ["search:jira:agent-interface"],
        grantedScopeCount: grantedScopes.length,
      });
      const logged = JSON.stringify(records);
      for (const secret of [
        state.token.access_token,
        state.token.refresh_token,
        previous.refreshToken,
        "approved-code",
        attempt.attempt.codeVerifier,
      ])
        expect(logged).not.toContain(secret);
    },
  );
  it("retains a reduced grant when refresh omits scope instead of restoring requested permissions", async () => {
    const { fetcher, state } = fixture();
    state.token.scope = undefined;
    const previous = {
      accessToken: jwt(),
      refreshToken: "previous-refresh",
      expiresAt: 0,
      clientId: "public-client",
      grantedScopes: scopes.filter((scope) => scope !== "search:jira:agent-interface"),
    };
    const result = await exchangeAtlassianMcpTokens({ scopes, previous }, fetcher);
    expect(result.credentials.grantedScopes).toEqual(previous.grantedScopes);
    expect(result.grant.scopes).toEqual(previous.grantedScopes);
  });
  it.each([jwt("00000000-0000-4000-8000-000000000002"), jwt(site, "different-system-account")])(
    "rotates refresh credentials and refuses a different site or account (%#)",
    async (changedToken) => {
      const { fetcher, state } = fixture();
      const previous = {
        accessToken: jwt(),
        refreshToken: "previous-refresh",
        expiresAt: 0,
        clientId: "public-client",
        grantedScopes: scopes,
      };
      const refreshed = await exchangeAtlassianMcpTokens({ scopes, previous }, fetcher);
      expect(refreshed.credentials.refreshToken).toBe("rotated-refresh");
      state.token.access_token = changedToken;
      await expect(exchangeAtlassianMcpTokens({ scopes, previous }, fetcher)).rejects.toThrow();
      expect(fetcher.mock.calls.filter(([url]) => String(url) === target.token)).toHaveLength(2);
      expect(records.map((record) => record[0])).toContainEqual(
        expect.objectContaining({
          event: "connector.oauth.failed",
          operation: "refresh",
          phase: "identity_continuity",
          failureReason: "credentials_rejected",
        }),
      );
    },
  );
  it("rejects unrequested scopes and unreviewed discovery endpoints", async () => {
    const { fetcher, state } = fixture();
    const previous = {
      accessToken: jwt(),
      refreshToken: "previous-refresh",
      expiresAt: 0,
      clientId: "public-client",
      grantedScopes: scopes,
    };
    state.token.scope += " write:jira:agent-interface unexpected-scope-secret-sentinel";
    await expect(exchangeAtlassianMcpTokens({ scopes, previous }, fetcher)).rejects.toMatchObject({
      code: "grant_mismatch",
    });
    expect(records.map((record) => record[0])).toContainEqual(
      expect.objectContaining({
        event: "connector.oauth.failed",
        phase: "scope_validation",
        unexpectedScopeCount: 2,
        failureReason: "credentials_rejected",
      }),
    );
    const logged = JSON.stringify(records);
    for (const secret of [
      "unexpected-scope-secret-sentinel",
      state.token.access_token,
      state.token.refresh_token,
    ])
      expect(logged).not.toContain(secret);
    await expect(
      atlassianMcpProvider.ensureGrantCurrent({
        config: {
          allowedScopes: ["read:jira:agent-interface", "search:jira:agent-interface"],
          defaultScopes: [],
        },
        selection: { scopes },
        credentials: { ...previous, grantedScopes: [...scopes, "write:jira:agent-interface"] },
        previousGrant: atlassianMcpProvider.parseGrant(
          grantFromCredentials({
            ...previous,
            grantedScopes: [...scopes, "write:jira:agent-interface"],
          }),
        ),
      }),
    ).rejects.toMatchObject({ code: "grant_mismatch" });
    state.metadata.token_endpoint = "https://attacker.example/token";
    await expect(
      beginAtlassianMcpAuthorization({ clientId: "public-client", callbackUrl, scopes }, fetcher),
    ).rejects.toThrow();
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("attacker"))).toBe(false);
  });
  it.each(["token_response_validation", "identity_validation", "token_request"])(
    "logs a sanitized %s failure",
    async (phase) => {
      const { fetcher, state } = fixture();
      const previous = {
        accessToken: jwt(),
        refreshToken: "previous-refresh",
        expiresAt: 0,
        clientId: "public-client",
        grantedScopes: scopes,
      };
      if (phase === "token_response_validation") state.token.expires_in = -1;
      if (phase === "identity_validation") state.token.access_token = "opaque-access-token-secret";
      const fetchFn = async (url: string | URL, init?: RequestInit) => {
        if (phase === "token_request" && String(url) === target.token)
          throw new Error("provider-body-secret");
        return fetcher(url, init);
      };
      await expect(exchangeAtlassianMcpTokens({ scopes, previous }, fetchFn)).rejects.toThrow();
      expect(records.map((record) => record[0])).toContainEqual(
        expect.objectContaining({
          event: "connector.oauth.failed",
          provider: "atlassian-mcp",
          operation: "refresh",
          phase,
        }),
      );
      const logged = JSON.stringify(records);
      for (const secret of [
        state.token.access_token,
        state.token.refresh_token,
        "previous-refresh",
        "provider-body-secret",
      ])
        expect(logged).not.toContain(secret);
    },
  );
  it("rejects missing site claims, wrong endpoints, REST proxy calls and credential reflections", () => {
    const credentials = {
      accessToken: jwt(),
      refreshToken: "refresh-sentinel",
      expiresAt: 0,
      clientId: "public-client",
      grantedScopes: scopes,
    };
    expect(grantFromCredentials(credentials).cloudId).toBe(site);
    expect(() => grantFromCredentials({ ...credentials, accessToken: "not-a-jwt" })).toThrow();
    expect(() => validateMcpEndpoint(new URL("https://api.atlassian.com/v2/mcp"))).toThrow();
    expect(() =>
      atlassianMcpProvider.mcp!.assertSafeResult(
        { content: [{ type: "text", text: credentials.refreshToken }] },
        credentials,
      ),
    ).toThrow();
  });
});
