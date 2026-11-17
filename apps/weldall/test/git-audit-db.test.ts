import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@weldall/db";
import {
  writeGitCredentialAudit,
  writeGitFetchAudit,
  writeGitPullRequestAudit,
  writeGitPushAudit,
  writeGitPushForwardedAudit,
  writeGitRepositoryAudit,
} from "../src/server/connectors/git-audit";

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
const actor = { id: `${prefix}-person`, requestId: prefix };
const resolved = {
  connectorId: `${prefix}-connector`,
  appId: `${prefix}-app`,
  repository: { owner: "acme", name: "expense-tracker" },
};
const sha = "a".repeat(40);
const transfer = {
  credentialId: `${prefix}-credential`,
  requestBytes: 10,
  responseBytes: 20,
  durationMs: 30,
  upstreamStatus: 200,
};
const rejected = (outcome: "denied" | "failed") => ({
  actor,
  outcome,
  reason: `${outcome} for the test`,
  ...resolved,
});

describe.skipIf(!approvedTarget)("git audit events on disposable PostgreSQL", () => {
  afterAll(async () => {
    await db.auditEvent.deleteMany({ where: { actorId: actor.id } });
  });

  it("stores every git event type under the database's event type constraint", async () => {
    if (!approvedTarget) throw new Error("Unsafe database target");
    for (const outcome of ["denied", "failed"] as const) {
      await writeGitRepositoryAudit({ ...rejected(outcome), template: "starter" });
      await writeGitPushAudit({ ...rejected(outcome), refUpdates: [] });
      await writeGitFetchAudit(rejected(outcome));
      await writeGitPullRequestAudit({ ...rejected(outcome), headBranch: "publish/1" });
      await writeGitCredentialAudit({ ...rejected(outcome), access: "write" });
    }
    await writeGitRepositoryAudit({
      actor,
      outcome: "success",
      ...resolved,
      repositoryId: "1",
      template: "starter",
      templateCommit: sha,
      defaultBranch: "main",
      existingRepository: false,
      warnings: [],
    });
    await writeGitPushAudit({
      actor,
      outcome: "success",
      ...resolved,
      ...transfer,
      refUpdates: [{ ref: "refs/heads/publish/1", oldCommit: "0".repeat(40), newCommit: sha }],
    });
    await writeGitFetchAudit({ actor, outcome: "success", ...resolved, ...transfer });
    await writeGitPushForwardedAudit({
      actor,
      ...resolved,
      credentialId: transfer.credentialId,
      refUpdates: [{ ref: "refs/heads/publish/1", oldCommit: "0".repeat(40), newCommit: sha }],
    });
    await writeGitPullRequestAudit({
      actor,
      outcome: "success",
      ...resolved,
      number: 1,
      webUrl: "https://github.com/acme/expense-tracker/pull/1",
      headBranch: "publish/1",
      baseBranch: "main",
      headCommit: sha,
      commits: [sha],
    });
    await writeGitCredentialAudit({
      actor,
      outcome: "success",
      ...resolved,
      credentialId: `${prefix}-credential`,
      access: "write",
      expiresAt: new Date(Date.now() + 300_000),
    });

    const rows = await db.auditEvent.findMany({
      where: { actorId: actor.id },
      select: { eventType: true, subjectType: true, subjectId: true },
    });
    expect(rows.map((row) => row.eventType).sort()).toEqual(
      [
        "git_credential.denied",
        "git_credential.failed",
        "git_credential.issued",
        "git_fetch.completed",
        "git_fetch.denied",
        "git_fetch.failed",
        "git_pull_request.denied",
        "git_pull_request.failed",
        "git_pull_request.opened",
        "git_push.completed",
        "git_push.denied",
        "git_push.forwarded",
        "git_push.failed",
        "git_repository.created",
        "git_repository.denied",
        "git_repository.failed",
      ].sort(),
    );
    expect(rows.every((row) => row.subjectType === "app" && row.subjectId === resolved.appId)).toBe(
      true,
    );
  });
});
