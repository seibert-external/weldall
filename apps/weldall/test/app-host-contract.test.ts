import { describe, expect, it } from "vitest";
import { APP_HOST_AUDIT_EVENT_TYPES, APP_HOST_SCOPE } from "@weldall/sdk";
import { APP_HOST_SCOPE_KEY, isMachineOnlySystemScope } from "@weldall/db";
import { AUDIT_EVENT_TYPES } from "../src/lib/audit";
import { gitMetadataSchemas } from "../src/server/audit/git-metadata";

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
