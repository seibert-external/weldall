import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkspace, newLock, serverManifest } from "../src/iac/manifest.js";
import { writeImportedFragment } from "../src/iac/commands.js";
import { scopeCatalog } from "../../weldall/src/server/connectors/providers/google/setup.js";

const offeredScopes = scopeCatalog.filter((scope) => !scope.required).map((scope) => scope.id);

describe("Google connector IaC scope parity", () => {
  it("keeps both JSON schema scope sets aligned with the server catalog", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL("../../../schemas/weldall-manifest-v1.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const provider =
      schema.properties.connectors.additionalProperties.properties.provider.oneOf.find(
        (branch: { required: string[] }) =>
          branch.required.length === 3 && branch.required.includes("defaultScopes"),
      );
    for (const property of ["allowedScopes", "defaultScopes"])
      expect(provider.properties[property].items.enum).toEqual(offeredScopes);
  });

  it.each([
    { scopes: offeredScopes, valid: true },
    ...offeredScopes.map((scope) => ({ scopes: [scope], valid: true })),
    ...[
      ...scopeCatalog.filter((scope) => scope.required).map((scope) => scope.id),
      "https://www.googleapis.com/auth/unknown",
      "https://www.googleapis.com/auth/drive.file",
    ].map((scope) => ({ scopes: [scope], valid: false })),
  ])("validates imported scopes $scopes (valid=$valid)", async ({ scopes, valid }) => {
    const root = await mkdtemp(join(tmpdir(), "weldall-google-iac-"));
    try {
      await writeFile(
        join(root, "weldall.yml"),
        JSON.stringify({
          apiVersion: "weldall.dev/v1",
          workspace: { name: "test", issuer: "https://weldall.example.com" },
          include: ["weldall/imports/*.yml"],
        }),
      );
      const provider = { clientId: "client", allowedScopes: scopes, defaultScopes: scopes };
      await writeImportedFragment(
        join(root, "weldall/imports/connector-google.yml"),
        JSON.stringify({
          connectors: {
            google: {
              key: "google",
              name: "Google",
              type: "google",
              enabled: true,
              envelopeProvider: "OPENBAO",
              requiredScopes: [],
              provider,
            },
          },
        }),
      );
      if (!valid) {
        await expect(loadWorkspace(root)).rejects.toThrow("Invalid Google provider scopes");
        return;
      }
      const loaded = await loadWorkspace(root);
      const manifest = serverManifest(loaded.manifest, newLock(loaded.manifest));
      expect(manifest.connectors.google.provider).toEqual({
        ...provider,
        allowedScopes: [...scopes].sort(),
        defaultScopes: [...scopes].sort(),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
