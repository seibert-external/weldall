import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_HOST_SCOPE_KEY, isMachineOnlySystemScope } from "@weldall/db";
import { AUDIT_EVENT_TYPES } from "../src/lib/audit";
import {
  APP_HOST_AUDIT_EVENT_TYPES,
  APP_HOST_SCOPE,
  appHostAuditEventRequestSchema,
} from "../src/server/app-host/contract";
import { gitMetadataSchemas } from "../src/server/audit/git-metadata";
import { redactCredentials, REDACTION_PLACEHOLDER } from "../src/server/observability/redaction";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// The Git app (seibert-external/weldall-git-app) keeps a copy of this contract and of the example
// request; it asserts there that its client sends exactly this body. No test can read the other
// repository, so these checks cover Weldall's side only.
describe("app host contract", () => {
  it("accepts the example request the Git app's client is tested to send", () => {
    const fixture = JSON.parse(source("./fixtures/app-host/audit-event-request.json"));
    expect(appHostAuditEventRequestSchema.parse(fixture)).toEqual(fixture);
  });

  it("lets a Git app report exactly the audit events Weldall records for it", () => {
    expect([...APP_HOST_AUDIT_EVENT_TYPES].sort()).toEqual(Object.keys(gitMetadataSchemas).sort());
    const migration = source(
      "../../../packages/db/prisma/migrations/0023_git_audit_events/migration.sql",
    );
    for (const type of APP_HOST_AUDIT_EVENT_TYPES) {
      expect(AUDIT_EVENT_TYPES).toContain(type);
      expect(migration).toContain(`'${type}'`);
    }
  });

  it("requires the app's repository on every success event that names an app", () => {
    const fixture = JSON.parse(source("./fixtures/app-host/audit-event-request.json"));
    const { repository: _repository, ...withoutRepository } = fixture;
    expect(appHostAuditEventRequestSchema.safeParse(withoutRepository).success).toBe(false);
    expect(appHostAuditEventRequestSchema.safeParse({ ...fixture, appId: null }).success).toBe(
      false,
    );
  });

  it("names the machine-only system scope the server enforces", () => {
    expect(APP_HOST_SCOPE).toBe(APP_HOST_SCOPE_KEY);
    expect(isMachineOnlySystemScope(APP_HOST_SCOPE)).toBe(true);
  });

  it("redacts the Git app's git credential in reported text", () => {
    // Shape documented by the Git app: `wgc_<key id>.<payload>.<mac>`.
    const credential = `wgc_k1.${"p".repeat(40)}.${"m".repeat(43)}`;
    expect(redactCredentials(`git said ${credential}`)).toBe(`git said ${REDACTION_PLACEHOLDER}`);
  });
});
