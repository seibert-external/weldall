import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { cli, define } from "gunshi";
import { describe, expect, it, vi } from "vitest";
import { isIacMachineConfigured } from "../src/iac/client.js";
import { iacSubCommands } from "../src/iac/commands.js";

const jwk = (key: KeyObject) => key.export({ format: "jwk" });
const iacCommandNames = ["init", "validate", "plan", "up", "import", "unmanage", "state"];
const commandPattern = (name: string) => new RegExp(`\\b${name}\\b`);

const machineEnvironment = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    WELDALL_M2M_CLIENT_ID: "platform-ci",
    WELDALL_M2M_KID: "ci-2026",
    WELDALL_M2M_PRIVATE_JWK: JSON.stringify(jwk(privateKey)),
    WELDALL_M2M_PUBLIC_JWK: JSON.stringify(jwk(publicKey)),
  };
};

const renderHelp = async (args: string[], advertised: boolean) => {
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await cli(args, define({ name: "weldall", description: "root", run: () => undefined }), {
      name: "weldall",
      version: "0.0.0",
      description: "test",
      strict: true,
      subCommands: iacSubCommands(advertised),
      renderValidationErrors: null,
    });
    return output.mock.calls.flat().join("\n");
  } finally {
    output.mockRestore();
  }
};

describe("IaC machine credentials", () => {
  it("accepts a complete machine credential set", () => {
    expect(isIacMachineConfigured(machineEnvironment())).toBe(true);
  });

  it("rejects an environment without machine credentials", () => {
    expect(isIacMachineConfigured({})).toBe(false);
  });

  it("rejects a partial or malformed machine credential set", () => {
    const environment = machineEnvironment();
    expect(isIacMachineConfigured({ ...environment, WELDALL_M2M_CLIENT_ID: " " })).toBe(false);
    expect(isIacMachineConfigured({ ...environment, WELDALL_M2M_KID: "" })).toBe(false);
    expect(isIacMachineConfigured({ ...environment, WELDALL_M2M_PRIVATE_JWK: "not json" })).toBe(
      false,
    );
    expect(
      isIacMachineConfigured({ ...environment, WELDALL_M2M_PUBLIC_JWK: JSON.stringify({ kty: "RSA" }) }),
    ).toBe(false);
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    expect(
      isIacMachineConfigured({
        ...environment,
        WELDALL_M2M_PUBLIC_JWK: JSON.stringify({ ...jwk(publicKey), d: jwk(privateKey).d }),
      }),
    ).toBe(false);
  });
});

describe("IaC help visibility", () => {
  it("omits IaC commands from the root help listing without machine credentials", async () => {
    const help = await renderHelp(["--help"], false);
    expect(help).toContain("USAGE:");
    for (const name of iacCommandNames) expect(help).not.toMatch(commandPattern(name));
  });

  it("lists IaC commands in the root help when machine credentials exist", async () => {
    const help = await renderHelp(["--help"], true);
    for (const name of iacCommandNames) expect(help).toMatch(commandPattern(name));
  });

  it("keeps a hidden IaC command's own help available", async () => {
    const help = await renderHelp(["up", "--help"], false);
    expect(help).toContain("USAGE:");
    expect(help).toMatch(/\bweldall up\b/);
    expect(help).toContain("Atomically apply one native Weldall YAML snapshot");
  });
});
