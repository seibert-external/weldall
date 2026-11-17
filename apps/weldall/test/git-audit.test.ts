import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(async () => ({})) }));
vi.mock("@weldall/db", () => ({ db: { auditEvent: { create: mocks.create } }, Prisma: {} }));

import { AUDIT_EVENT_TYPES } from "../src/lib/audit";
import { prismaAuditWriter } from "../src/server/audit/service";
import {
  GIT_AUDIT_LIMITS,
  TRUNCATION_MARKER,
  gitMetadataSchemas,
  truncateText,
} from "../src/server/audit/git-metadata";
import {
  writeGitCredentialAudit,
  writeGitFetchAudit,
  writeGitPullRequestAudit,
  writeGitPushAudit,
  writeGitRepositoryAudit,
} from "../src/server/connectors/git-audit";
import { WELDALL_GIT_CREDENTIAL_PREFIX } from "../src/server/connectors/git-host";

const actor = { id: "user-1", email: "Person@Example.com", requestId: "req-1" };
const target = {
  connectorId: "connector-1",
  appId: "app-1",
  repository: { owner: "acme", name: "expense-tracker" },
};
const sha = (digit: string) => digit.repeat(40);
const zero = sha("0");
const transfer = {
  credentialId: "cred-1",
  requestBytes: 4_096,
  responseBytes: 512,
  durationMs: 812.4,
  upstreamStatus: 200,
};
const installationToken = "gh" + "s_" + "x".repeat(36);

/** The row the writer would insert for the n-th call. */
const written = (index = 0) =>
  (mocks.create.mock.calls[index] as unknown as [{ data: Record<string, any> }])[0].data;

beforeEach(() => mocks.create.mockClear());

describe("git audit events", () => {
  it("registers every git event type with a metadata schema", () => {
    const gitTypes = AUDIT_EVENT_TYPES.filter((type) => type.startsWith("git_"));
    expect(gitTypes.sort()).toEqual(Object.keys(gitMetadataSchemas).sort());
  });

  it("writes a created repository with the person, connector and app", async () => {
    await writeGitRepositoryAudit({
      actor,
      outcome: "success",
      ...target,
      repositoryId: "987",
      template: "next-starter",
      templateCommit: sha("A"),
      defaultBranch: "main",
      existingRepository: false,
      warnings: ["default_branch_unprotected"],
    });
    expect(written()).toMatchObject({
      eventType: "git_repository.created",
      actorType: "user",
      actorId: "user-1",
      actorEmail: "person@example.com",
      outcome: "success",
      subjectType: "app",
      subjectId: "app-1",
      metadata: {
        connectorId: "connector-1",
        appId: "app-1",
        repositoryOwner: "acme",
        repositoryName: "expense-tracker",
        repositoryId: "987",
        template: "next-starter",
        templateCommit: sha("a"),
        defaultBranch: "main",
        existingRepository: false,
        warnings: ["default_branch_unprotected"],
      },
    });
    expect(written()).not.toHaveProperty("reasonCode");
  });

  it("writes a denied repository creation before an app exists", async () => {
    await writeGitRepositoryAudit({
      actor,
      outcome: "denied",
      reason: "The connector's name prefix does not allow this name.",
      connectorId: "connector-1",
      repository: { owner: "acme", name: "x" },
      template: "next-starter",
    });
    expect(written()).toMatchObject({
      eventType: "git_repository.denied",
      outcome: "denied",
      reasonCode: "invalid_request",
      subjectType: "connector",
      subjectId: "connector-1",
      metadata: {
        appId: null,
        repositoryName: "x",
        template: "next-starter",
        reason: "The connector's name prefix does not allow this name.",
      },
    });
  });

  it("writes a completed push with its ref updates and transfer size", async () => {
    await writeGitPushAudit({
      actor,
      outcome: "success",
      ...target,
      ...transfer,
      refUpdates: [{ ref: "refs/heads/publish/1", oldCommit: zero, newCommit: sha("b") }],
    });
    expect(written()).toMatchObject({
      eventType: "git_push.completed",
      metadata: {
        refUpdates: [{ ref: "refs/heads/publish/1", oldCommit: zero, newCommit: sha("b") }],
        refUpdateCount: 1,
        credentialId: "cred-1",
        requestBytes: 4_096,
        responseBytes: 512,
        durationMs: 812,
        upstreamStatus: 200,
      },
    });
  });

  it("caps ref updates and keeps the full count", async () => {
    const refUpdates = Array.from({ length: GIT_AUDIT_LIMITS.refUpdates + 5 }, (_, index) => ({
      ref: `refs/heads/publish/${index}`,
      oldCommit: zero,
      newCommit: sha("c"),
    }));
    await writeGitPushAudit({ actor, outcome: "success", ...target, ...transfer, refUpdates });
    const { metadata } = written();
    expect(metadata.refUpdates).toHaveLength(GIT_AUDIT_LIMITS.refUpdates);
    expect(metadata.refUpdateCount).toBe(GIT_AUDIT_LIMITS.refUpdates + 5);
  });

  it("writes a denied push with its reason, truncating long branch names and reasons", async () => {
    const longBranch = `refs/heads/${"b".repeat(400)}`;
    await writeGitPushAudit({
      actor,
      outcome: "denied",
      ...target,
      credentialId: "cred-1",
      reason: `Pushing to the default branch is not allowed. ${"!".repeat(1_000)}`,
      refUpdates: [{ ref: longBranch, oldCommit: sha("1"), newCommit: sha("2") }],
    });
    const row = written();
    expect(row).toMatchObject({ eventType: "git_push.denied", reasonCode: "invalid_request" });
    expect(row.metadata.refUpdates[0].ref).toHaveLength(GIT_AUDIT_LIMITS.ref);
    expect(row.metadata.refUpdates[0].ref.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(row.metadata.reason).toHaveLength(GIT_AUDIT_LIMITS.reason);
    expect(row.metadata.reason.startsWith("Pushing to the default branch")).toBe(true);
    expect(row.metadata).toMatchObject({
      requestBytes: null,
      responseBytes: null,
      durationMs: null,
      upstreamStatus: null,
    });
  });

  it("writes completed and failed fetches", async () => {
    await writeGitFetchAudit({ actor, outcome: "success", ...target, ...transfer });
    await writeGitFetchAudit({
      actor,
      outcome: "failed",
      reason: "GitHub is unavailable.",
      ...target,
      credentialId: "cred-1",
      requestBytes: 200,
      upstreamStatus: 503,
    });
    expect(written(0)).toMatchObject({ eventType: "git_fetch.completed" });
    expect(written(0).metadata).not.toHaveProperty("refUpdates");
    expect(written(1)).toMatchObject({
      eventType: "git_fetch.failed",
      reasonCode: "internal_error",
      metadata: { reason: "GitHub is unavailable.", requestBytes: 200, upstreamStatus: 503 },
    });
  });

  it("writes an opened pull request with the commits it contains, capped", async () => {
    const commits = Array.from({ length: GIT_AUDIT_LIMITS.commits + 1 }, (_, index) =>
      index.toString(16).padStart(40, "0"),
    );
    await writeGitPullRequestAudit({
      actor,
      outcome: "success",
      ...target,
      number: 7,
      webUrl: "https://github.com/acme/expense-tracker/pull/7",
      headBranch: "publish/1",
      baseBranch: "main",
      headCommit: commits.at(-1)!,
      commits,
    });
    expect(written()).toMatchObject({
      eventType: "git_pull_request.opened",
      metadata: { number: 7, headBranch: "publish/1", commitCount: GIT_AUDIT_LIMITS.commits + 1 },
    });
    expect(written().metadata.commits).toHaveLength(GIT_AUDIT_LIMITS.commits);
  });

  it("writes an issued git credential without the credential itself", async () => {
    const expiresAt = new Date("2026-11-17T12:05:00.000Z");
    await writeGitCredentialAudit({
      actor: { ...actor, type: "machine", clientId: "client-1" },
      outcome: "success",
      ...target,
      credentialId: "cred-1",
      access: "write",
      expiresAt,
    });
    expect(written()).toMatchObject({
      eventType: "git_credential.issued",
      actorType: "machine",
      clientId: "client-1",
      metadata: { credentialId: "cred-1", access: "write", expiresAt: expiresAt.toISOString() },
    });
    expect(JSON.stringify(written())).not.toContain(WELDALL_GIT_CREDENTIAL_PREFIX);
  });

  it("writes a credential denial without connector or repository", async () => {
    await writeGitCredentialAudit({
      actor,
      outcome: "denied",
      reasonCode: "scope_not_granted",
      reason: "The person does not own this app.",
      access: "write",
    });
    const row = written();
    expect(row).toMatchObject({
      eventType: "git_credential.denied",
      reasonCode: "scope_not_granted",
      metadata: { connectorId: null, appId: null, repositoryOwner: null, access: "write" },
    });
    expect(row).not.toHaveProperty("subjectType");
  });

  it("redacts credentials in free text before it is stored", async () => {
    await writeGitPushAudit({
      actor,
      outcome: "failed",
      ...target,
      reason: `upstream said Authorization: Bearer ${installationToken} and ${WELDALL_GIT_CREDENTIAL_PREFIX}${"k".repeat(40)}`,
      refUpdates: [
        { ref: `refs/heads/${installationToken}`, oldCommit: zero, newCommit: sha("d") },
      ],
    });
    const stored = JSON.stringify(written());
    expect(stored).not.toContain(installationToken);
    expect(stored).not.toContain("k".repeat(40));
    expect(written().metadata.reason).toBe("upstream said Authorization: [***] and [***]");
    expect(written().metadata.refUpdates[0].ref).toBe("refs/heads/[***]");
  });

  it("redacts credentials in the metadata of every event type", async () => {
    await prismaAuditWriter.write({
      eventType: "iac.plan.generated",
      actorType: "user",
      actorId: "user-1",
      requestId: "req-1",
      outcome: "success",
      metadata: { note: `remote https://x-access-token:${"z".repeat(20)}@github.com/a/b` },
    });
    expect(written().metadata).toEqual({ note: "remote https://[***]@github.com/a/b" });
  });

  it("rejects invalid commit ids and keeps lists bounded at the schema", () => {
    const schema = gitMetadataSchemas["git_push.completed"];
    const valid = {
      connectorId: "c",
      appId: "a",
      repositoryOwner: "acme",
      repositoryName: "app",
      refUpdates: [],
      refUpdateCount: 0,
      ...transfer,
      durationMs: 1,
    };
    expect(schema.parse(valid)).toEqual(valid);
    expect(() =>
      schema.parse({
        ...valid,
        refUpdates: [{ ref: "refs/heads/x", oldCommit: "abc", newCommit: zero }],
      }),
    ).toThrow();
    expect(() =>
      schema.parse({
        ...valid,
        refUpdates: Array.from({ length: GIT_AUDIT_LIMITS.refUpdates + 1 }, () => ({
          ref: "refs/heads/x",
          oldCommit: zero,
          newCommit: zero,
        })),
      }),
    ).toThrow();
    expect(() => schema.parse({ ...valid, token: installationToken })).toThrow();
  });

  it.each([
    ["short text", "main", 10, "main"],
    ["text at the limit", "a".repeat(20), 20, "a".repeat(20)],
    [
      "long text",
      "a".repeat(30),
      20,
      `${"a".repeat(20 - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`,
    ],
    ["a split surrogate pair", `a${"😀".repeat(8)}`, 14, `a${TRUNCATION_MARKER}`],
  ])("truncates %s with a marker", (_, input, maximum, expected) => {
    expect(truncateText(input, maximum)).toBe(expected);
    expect(truncateText(input, maximum).length).toBeLessThanOrEqual(maximum);
  });
});
