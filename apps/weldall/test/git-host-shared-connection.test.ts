import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connector: null as Record<string, unknown> | null,
  connections: [] as Record<string, unknown>[],
  sharedRow: null as Record<string, unknown> | null,
  create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, version: 1 })),
  update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
  prepare: vi.fn(async ({ plaintext }: { plaintext: string }) => ({ sealed: plaintext.length })),
  persist: vi.fn(async () => ({ id: "credential" })),
  decrypt: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@weldall/db", () => {
  const db = {
    connector: { findUnique: vi.fn(async () => mocks.connector) },
    connection: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        where.id ? mocks.sharedRow : null,
      ),
      findMany: vi.fn(async () => mocks.connections),
      create: mocks.create,
      update: mocks.update,
    },
    user: {
      findUnique: vi.fn(async () => ({ id: "admin", email: "admin@example.com" })),
    },
    scope: { findMany: vi.fn(async () => [{ id: "scope" }]) },
  };
  return { db, Prisma: {}, isMachineOnlySystemScope: () => false };
});
vi.mock("../src/server/connectors/configuration", async () => {
  const { db } = await import("@weldall/db");
  return { runConnectorTransaction: (operation: (tx: unknown) => unknown) => operation(db) };
});
vi.mock("../src/server/connectors/encryption", () => ({
  prepareSecretEnvelope: mocks.prepare,
  persistSecretEnvelope: mocks.persist,
  loadSecretEnvelope: vi.fn(async ({ id }: { id: string }) => ({
    envelope: { id },
    connectorId: "connector",
  })),
  decryptSecretEnvelope: mocks.decrypt,
}));
vi.mock("../src/server/connectors/audit", () => ({ writeConnectorAuditLog: mocks.audit }));
vi.mock("../src/server/policy/resources", () => ({
  hasEffectiveSystemScopeFor: vi.fn(async () => true),
}));
import {
  createSharedConnection,
  rotateSharedConnectionCredential,
} from "../src/server/connectors/core/shared-connections";
import { openGitHost } from "../src/server/connectors/core/git-hosts";
import { parseGitHubAppPrivateKey } from "../src/server/connectors/providers/github-app/private-key";

const admin = { id: "admin", requestId: "request" };
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const pkcs8 = parseGitHubAppPrivateKey(privateKey);
const githubConnector = {
  id: "connector",
  key: "github",
  version: 1,
  enabled: true,
  providerType: "github-app",
  envelopeProvider: "LOCAL_ENV",
  providerConfig: {
    appId: "123456",
    organization: "acme-apps",
    installationId: "987654",
    apiBaseUrl: "https://api.github.com",
    templates: [{ name: "react", repository: "acme-templates/react-app" }],
    repositoryNamePrefix: "app-",
    reviewerTeam: "app-reviewers",
    setupMode: "customer-managed",
  },
};
const mcpConnector = {
  ...githubConnector,
  key: "atlassian",
  providerType: "atlassian-mcp",
  providerConfig: { allowedScopes: ["read:jira:agent-interface"], defaultScopes: [] },
};
const input = (providerInput: object, enabled = true) => ({
  connectorId: "connector",
  key: "git-key",
  name: "GitHub App key",
  enabled,
  useScopeKeys: ["git:publish"],
  providerInput,
});
const githubGrant = {
  kind: "github-app-private-key",
  apiBaseUrl: "https://api.github.com",
  appId: "123456",
};
const plaintexts = () => mocks.prepare.mock.calls.map(([call]) => JSON.parse(call.plaintext));
const storedGrant = () =>
  mocks.update.mock.calls.map(([call]) => call.data.providerGrant).find(Boolean);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connector = githubConnector;
  mocks.connections = [];
  mocks.sharedRow = null;
});

describe("shared connections for the GitHub App provider", () => {
  it("stores the validated key as the envelope-encrypted shared credential, bound to the App", async () => {
    await createSharedConnection(
      input({ kind: "github-app-private-key", privateKey: `${privateKey}\n` }),
      admin,
    );
    expect(plaintexts()).toEqual([{ kind: "github-app-private-key", privateKey: pkcs8 }]);
    expect(mocks.prepare.mock.calls[0]![0]).toMatchObject({
      provider: "LOCAL_ENV",
      connectorId: "connector",
      context: expect.stringMatching(/^connection:.+:credentials$/),
    });
    expect(mocks.create.mock.calls[0]![0].data).toMatchObject({
      accessMode: "SCOPED",
      providerSelection: { kind: "github-app-private-key" },
      enabled: false,
    });
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain("PRIVATE KEY");
    expect(storedGrant()).toEqual(githubGrant);
    expect(mocks.update.mock.calls[0]![0].data).toMatchObject({
      credentialId: "credential",
      enabled: true,
    });
  });

  it.each([
    [
      { kind: "github-app-private-key", privateKey: "-----BEGIN PUBLIC KEY-----" },
      "invalid_private_key",
    ],
    [{ kind: "service-account-api-key", apiKey: "key", cloudIds: [] }, "invalid_connector"],
  ])("rejects %j before encrypting or writing anything", async (providerInput, code) => {
    await expect(createSharedConnection(input(providerInput), admin)).rejects.toMatchObject({
      code,
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates disabled without a key and rejects enabling without one", async () => {
    await createSharedConnection(input({ kind: "github-app-private-key" }, false), admin);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledOnce();
    await expect(
      createSharedConnection(input({ kind: "github-app-private-key" }), admin),
    ).rejects.toMatchObject({ code: "MISSING_CREDENTIAL" });
  });

  it("rotates the key and re-derives the grant from the current configuration", async () => {
    mocks.sharedRow = {
      id: "shared",
      accessMode: "SCOPED",
      version: 2,
      status: "READY",
      credentialId: "credential",
      connectorId: "connector",
      providerSelection: { kind: "github-app-private-key" },
      connector: githubConnector,
    };
    await rotateSharedConnectionCredential(
      { id: "shared", version: 2, providerInput: { privateKey } },
      admin,
    );
    expect(plaintexts()).toEqual([{ kind: "github-app-private-key", privateKey: pkcs8 }]);
    expect(storedGrant()).toEqual(githubGrant);
    await expect(
      rotateSharedConnectionCredential(
        { id: "shared", version: 2, providerInput: { apiKey: "wrong kind" } },
        admin,
      ),
    ).rejects.toThrow();
  });

  it("keeps the Atlassian service account credential and grant unchanged", async () => {
    mocks.connector = mcpConnector;
    const cloudId = "00000000-0000-4000-8000-000000000001";
    await createSharedConnection(
      input({ kind: "service-account-api-key", apiKey: "api-key-sentinel", cloudIds: [cloudId] }),
      admin,
    );
    expect(plaintexts()).toEqual([{ kind: "service-account-api-key", apiKey: "api-key-sentinel" }]);
    expect(storedGrant()).toEqual({
      kind: "service-account-api-key",
      cloudIds: [cloudId],
      resource: "https://mcp.atlassian.com/v2/mcp",
    });
    await expect(
      createSharedConnection(input({ kind: "github-app-private-key", privateKey }), admin),
    ).rejects.toMatchObject({ code: "invalid_connector" });
  });
});

describe("opening a Git host", () => {
  const shared = {
    id: "shared",
    credentialId: "credential",
    providerSelection: { kind: "github-app-private-key" },
    providerGrant: githubGrant,
  };

  it("uses the one ready shared connection and decrypts its key only when needed", async () => {
    mocks.connections = [shared];
    mocks.decrypt.mockResolvedValue(
      JSON.stringify({ kind: "github-app-private-key", privateKey: pkcs8 }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            token: "ghs_shared_test",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: { contents: "read", metadata: "read" },
            repositories: [{ name: "app-shared-test" }],
          },
          { status: 201 },
        ),
      ),
    );
    const host = await openGitHost({ connectorId: "connector" });
    expect(host.setupMode).toBe("customer-managed");
    expect(mocks.decrypt).not.toHaveBeenCalled();
    const target = await host.getForwardingTarget(
      { repository: { owner: "acme-apps", name: "app-shared-test" }, access: "read" },
      AbortSignal.timeout(5_000),
    );
    expect(target.url.href).toBe("https://github.com/acme-apps/app-shared-test.git");
    expect(mocks.decrypt).toHaveBeenCalledWith(
      expect.objectContaining({ context: "connection:shared:credentials" }),
    );
    vi.unstubAllGlobals();
  });

  it.each([
    ["no shared connection", () => (mocks.connections = []), "credential_unavailable"],
    [
      "two shared connections",
      () => (mocks.connections = [shared, { ...shared, id: "second" }]),
      "credential_unavailable",
    ],
    [
      "a disabled connector",
      () => (mocks.connector = { ...githubConnector, enabled: false }),
      "disabled",
    ],
    [
      "a connector that is not a Git host",
      () => (mocks.connector = mcpConnector),
      "unsupported_provider",
    ],
    ["a missing connector", () => (mocks.connector = null), "not_found"],
  ])("refuses %s", async (_name, arrange, code) => {
    mocks.connections = [shared];
    arrange();
    await expect(openGitHost({ connectorId: "connector" })).rejects.toMatchObject({ code });
  });
});
