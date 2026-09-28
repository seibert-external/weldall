import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atlassianProvider as adapter } from "../src/server/connectors/providers/atlassian";
import {
  atlassianConfigSchema,
  canonicalScopes,
  requiredScopes,
  scopeCatalog,
} from "../src/server/connectors/providers/atlassian/config";
import { JIRA_CLASSIC_SCOPES } from "../src/server/connectors/providers/atlassian/jira-scopes";
import { validateResources } from "../src/server/connectors/providers/atlassian/grant";
import type { ConnectorProvider } from "../src/server/connectors/provider";
import { connectorConfig } from "../src/server/connectors/contracts";
import { getConnectorProvider } from "../src/server/connectors/registry";
import { RejectedProviderCredentials } from "../src/server/connectors/errors";

const provider: ConnectorProvider = adapter;
const cloudId = "1324a887-45db-1bf4-1e99-ef0ff456d421";
// Atlassian's own cloud-ID example is not an RFC4122 variant UUID. Real cloud IDs are opaque UUID-shaped IDs.
const site = "8594f221-9797-5f78-afa4-485e198d7cd0";
const otherSite = "11223344-a1b2-4b33-8444-def123456789";
const config = {
  clientId: "client",
  grantType: "resource",
  products: ["jira"],
  allowedCloudIds: [site, otherSite],
  allowedScopes: ["read:jira-work"],
  defaultScopes: ["read:jira-work"],
};
const scopes = canonicalScopes([...requiredScopes, "read:jira-work"]);
const selection = { scopes };
const credentials = {
  accessToken: "private-access",
  refreshToken: "private-refresh",
  expiresAt: Date.now() + 3600_000,
  grantedScopes: scopes,
};
const resource = {
  id: site,
  name: "Company",
  url: "https://company.atlassian.net",
  scopes: ["read:jira-work"],
};
const secrets = { clientSecret: "private-secret" };
const fetcher = vi.fn<typeof fetch>();
let token: Record<string, unknown>;
let resources: unknown[];
let tokenStatus: number;
const complete = () =>
  provider.completeAuthorization({
    config,
    secrets,
    selection,
    callback: new URLSearchParams({ code: "private-code" }),
    attempt: {},
    callbackUrl: "https://weldall.example.com/api/connectors/atlassian/callback",
  });
const grant = () => validateResources({ config, selection, credentials, resources: [resource] });

beforeEach(() => {
  tokenStatus = 200;
  token = {
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    expires_in: 3600,
    token_type: "Bearer",
    scope: scopes.join(" "),
  };
  resources = [resource];
  fetcher.mockReset().mockImplementation(async (url) => {
    switch (String(url)) {
      case "https://auth.atlassian.com/oauth/token":
        return Response.json(token, { status: tokenStatus });
      case "https://api.atlassian.com/me":
        return Response.json({ account_id: "account", name: "Owner" });
      case "https://api.atlassian.com/oauth/token/accessible-resources":
        return Response.json(resources);
      default:
        throw new Error("Unexpected endpoint");
    }
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());

describe("Atlassian policy and provider boundary", () => {
  it("offers all six Jira classic scopes without changing defaults", () => {
    const ids = JIRA_CLASSIC_SCOPES.map((scope) => scope.id);
    expect(ids).toHaveLength(6);
    expect(
      scopeCatalog.filter((scope) => scope.product === "jira").map((scope) => scope.id),
    ).toEqual(ids);
    const policy = atlassianConfigSchema.parse({ ...config, allowedScopes: ids });
    expect(policy.defaultScopes).toEqual(config.defaultScopes);
    const display = provider.describeSetup({ config: policy });
    for (const scope of JIRA_CLASSIC_SCOPES) {
      expect(display.scopes).toContainEqual(
        expect.objectContaining({ id: scope.id, label: scope.label, required: false }),
      );
      expect(display.scopes.find((entry) => entry.id === scope.id)?.description).toContain(
        scope.description,
      );
      expect(() =>
        provider.validateSetupInput({
          config: policy,
          value: { scopes: [...requiredScopes, scope.id] },
        }),
      ).not.toThrow();
    }
  });
  it.each(["read:issue:jira", "write:project:jira", "delete:issue:jira", "read:page:confluence"])(
    "rejects granular scope %s",
    (scope) => {
      expect(() =>
        atlassianConfigSchema.parse({
          ...config,
          products: ["jira", "confluence"],
          allowedScopes: [scope],
          defaultScopes: [],
        }),
      ).toThrow();
    },
  );
  it("registers through the existing opaque provider boundary", () => {
    expect(getConnectorProvider("atlassian")).toBe(adapter);
    expect(
      connectorConfig.parse({
        key: "jira",
        name: "Jira",
        type: "atlassian",
        enabled: false,
        envelopeProvider: "LOCAL_ENV",
        requiredScopes: [],
        provider: config,
      }).type,
    ).toBe("atlassian");
    expect(() => getConnectorProvider("unknown")).toThrow();
  });
  it.each([
    { allowedCloudIds: [] },
    { grantType: "account" },
    { clientSecret: "secret" },
    { allowedScopes: ["read:confluence-content.all"] },
    { defaultScopes: ["write:jira-work"] },
    { allowedScopes: ["offline_access"] },
  ])("rejects unsafe policy %j", (patch) => {
    expect(() => atlassianConfigSchema.parse({ ...config, ...patch })).toThrow();
  });
  it("accepts UUID-shaped cloud IDs documented by Atlassian", () => {
    expect(
      atlassianConfigSchema.parse({ ...config, allowedCloudIds: [cloudId] }).allowedCloudIds,
    ).toEqual([cloudId]);
  });
  it("requires offline access and identity without a Weldall site choice", () => {
    const initial = provider.buildInitialSelection({ config });
    expect(initial).toMatchObject({ scopes });
    const display = provider.describeSetup({ config, previousSelection: selection });
    expect(display.choices).toBeUndefined();
    expect(initial).not.toHaveProperty("cloudId");
    expect(display.scopes.filter((scope) => scope.required).map((scope) => scope.id)).toEqual(
      requiredScopes,
    );
    expect(() =>
      provider.validateSetupInput({ config, value: { ...selection, scopes: ["read:jira-work"] } }),
    ).toThrow();
  });
  it("includes mandatory scopes without inventing a resource-level authorize parameter", async () => {
    const result = await provider.beginAuthorization({
      config,
      secrets,
      selection,
      callbackUrl: "https://weldall.example.com/callback",
    });
    const url = new URL(result.url);
    expect(url.origin).toBe("https://auth.atlassian.com");
    expect(url.searchParams.get("scope")).toBe(scopes.join(" "));
    expect(url.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(url.searchParams.get("state")).toBe(result.state);
    expect(result.state.length).toBeGreaterThan(32);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Atlassian authorization and rotation", () => {
  it("verifies identity and a single site, never exposing tokens in metadata", async () => {
    const result = await complete();
    expect(result).toMatchObject({
      accountId: "account",
      accountName: "Owner",
      credentials: {
        accessToken: "private-access",
        refreshToken: "private-refresh",
        grantedScopes: scopes,
      },
      grant: { cloudId: site, products: ["jira"] },
    });
    expect(
      JSON.stringify(provider.describeConnection({ selection, grant: result.grant })),
    ).not.toContain("private-");
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  });
  it("rejects an issued token missing refresh_token and retains cleanup material", async () => {
    delete token.refresh_token;
    await expect(complete()).rejects.toBeInstanceOf(RejectedProviderCredentials);
  });
  it("accepts an omitted unchanged scope field but still verifies site permissions", async () => {
    delete token.scope;
    expect((await complete()).grant).toMatchObject({ scopes });
    resources = [{ ...resource, scopes: [] }];
    await expect(complete()).rejects.toBeInstanceOf(RejectedProviderCredentials);
  });
  it.each([
    [],
    [{ ...resource, id: cloudId }],
    [resource, { ...resource, id: otherSite }],
    [{ ...resource, scopes: [] }],
  ])("rejects missing/wrong/multiple sites or missing scopes", async (value) => {
    resources = value;
    await expect(complete()).rejects.toBeInstanceOf(RejectedProviderCredentials);
  });
  it("binds to whichever single approved site was chosen on Atlassian", async () => {
    resources = [{ ...resource, id: otherSite }];
    expect((await complete()).grant).toMatchObject({ cloudId: otherSite });
  });
  it("rejects changing to another approved site during use or refresh", async () => {
    resources = [{ ...resource, id: otherSite }];
    await expect(
      provider.ensureGrantCurrent({ config, selection, credentials, previousGrant: grant() }),
    ).rejects.toMatchObject({ code: "grant_mismatch" });
    await expect(
      provider.refreshCredentials({
        config,
        secrets,
        selection,
        credentials,
        previousGrant: grant(),
      }),
    ).rejects.toBeInstanceOf(RejectedProviderCredentials);
  });
  it("rejects a removed site during grant revalidation", async () => {
    await expect(
      provider.ensureGrantCurrent({
        config: { ...config, allowedCloudIds: [otherSite] },
        selection,
        credentials,
        previousGrant: grant(),
      }),
    ).rejects.toMatchObject({ code: "grant_mismatch" });
  });
  it("rejects expanded token consent", async () => {
    token.scope = `${scopes.join(" ")} write:jira-work`;
    await expect(complete()).rejects.toBeInstanceOf(RejectedProviderCredentials);
  });
  it("supports separate product entries sharing a cloud ID", () => {
    const combinedScopes = canonicalScopes([...scopes, "read:confluence-content.all"]);
    const combined = {
      ...config,
      products: ["jira", "confluence"],
      allowedScopes: ["read:jira-work", "read:confluence-content.all"],
    };
    const result = validateResources({
      config: combined,
      selection: { ...selection, scopes: combinedScopes },
      credentials: { ...credentials, grantedScopes: combinedScopes },
      resources: [resource, { ...resource, scopes: ["read:confluence-content.all"] }],
    });
    expect(result.products).toEqual(["jira", "confluence"]);
  });
  it("returns the replacement refresh token for atomic persistence", async () => {
    token.refresh_token = "rotated-refresh";
    const result = await provider.refreshCredentials({
      config,
      secrets,
      selection,
      credentials,
      previousGrant: grant(),
    });
    expect(result.credentials).toMatchObject({ refreshToken: "rotated-refresh" });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "private-refresh",
    });
  });
  it("retains rotated credentials if post-refresh grant validation fails", async () => {
    token.refresh_token = "rotated-refresh";
    resources = [];
    const error = await provider
      .refreshCredentials({ config, secrets, selection, credentials, previousGrant: grant() })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RejectedProviderCredentials);
    expect((error as RejectedProviderCredentials).credentials).toMatchObject({
      refreshToken: "rotated-refresh",
    });
    expect(JSON.stringify(error)).not.toMatch(/private-|rotated-refresh/);
  });
  it("marks invalid grants as authorization loss and does not retry uncertain server errors", async () => {
    tokenStatus = 403;
    token = { error: "invalid_grant" };
    await expect(complete()).rejects.toMatchObject({ authorizationLost: true, retryable: false });
    tokenStatus = 503;
    token = { error: "server_error" };
    await expect(complete()).rejects.toMatchObject({ authorizationLost: false, retryable: false });
  });
  it("rechecks upstream access even without a refresh", async () => {
    resources = [];
    await expect(
      provider.ensureGrantCurrent({ config, selection, credentials, previousGrant: grant() }),
    ).rejects.toThrow();
  });
  it("does not revoke an app-wide grant or claim remote revocation", async () => {
    expect(await provider.disconnectGrant({ config, secrets, credentials })).toMatchObject({
      status: "unsupported",
      remediationUrl: "https://id.atlassian.com/manage-profile/apps",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Atlassian request boundary", () => {
  const resolve = (url: string, policy: unknown = config) =>
    provider.resolveUpstreamUrl({
      config: policy,
      selection,
      grant: grant(),
      requestedUrl: new URL(url),
    });
  it("allows only the selected product gateway and site", () => {
    expect(
      resolve(`https://api.atlassian.com/ex/jira/${site}/rest/api/3/search/jql?jql=project%3DABC`)
        .hostname,
    ).toBe("api.atlassian.com");
  });
  it.each([
    `https://company.atlassian.net/rest/api/3/issue/ABC-1`,
    `https://api.atlassian.com/ex/jira/${otherSite}/rest/api/3/myself`,
    `https://api.atlassian.com/ex/confluence/${site}/wiki/api/v2/pages`,
    `https://api.atlassian.com/ex/jira/${site}/oauth/token`,
    `https://api.atlassian.com/ex/jira/${site}/rest/api/3/%2f..%2fadmin`,
    `https://api.atlassian.com/ex/jira/${site}/rest/api/3//issue`,
    `https://user@api.atlassian.com/ex/jira/${site}/rest/api/3/myself`,
    `https://api.atlassian.com/ex/jira/${site}/rest/api/3/myself#fragment`,
    `https://api.atlassian.com.evil.test/ex/jira/${site}/rest/api/3/myself`,
  ])("rejects %s", (url) => expect(() => resolve(url)).toThrow());
  it("allows Confluence v1/v2 only with matching product consent", () => {
    const confluenceScopes = canonicalScopes([...requiredScopes, "read:confluence-content.all"]);
    const confluenceConfig = {
      ...config,
      products: ["confluence"],
      allowedScopes: ["read:confluence-content.all"],
      defaultScopes: [],
    };
    const confluenceSelection = { ...selection, scopes: confluenceScopes };
    const approved = validateResources({
      config: confluenceConfig,
      selection: confluenceSelection,
      credentials: { ...credentials, grantedScopes: confluenceScopes },
      resources: [{ ...resource, scopes: ["read:confluence-content.all"] }],
    });
    for (const path of ["wiki/api/v2/pages", "wiki/rest/api/content"]) {
      const requestedUrl = new URL(`https://api.atlassian.com/ex/confluence/${site}/${path}`);
      expect(
        provider
          .resolveUpstreamUrl({
            config: confluenceConfig,
            selection: confluenceSelection,
            grant: approved,
            requestedUrl,
          })
          .toString(),
      ).toBe(requestedUrl.toString());
    }
    expect(() =>
      provider.resolveUpstreamUrl({
        config: confluenceConfig,
        selection: confluenceSelection,
        grant: approved,
        requestedUrl: new URL(`https://api.atlassian.com/ex/jira/${site}/rest/api/3/myself`),
      }),
    ).toThrow();
  });
  it("immediately enforces a removed site or scope", () => {
    const url = `https://api.atlassian.com/ex/jira/${site}/rest/api/3/myself`;
    expect(() => resolve(url, { ...config, allowedCloudIds: [otherSite] })).toThrow();
    expect(() =>
      resolve(url, { ...config, allowedScopes: ["write:jira-work"], defaultScopes: [] }),
    ).toThrow();
  });
  it("injects credentials only in the server request and removes identity overrides", () => {
    const url = resolve(`https://api.atlassian.com/ex/jira/${site}/rest/api/3/myself`);
    const init = provider.buildUpstreamRequest({
      upstreamUrl: url,
      credentials,
      request: {
        requestedUrl: url,
        method: "GET",
        headers: new Headers({
          "x-atlassian-token": "override",
          "x-http-method-override": "DELETE",
        }),
      },
      signal: AbortSignal.timeout(1000),
    });
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer private-access");
    expect(headers.has("x-http-method-override")).toBe(false);
    expect(headers.has("x-atlassian-token")).toBe(false);
    expect(init.redirect).toBe("error");
  });
});
