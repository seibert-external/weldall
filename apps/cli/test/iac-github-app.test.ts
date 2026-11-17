import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadWorkspace, newLock, serverManifest, writeLock } from "../src/iac/manifest.js";
import { IacClient } from "../src/iac/client.js";
// Compare the public wire contract without loading the server's database-backed manifest parser.
import { githubAppConfigSchema as serverSchema } from "../../weldall/src/server/connectors/providers/github-app/config.js";
import { sharedConnectionConfigSchema } from "../../weldall/src/server/domain/secret-primitive-contracts.js";

const installationId = "00000000-0000-4000-8000-000000000001";
const base = {
  apiVersion: "weldall.dev/v1" as const,
  workspace: { name: "test", issuer: "https://weldall.example.com" },
};
const provider = {
  appId: 123456,
  organization: "acme-apps",
  templates: [{ name: "react", repository: "acme-templates/react-app" }],
  repositoryNamePrefix: "app-",
  reviewerTeam: "app-reviewers",
  setupMode: "customer-managed",
};
const connector = {
  key: "github",
  name: "GitHub",
  type: "github-app",
  enabled: false,
  envelopeProvider: "LOCAL_ENV",
  requiredScopes: [],
  provider,
};
const sharedConnection = {
  key: "github-app-key",
  connectorKey: "github",
  name: "GitHub App key",
  enabled: false,
  useScopes: ["git:publish"],
  credentialManagerEmail: "admin@example.com",
  serviceAccountLabel: "GitHub App",
  provider: { kind: "github-app-private-key" },
};
let root: string, previous: string;
const write = (manifest: object) => writeFile(join(root, "weldall.yml"), stringify(manifest));
beforeEach(async () => {
  previous = process.cwd();
  root = await mkdtemp(join(tmpdir(), "weldall-github-app-cli-"));
  process.chdir(root);
  await write(base);
  await writeLock(root, newLock(base));
});
afterEach(async () => {
  process.chdir(previous);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it("sends GitHub App connectors and their shared key connection exactly as the server parses them", async () => {
  await write({
    ...base,
    connectors: { github: connector },
    sharedConnections: { github_key: sharedConnection },
  });
  const loaded = await loadWorkspace(root);
  const wire = serverManifest(loaded.manifest, loaded.lock!) as any;
  expect(wire.connectors.github.provider).toEqual(serverSchema.parse(provider));
  expect(wire.connectors.github.provider).toMatchObject({
    appId: "123456",
    apiBaseUrl: "https://api.github.com",
  });
  expect(wire.connectors.github.provider).not.toHaveProperty("allowedScopes");
  expect(wire.sharedConnections.github_key).toEqual(
    sharedConnectionConfigSchema.parse(sharedConnection),
  );
});

it("leaves the choice of available setup modes to the server", async () => {
  await write({
    ...base,
    connectors: {
      github: { ...connector, provider: { ...provider, setupMode: "weldall-managed" } },
    },
  });
  await expect(loadWorkspace(root)).resolves.toBeDefined();
});

it.each([
  { privateKey: "do-not-expose-secret-marker" },
  { apiBaseUrl: "https://example.com" },
  { apiBaseUrl: "https://git.example.com/api/v3" },
  { setupMode: "automatic" },
  { templates: [] },
])("rejects invalid GitHub App configuration locally without echoing values: %j", async (patch) => {
  await write({
    ...base,
    connectors: { github: { ...connector, provider: { ...provider, ...patch } } },
  });
  const error = await loadWorkspace(root).catch((caught: unknown) => caught);
  expect(String(error)).toContain("Invalid GitHub App provider configuration");
  expect(String(error)).not.toContain("do-not-expose-secret-marker");
});

it.each([
  ["connector", { connectors: { github: connector } }],
  ["shared key connection", { sharedConnections: { github_key: sharedConnection } }],
])("rejects a GitHub App %s on a server without Git host support", async (_name, extra) => {
  await write({ ...base, ...extra });
  const { manifest } = await loadWorkspace(root);
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      issuer: manifest.workspace.issuer,
      token_endpoint: `${manifest.workspace.issuer}/api/auth/oauth2/token`,
      weldall_iac: {
        endpoint: `${manifest.workspace.issuer}/api/iac/v1`,
        installationId,
        scope: "weldall:iac",
        features: ["mcp", "mcp-discovery-v1", "iac-ui-secrets-v1"],
      },
    }),
  );
  await expect(IacClient.connect(manifest, null)).rejects.toThrow(
    "does not support Git host connectors",
  );
  expect(fetcher).toHaveBeenCalledOnce();
});

it("declares the GitHub App connector and its key connection in the published manifest schema", async () => {
  const schema = JSON.parse(
    await readFile(
      new URL("../../../schemas/weldall-manifest-v1.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const connector = schema.properties.connectors.additionalProperties;
  expect(connector.properties.type.enum).toContain("github-app");
  const branch = connector.properties.provider.oneOf.find(
    (candidate: { properties?: Record<string, unknown> }) => candidate.properties?.reviewerTeam,
  );
  expect(Object.keys(branch.properties).sort()).toEqual(Object.keys(serverSchema.shape).sort());
  expect(branch.required.sort()).toEqual(
    Object.entries(serverSchema.shape)
      .filter(([, field]) => !field.safeParse(undefined).success)
      .map(([key]) => key)
      .sort(),
  );
  expect(branch.properties.setupMode.enum).toEqual(serverSchema.shape.setupMode.options);
  expect(
    schema.properties.sharedConnections.additionalProperties.properties.provider.oneOf.map(
      (candidate: { properties: { kind: { const: string } } }) => candidate.properties.kind.const,
    ),
  ).toEqual(["service-account-api-key", "github-app-private-key"]);
});
