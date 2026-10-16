import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWorkspace, newLock, serverManifest, writeLock } from "../src/iac/manifest.js";
import { IacClient } from "../src/iac/client.js";
import { iacImportCommand, iacUpCommand } from "../src/iac/commands.js";
import {
  sharedConnectionConfigSchema,
  groupProviderConfigSchema,
  loginProviderConfigSchema,
} from "../../weldall/src/server/domain/secret-primitive-contracts.js";

// Compare the public wire contracts without loading the server's database-backed manifest parser.
const serverSchemas = {
  sharedConnections: sharedConnectionConfigSchema,
  groupProviders: groupProviderConfigSchema,
  loginProviders: loginProviderConfigSchema,
};

const publicValues = {
  sharedConnections: {
    key: "bot",
    connectorKey: "atlassian",
    name: "Bot",
    enabled: false,
    useScopes: ["team:use"],
    credentialManagerEmail: "admin@example.com",
    serviceAccountLabel: "Service account",
    provider: { kind: "service-account-api-key", cloudIds: [] },
  },
  groupProviders: {
    key: "directory",
    name: "Directory",
    adapterType: "management-api-v1",
    baseUrl: "https://directory.example.com",
    enabled: false,
  },
  loginProviders: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "SSO",
    buttonLabel: "Login",
    buttonColor: "#000000",
    issuer: "https://id.example.com",
    clientId: "client",
    tokenEndpointAuthMethod: "client_secret_post",
    enabled: false,
  },
};
const base = {
  apiVersion: "weldall.dev/v1" as const,
  workspace: { name: "test", issuer: "https://weldall.example.com" },
};
let root: string, previous: string;
beforeEach(async () => {
  previous = process.cwd();
  root = await mkdtemp(join(tmpdir(), "weldall-secret-cli-"));
  process.chdir(root);
  await writeFile(join(root, "weldall.yml"), stringify(base));
  await writeLock(root, newLock(base));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  process.chdir(previous);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it("distinguishes omitted capabilities from explicitly empty deletion sections", async () => {
  const old = await loadWorkspace(root);
  expect(serverManifest(old.manifest, old.lock!)).not.toHaveProperty("sharedConnections");
  await writeFile(
    join(root, "weldall.yml"),
    stringify({ ...base, sharedConnections: {}, groupProviders: {}, loginProviders: {} }),
  );
  const loaded = await loadWorkspace(root);
  expect(serverManifest(loaded.manifest, loaded.lock!)).toMatchObject({
    sharedConnections: {},
    groupProviders: {},
    loginProviders: {},
  });
});
describe.each(Object.entries(publicValues))("%s public contract", (section, value) => {
  it("canonicalizes identically to the server, including defaults", async () => {
    await writeFile(
      join(root, "weldall.yml"),
      stringify({ ...base, [section]: { fixture: value } }),
    );
    const loaded = await loadWorkspace(root);
    const wire = serverManifest(loaded.manifest, loaded.lock!);
    expect(wire).toHaveProperty(
      `${section}.fixture`,
      serverSchemas[section as keyof typeof serverSchemas].parse(value),
    );
  });
  it("rejects a secret locally without printing its value", async () => {
    const secret = "do-not-expose-secret-marker";
    await writeFile(
      join(root, "weldall.yml"),
      stringify({ ...base, [section]: { fixture: { ...value, clientSecret: secret } } }),
    );
    await expect(loadWorkspace(root)).rejects.toThrow("secrets and unknown fields are forbidden");
    try {
      await loadWorkspace(root);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
  it("rejects unsupported servers before requesting a token or mutating", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        issuer: base.workspace.issuer,
        token_endpoint: `${base.workspace.issuer}/token`,
        weldall_iac: {
          endpoint: `${base.workspace.issuer}/api/iac/v1`,
          installationId: "id",
          scope: "weldall:iac",
          features: ["mcp"],
        },
      }),
    );
    await expect(IacClient.connect({ ...base, [section]: {} }, null)).rejects.toThrow(
      "Upgrade the server",
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("imports a complete public fragment and lock without overwriting existing content", async () => {
    const kind = {
      sharedConnections: "sharedConnection",
      groupProviders: "groupProvider",
      loginProviders: "loginProvider",
    }[section]!;
    const identity = "id" in value ? value.id : value.key;
    const request = vi.fn(async (path: string) =>
      path === "/import"
        ? { state: value, revision: 1 }
        : {
            workspace: { ...(await loadWorkspace(root)).lock!.workspace, revision: 1 },
            objects: [
              {
                address: `${kind}.fixture`,
                kind,
                identity,
                objectId: "original-id",
                observedVersion: 7,
              },
            ],
          },
    );
    vi.spyOn(IacClient, "connect").mockResolvedValue({
      installationId: "test-installation",
      request,
    } as unknown as IacClient);
    await (iacImportCommand as any).run({ values: { kind, identity, as: `${kind}.fixture` } });
    const loaded = await loadWorkspace(root);
    expect((loaded.manifest as any)[section].fixture).toEqual(value);
    expect(loaded.lock!.objects[`${kind}.fixture`]).toMatchObject({
      objectId: "original-id",
      observedVersion: 7,
    });
    const before = await readFile(join(root, "weldall.lock.yml"), "utf8");
    expect(before).not.toContain("clientSecret");
  });
});
it.each([undefined, "b".repeat(64)])(
  "--yes never implies identity authority approval (%s)",
  async (approval) => {
    const request = vi.fn(async () => ({
      digest: "a".repeat(64),
      configDigest: "c".repeat(64),
      revision: 0,
      actions: [
        {
          action: "update",
          address: "loginProvider.sso",
          identity: "sso",
          requiresAuthorityConfirmation: true,
        },
      ],
      blockers: [],
    }));
    vi.spyOn(IacClient, "connect").mockResolvedValue({ request } as unknown as IacClient);
    await expect(
      (iacUpCommand as any).run({ values: { yes: true, acknowledgeAuthority: approval } }),
    ).rejects.toThrow("Explicit identity authority approval required");
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it("sends only the exact explicit plan digest as authority approval", async () => {
  const lock = (await loadWorkspace(root)).lock!;
  const request = vi.fn(async (path: string) =>
    path === "/plan"
      ? {
          digest: "a".repeat(64),
          configDigest: "c".repeat(64),
          revision: 0,
          actions: [
            {
              action: "update",
              address: "loginProvider.sso",
              identity: "sso",
              requiresAuthorityConfirmation: true,
            },
          ],
          blockers: [],
        }
      : path === "/apply"
        ? { resultingRevision: 1 }
        : { workspace: { ...lock.workspace, revision: 1 }, objects: [] },
  );
  vi.spyOn(IacClient, "connect").mockResolvedValue({
    request,
    installationId: "test",
  } as unknown as IacClient);
  await (iacUpCommand as any).run({ values: { yes: true, acknowledgeAuthority: "a".repeat(64) } });
  expect(request).toHaveBeenCalledWith(
    "/apply",
    "POST",
    expect.objectContaining({ authorityConfirmation: "a".repeat(64), planDigest: "a".repeat(64) }),
  );
});
