import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadWorkspace, newLock, serverManifest, writeLock } from "../src/iac/manifest.js";
import { IacClient } from "../src/iac/client.js";
// Compare the public wire contract without loading the server's database-backed manifest parser.
import {
  forgejoBaseUrlProblem,
  forgejoConfigSchema as serverSchema,
} from "../../weldall/src/server/connectors/providers/forgejo/config.js";
import { sharedConnectionConfigSchema } from "../../weldall/src/server/domain/secret-primitive-contracts.js";
import { forgejoConfigSchema as cliSchema } from "../src/iac/forgejo.js";

const installationId = "00000000-0000-4000-8000-000000000001";
const base = {
  apiVersion: "weldall.dev/v1" as const,
  workspace: { name: "test", issuer: "https://weldall.example.com" },
};
const provider = {
  baseUrl: "https://forgejo.example.com",
  organization: "example-org",
  botUser: "weldall-bot",
  templates: [{ name: "react", repository: "example-org/react-starter" }],
  repositoryNamePrefix: "app-",
  reviewerTeam: "app-reviewers",
  setupMode: "customer-managed",
};
const connector = {
  key: "forgejo",
  name: "Forgejo",
  type: "forgejo",
  enabled: false,
  envelopeProvider: "LOCAL_ENV",
  requiredScopes: [],
  provider,
};
const sharedConnection = {
  key: "forgejo-bot",
  connectorKey: "forgejo",
  name: "Forgejo bot token",
  enabled: false,
  useScopes: ["git:publish"],
  credentialManagerEmail: "admin@example.com",
  serviceAccountLabel: "weldall-bot",
  provider: { kind: "forgejo-bot-token" },
};
let root: string, previous: string;
const write = (manifest: object) => writeFile(join(root, "weldall.yml"), stringify(manifest));
beforeEach(async () => {
  previous = process.cwd();
  root = await mkdtemp(join(tmpdir(), "weldall-forgejo-cli-"));
  process.chdir(root);
  await write(base);
  await writeLock(root, newLock(base));
});
afterEach(async () => {
  process.chdir(previous);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it("sends Forgejo connectors and their shared token connection exactly as the server parses them", async () => {
  await write({
    ...base,
    connectors: { forgejo: connector },
    sharedConnections: { forgejo_bot: sharedConnection },
  });
  const loaded = await loadWorkspace(root);
  const wire = serverManifest(loaded.manifest, loaded.lock!) as any;
  expect(wire.connectors.forgejo.provider).toEqual(serverSchema.parse(provider));
  expect(wire.connectors.forgejo.provider).toMatchObject({
    previewStatusContext: "weldall/preview",
    liveStatusContext: "weldall/live",
  });
  expect(wire.sharedConnections.forgejo_bot).toEqual(
    sharedConnectionConfigSchema.parse(sharedConnection),
  );
});

it("leaves the choice of available setup modes to the server", async () => {
  await write({
    ...base,
    connectors: {
      forgejo: { ...connector, provider: { ...provider, setupMode: "weldall-managed" } },
    },
  });
  await expect(loadWorkspace(root)).resolves.toBeDefined();
});

const invalidBaseUrls = [
  "http://forgejo.example.com",
  "https://user:do-not-expose-secret-marker@forgejo.example.com",
  "https://forgejo.example.com:3000",
  "https://forgejo.example.com/",
  "https://forgejo.example.com/?x=1",
  "https://127.0.0.1",
  "https://[::1]",
  "https://localhost",
  "https://forgejo.localhost",
  "https://forgejo.local",
  "https://forgejo",
  "https://metadata.google.internal",
  "https://localhost.",
  "https://forgejo.example.com.",
  "https://forgejo.example.com/api/../x",
];

it.each([
  { token: "do-not-expose-secret-marker" },
  ...invalidBaseUrls.map((baseUrl) => ({ baseUrl })),
  { setupMode: "automatic" },
  { templates: [] },
  { botUser: "-bot" },
])("rejects invalid Forgejo configuration locally without echoing values: %j", async (patch) => {
  await write({
    ...base,
    connectors: { forgejo: { ...connector, provider: { ...provider, ...patch } } },
  });
  const error = await loadWorkspace(root).catch((caught: unknown) => caught);
  expect(String(error)).toContain("Invalid Forgejo provider configuration");
  expect(String(error)).not.toContain("do-not-expose-secret-marker");
});

it("accepts the same base URLs as the server, including a sub-path", () => {
  for (const baseUrl of [
    "https://forgejo.example.com",
    "https://git.example.com/forgejo",
    ...invalidBaseUrls,
  ])
    expect(cliSchema.shape.baseUrl.safeParse(baseUrl).success, baseUrl).toBe(
      forgejoBaseUrlProblem(baseUrl) === null,
    );
});

it.each([
  ["connector", { connectors: { forgejo: connector } }],
  ["shared token connection", { sharedConnections: { forgejo_bot: sharedConnection } }],
])("rejects a Forgejo %s on a server without Git host support", async (_name, extra) => {
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

it("declares the Forgejo connector and its token connection in the published manifest schema", async () => {
  const schema = JSON.parse(
    await readFile(
      new URL("../../../schemas/weldall-manifest-v1.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const connector = schema.properties.connectors.additionalProperties;
  expect(connector.properties.type.enum).toContain("forgejo");
  const branch = connector.properties.provider.oneOf.find(
    (candidate: { properties?: Record<string, unknown> }) => candidate.properties?.botUser,
  );
  expect(Object.keys(branch.properties).sort()).toEqual(Object.keys(serverSchema.shape).sort());
  expect(branch.required.sort()).toEqual(
    Object.entries(serverSchema.shape)
      .filter(([, field]) => !field.safeParse(undefined).success)
      .map(([key]) => key)
      .sort(),
  );
  expect(branch.properties.setupMode.enum).toEqual(serverSchema.shape.setupMode.options);
  const pattern = new RegExp(branch.properties.baseUrl.pattern);
  expect(pattern.test("https://forgejo.example.com")).toBe(true);
  expect(pattern.test("https://git.example.com/forgejo")).toBe(true);
  for (const value of ["https://forgejo.example.com/", "https://forgejo:3000", "http://a.b"])
    expect(pattern.test(value), value).toBe(false);
});
