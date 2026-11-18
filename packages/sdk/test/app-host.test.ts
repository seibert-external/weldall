import { describe, expect, it } from "vitest";
import {
  APP_HOST_AUDIT_EVENT_TYPES,
  appHostAuditEventRequestSchema,
  appHostCreateAppRequestSchema,
  appHostUpdateAppRequestSchema,
} from "../src/app-host.js";

const resource = "https://git.example.com/api";
const commit = "a".repeat(40);
const forwarded = {
  resource,
  eventId: "0f3c4f0e-6a1b-4c1e-9d55-6b2f3c0d9a10",
  eventType: "git_push.forwarded",
  subject: "user-1",
  appId: "cm3k9x2f80001",
  details: {
    refUpdates: [
      { ref: "refs/heads/weldall/publish-1", oldCommit: "0".repeat(40), newCommit: commit },
    ],
    refUpdateCount: 1,
    credentialId: null,
  },
};

describe("app host contract", () => {
  it("covers every Git audit event of the in-server path", () => {
    expect(APP_HOST_AUDIT_EVENT_TYPES).toHaveLength(17);
    expect(APP_HOST_AUDIT_EVENT_TYPES).toContain("git_push.forwarded");
    expect(APP_HOST_AUDIT_EVENT_TYPES).toContain("git_host.checked");
  });

  it("accepts a well-formed report and rejects unknown fields and events", () => {
    expect(appHostAuditEventRequestSchema.safeParse(forwarded).success).toBe(true);
    for (const report of [
      { ...forwarded, extra: 1 },
      { ...forwarded, details: { ...forwarded.details, token: "x" } },
      { ...forwarded, eventType: "skill.created" },
      // A success always names the person and the app.
      { ...forwarded, subject: null },
      { ...forwarded, appId: null },
      { ...forwarded, details: { ...forwarded.details, refUpdateCount: 0 } },
      { ...forwarded, eventId: "too-short" },
    ])
      expect(appHostAuditEventRequestSchema.safeParse(report).success).toBe(false);
  });

  it("lets a rejection name either the app or the repository", () => {
    const denied = {
      resource,
      eventId: forwarded.eventId,
      eventType: "git_fetch.denied",
      subject: null,
      appId: null,
      repository: { owner: "acme-apps", name: "app-x" },
      reason: "Unknown credential.",
      details: {
        credentialId: null,
        requestBytes: null,
        responseBytes: null,
        durationMs: null,
        upstreamStatus: null,
      },
    };
    expect(appHostAuditEventRequestSchema.safeParse(denied).success).toBe(true);
    expect(
      appHostAuditEventRequestSchema.safeParse({ ...denied, appId: "cm3k9x2f80001" }).success,
    ).toBe(false);
  });

  it("accepts only https links without credentials and at least one change", () => {
    const app = {
      resource,
      owner: "user-1",
      name: "tracker",
      purpose: "Tracks expenses",
      repository: { owner: "acme-apps", name: "app-tracker", id: null, webUrl: null },
      defaultBranch: "main",
      template: { name: "react", commit: null },
    };
    expect(appHostCreateAppRequestSchema.safeParse(app).success).toBe(true);
    expect(
      appHostCreateAppRequestSchema.safeParse({
        ...app,
        repository: { ...app.repository, webUrl: "http://git.example.com/x" },
      }).success,
    ).toBe(false);
    expect(appHostUpdateAppRequestSchema.safeParse({ resource }).success).toBe(false);
    expect(
      appHostUpdateAppRequestSchema.safeParse({
        resource,
        links: { live: "https://user:secret@app.example.com/" },
      }).success,
    ).toBe(false);
    expect(
      appHostUpdateAppRequestSchema.safeParse({ resource, links: { preview: null } }).success,
    ).toBe(true);
  });
});
