import { createHash } from "node:crypto";
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

// An app host (the registry) keeps a copy of this contract and of the example request in its own
// repository (`test/fixtures/app-host/audit-event-request.json`) and asserts there that its client
// sends exactly this body. No test here can read that repository, so nothing here proves the two
// copies are identical. The digest below only pins Weldall's own copy: a change to the fixture
// fails this test until the digest is updated, as a reminder to change the registry's copy too.
const FIXTURE_SHA256 = "a9cd73d473318545d639754bf7c19e020035373bf8be36cb9dccf90e03a85f2a";

describe("app host contract", () => {
  it("pins the example request to a fixed digest, so changing it is deliberate", () => {
    // When this fails, update the registry's copy in the same piece of work, then the digest.
    const digest = createHash("sha256")
      .update(
        readFileSync(new URL("./fixtures/app-host/audit-event-request.json", import.meta.url)),
      )
      .digest("hex");
    expect(digest).toBe(FIXTURE_SHA256);
  });

  it("accepts the example request the app host's client is tested to send", () => {
    const fixture = JSON.parse(source("./fixtures/app-host/audit-event-request.json"));
    expect(appHostAuditEventRequestSchema.parse(fixture)).toEqual(fixture);
  });

  it("lets an app host report exactly the audit events Weldall records for it", () => {
    expect([...APP_HOST_AUDIT_EVENT_TYPES].sort()).toEqual(Object.keys(gitMetadataSchemas).sort());
    const migration = source(
      "../../../packages/db/prisma/migrations/0026_app_host_audit_events/migration.sql",
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

  it("redacts the app host's git credential in reported text", () => {
    // Shape documented by the app host: `wgc_<key id>.<payload>.<mac>`.
    const credential = `wgc_k1.${"p".repeat(40)}.${"m".repeat(43)}`;
    expect(redactCredentials(`git said ${credential}`)).toBe(`git said ${REDACTION_PLACEHOLDER}`);
  });
});
