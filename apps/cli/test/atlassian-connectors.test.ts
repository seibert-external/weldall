import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateAtlassianConfiguration } from "../src/iac/atlassian.js";
import { loadWorkspace, newLock, serverManifest } from "../src/iac/manifest.js";
import { isConnectionSummary } from "../src/services/connections.js";
import { encodeConnectionDetailToon } from "../src/connections-toon.js";
// Keep CLI validation aligned with the provider's authoritative scope catalog.
import { JIRA_CLASSIC_SCOPES } from "../../weldall/src/server/connectors/providers/atlassian/jira-scopes.js";
import { scopeCatalog } from "../../weldall/src/server/connectors/providers/atlassian/config.js";

const site = "8594f221-9797-5f78-1fa4-485e198d7cd0";
const provider = {
  clientId: "client",
  grantType: "resource",
  products: ["jira"],
  allowedCloudIds: [site],
  allowedScopes: ["read:jira-work"],
  defaultScopes: ["read:jira-work"],
};
describe("Atlassian connector IaC", () => {
  it.each(JIRA_CLASSIC_SCOPES)("accepts classic scope $id", ({ id }) => {
    expect(() =>
      validateAtlassianConfiguration({ ...provider, allowedScopes: [id], defaultScopes: [id] }),
    ).not.toThrow();
  });
  it("accepts every provider-reviewed granular scope", () => {
    for (const scope of scopeCatalog.filter((scope) => scope.mode === "granular"))
      expect(() =>
        validateAtlassianConfiguration({
          ...provider,
          products: [scope.product],
          allowedScopes: [scope.id],
          defaultScopes: [scope.id],
        }),
      ).not.toThrow();
  });
  it.each(["read:page:other", "unknown:jira", "read::jira"])(
    "rejects malformed scope %s",
    (scope) => {
      expect(() =>
        validateAtlassianConfiguration({
          ...provider,
          products: ["jira", "confluence"],
          allowedScopes: [scope],
          defaultScopes: [],
        }),
      ).toThrow();
    },
  );
  it.each([
    { grantType: "account" },
    { allowedCloudIds: [] },
    { allowedCloudIds: ["https://site.atlassian.net"] },
    { clientSecret: "secret" },
    { allowedScopes: ["offline_access"] },
    { defaultScopes: ["write:jira-work"] },
    { products: ["unknown"] },
  ])("rejects %j", (patch) => {
    expect(() => validateAtlassianConfiguration({ ...provider, ...patch })).toThrow();
  });
  it("loads and canonicalizes Atlassian policy without changing existing wire fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "weldall-atlassian-test-"));
    try {
      await writeFile(
        join(root, "weldall.yml"),
        JSON.stringify({
          apiVersion: "weldall.dev/v1",
          workspace: { name: "test", issuer: "https://weldall.example.com" },
          connectors: {
            jira: {
              key: "company-jira",
              name: "Company Jira",
              type: "atlassian",
              enabled: false,
              envelopeProvider: "LOCAL_ENV",
              requiredScopes: [],
              provider: { ...provider, allowedCloudIds: [site, site] },
            },
          },
        }),
      );
      const loaded = await loadWorkspace(root);
      const result = serverManifest(loaded.manifest, newLock(loaded.manifest));
      expect(result.connectors.jira.provider).toEqual(provider);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("provider-neutral connection details", () => {
  const connection = {
    id: "id",
    ownerId: "owner",
    connectorId: "connector",
    name: "my-jira",
    accountId: "account",
    accountName: "Owner",
    selectedScopes: [],
    grantedScopes: [],
    status: "READY",
    version: 1,
    lastUsedAt: null,
    requestCount: 0,
    revocationError: null,
    createdAt: "now",
    updatedAt: "now",
    connectorKey: "company-jira",
    connectorEnabled: true,
  };
  it("accepts older responses with no details", () =>
    expect(isConnectionSummary(connection)).toBe(true));
  it("validates and renders provider-owned display metadata", () => {
    const details = [{ label: "Site", value: site }];
    expect(isConnectionSummary({ ...connection, details })).toBe(true);
    expect(isConnectionSummary({ ...connection, details: [{ label: "Site", value: {} }] })).toBe(
      false,
    );
    expect(
      encodeConnectionDetailToon({
        connection: { ...connection, details },
        issuer: "https://weldall.example.com",
      }),
    ).toContain(site);
  });
});
