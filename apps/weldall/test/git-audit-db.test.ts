import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import { prismaAuditWriter } from "../src/server/audit/service";
import { gitMetadataSchemas, type GitAuditEventType } from "../src/server/audit/git-metadata";

const target = "postgresql://postgres@localhost:5433/postgres";
// Use the operator-approved local database or CI's existing disposable test service; never reset either here.
const approvedTarget =
  process.env.POSTGRES_URL === target ||
  /^postgresql:\/\/postgres@localhost:5433\/weldall_connector_test_[a-f0-9]{32}$/.test(
    process.env.POSTGRES_URL ?? "",
  ) ||
  (process.env.CI === "true" &&
    process.env.POSTGRES_URL === "postgresql://postgres:postgres@localhost:5432/postgres");
const prefix = `git-audit-${randomUUID()}`;
const actorId = `${prefix}-person`;
const appId = `${prefix}-app`;
const sha = "a".repeat(40);
const reported = {
  resourceId: `${prefix}-resource`,
  appId,
  repositoryOwner: "acme",
  repositoryName: "expense-tracker",
};
const transfer = {
  credentialId: `${prefix}-credential`,
  requestBytes: 10,
  responseBytes: 20,
  durationMs: 30,
  upstreamStatus: 200,
};
const rejected = { ...reported, reason: "refused for the test" };
const pushRejected = {
  ...rejected,
  refUpdates: [],
  refUpdateCount: 0,
  ...transfer,
};
const refUpdates = {
  refUpdates: [{ ref: "refs/heads/publish/1", oldCommit: "0".repeat(40), newCommit: sha }],
  refUpdateCount: 1,
};

/** Valid metadata for every Git event type a Git app reports. */
const metadata: Record<GitAuditEventType, Record<string, unknown>> = {
  "git_repository.created": {
    ...reported,
    repositoryId: "1",
    template: "starter",
    templateCommit: sha,
    defaultBranch: "main",
    existingRepository: false,
    warnings: [],
  },
  "git_repository.denied": { ...rejected, template: "starter" },
  "git_repository.failed": { ...rejected, template: "starter" },
  "git_push.forwarded": { ...reported, ...refUpdates, credentialId: transfer.credentialId },
  "git_push.completed": { ...reported, ...refUpdates, ...transfer },
  "git_push.denied": pushRejected,
  "git_push.failed": pushRejected,
  "git_fetch.completed": { ...reported, ...transfer },
  "git_fetch.denied": { ...rejected, ...transfer },
  "git_fetch.failed": { ...rejected, ...transfer },
  "git_pull_request.opened": {
    ...reported,
    number: 1,
    webUrl: "https://github.com/acme/expense-tracker/pull/1",
    headBranch: "publish/1",
    baseBranch: "main",
    headCommit: sha,
    commits: [sha],
    commitCount: 1,
    existingPullRequest: false,
    warnings: [],
  },
  "git_pull_request.denied": { ...rejected, headBranch: "publish/1" },
  "git_pull_request.failed": { ...rejected, headBranch: "publish/1" },
  "git_credential.issued": {
    ...reported,
    credentialId: transfer.credentialId,
    access: "write",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  },
  "git_credential.denied": { ...rejected, access: "write" },
  "git_credential.failed": { ...rejected, access: "write" },
  "git_host.checked": {
    resourceId: reported.resourceId,
    repositoryOwner: null,
    repositoryName: null,
    passed: 3,
    failed: 1,
    unverifiable: 0,
    failedChecks: ["host.reviewer-team"],
    durationMs: 40,
  },
};

describe.skipIf(!approvedTarget)("git audit events on disposable PostgreSQL", () => {
  afterAll(async () => {
    await db.auditEvent.deleteMany({ where: { actorId } });
  });

  it("stores every git event type under the database's event type constraint", async () => {
    if (!approvedTarget) throw new Error("Unsafe database target");
    const types = Object.keys(gitMetadataSchemas) as GitAuditEventType[];
    for (const eventType of types) {
      const outcome = eventType.endsWith(".denied")
        ? "denied"
        : eventType.endsWith(".failed")
          ? "failed"
          : "success";
      await prismaAuditWriter.write({
        eventType,
        actorType: "user",
        actorId,
        requestId: prefix,
        outcome,
        ...(outcome === "denied" ? { reasonCode: "invalid_request" as const } : {}),
        ...(outcome === "failed" ? { reasonCode: "internal_error" as const } : {}),
        subjectType: "app",
        subjectId: appId,
        metadata: metadata[eventType],
      });
    }

    const rows = await db.auditEvent.findMany({ where: { actorId }, select: { eventType: true } });
    expect(rows.map((row) => row.eventType).sort()).toEqual([...types].sort());
  });
});
