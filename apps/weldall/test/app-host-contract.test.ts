import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_HOST_AUDIT_EVENT_TYPES, APP_HOST_SCOPE } from "@weldall/sdk";
import { APP_HOST_SCOPE_KEY, isMachineOnlySystemScope } from "@weldall/db";
import { AUDIT_EVENT_TYPES } from "../src/lib/audit";
import { gitMetadataSchemas } from "../src/server/audit/git-metadata";
import { WELDALL_GIT_CREDENTIAL_PREFIX } from "../src/server/observability/redaction";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
/** The rule list of a redaction module, from its declaration to the closing bracket. */
const credentialRules = (text: string) => {
  const start = text.indexOf("const credentialRules");
  const end = text.indexOf("\n];\n", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
};

describe("app host contract in @weldall/sdk", () => {
  it("lets a Git app report exactly the Git audit events Weldall records", () => {
    expect([...APP_HOST_AUDIT_EVENT_TYPES].sort()).toEqual(Object.keys(gitMetadataSchemas).sort());
    for (const type of APP_HOST_AUDIT_EVENT_TYPES) expect(AUDIT_EVENT_TYPES).toContain(type);
  });

  it("names the machine-only system scope the server enforces", () => {
    expect(APP_HOST_SCOPE).toBe(APP_HOST_SCOPE_KEY);
    expect(isMachineOnlySystemScope(APP_HOST_SCOPE)).toBe(true);
  });
});

describe("redaction shared with the Git app", () => {
  // A Git app reports free text that Weldall redacts again before storing it; both must recognise
  // the same credentials, including the Git app's own git credential.
  it("recognises the same credential shapes as apps/git-app", () => {
    expect(credentialRules(source("../src/server/observability/redaction.ts"))).toBe(
      credentialRules(source("../../git-app/src/redaction.ts")),
    );
  });

  it("uses the Git app's git credential prefix", () => {
    const declared = /export const WELDALL_GIT_CREDENTIAL_PREFIX = "([^"]+)";/.exec(
      source("../../git-app/src/hosts/git-host.ts"),
    );
    expect(declared?.[1]).toBe(WELDALL_GIT_CREDENTIAL_PREFIX);
  });
});
