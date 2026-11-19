import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(async () => ({})) }));
vi.mock("@weldall/db", () => ({ db: { auditEvent: { create: mocks.create } }, Prisma: {} }));

import { AUDIT_EVENT_TYPES } from "../src/lib/audit";
import { prismaAuditWriter, type AuditEventInput } from "../src/server/audit/service";
import {
  GIT_AUDIT_LIMITS,
  TRUNCATION_MARKER,
  gitMetadataSchemas,
  truncateText,
} from "../src/server/audit/git-metadata";
import { WELDALL_GIT_CREDENTIAL_PREFIX } from "../src/server/observability/redaction";

/**
 * The metadata schemas of the Git audit events a Git app reports through the app host API
 * (`app-host/audit.ts`); the reporting path itself is covered in `app-host-db.test.ts`.
 */
const sha = (digit: string) => digit.repeat(40);
const zero = sha("0");
const target = {
  resourceId: "resource-1",
  appId: "app-1",
  repositoryOwner: "acme",
  repositoryName: "expense-tracker",
};
const transfer = {
  credentialId: "cred-1",
  requestBytes: 4_096,
  responseBytes: 512,
  durationMs: 812,
  upstreamStatus: 200,
};
const installationToken = "gh" + "s_" + "x".repeat(36);

const write = (eventType: AuditEventInput["eventType"], metadata: Record<string, unknown>) =>
  prismaAuditWriter.write({
    eventType,
    actorType: "user",
    actorId: "user-1",
    requestId: "req-1",
    outcome: eventType.endsWith(".denied")
      ? "denied"
      : eventType.endsWith(".failed")
        ? "failed"
        : "success",
    ...(eventType.endsWith(".denied") ? { reasonCode: "invalid_request" as const } : {}),
    ...(eventType.endsWith(".failed") ? { reasonCode: "internal_error" as const } : {}),
    metadata,
  });
/** The metadata the writer would insert for the n-th call. */
const stored = (index = 0) =>
  (mocks.create.mock.calls[index] as unknown as [{ data: { metadata: Record<string, any> } }])[0]
    .data.metadata;

beforeEach(() => mocks.create.mockClear());

describe("git audit metadata", () => {
  it("registers every git event type with a metadata schema", () => {
    const gitTypes = AUDIT_EVENT_TYPES.filter((type) => type.startsWith("git_"));
    expect(gitTypes.sort()).toEqual(Object.keys(gitMetadataSchemas).sort());
  });

  it("stores a created repository and lowercases commit ids", async () => {
    await write("git_repository.created", {
      ...target,
      repositoryId: "987",
      template: "next-starter",
      templateCommit: sha("A"),
      defaultBranch: "main",
      existingRepository: false,
      warnings: ["default_branch_unprotected"],
    });
    expect(stored()).toMatchObject({ ...target, templateCommit: sha("a") });
  });

  it("names the resource and accepts no connector", async () => {
    const rejected = { ...target, appId: null, reason: "Not allowed.", template: null };
    await write("git_repository.denied", rejected);
    expect(stored()).toEqual(rejected);
    await expect(
      write("git_repository.denied", { ...rejected, connectorId: "connector-1" }),
    ).rejects.toThrow();
    const { resourceId: _, ...withoutResource } = rejected;
    await expect(write("git_repository.denied", withoutResource)).rejects.toThrow();
  });

  it("truncates long branch names and reasons with a marker", async () => {
    await write("git_push.denied", {
      ...target,
      reason: `Pushing to the default branch is not allowed. ${"!".repeat(1_000)}`,
      refUpdates: [{ ref: `refs/heads/${"b".repeat(400)}`, oldCommit: sha("1"), newCommit: zero }],
      refUpdateCount: 1,
      credentialId: "cred-1",
      requestBytes: null,
      responseBytes: null,
      durationMs: null,
      upstreamStatus: null,
    });
    const metadata = stored();
    expect(metadata.refUpdates[0].ref).toHaveLength(GIT_AUDIT_LIMITS.ref);
    expect(metadata.refUpdates[0].ref.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(metadata.reason).toHaveLength(GIT_AUDIT_LIMITS.reason);
    expect(metadata.reason.startsWith("Pushing to the default branch")).toBe(true);
  });

  it("redacts credentials in free text before it is stored", async () => {
    await write("git_push.failed", {
      ...target,
      reason: `upstream said Authorization: Bearer ${installationToken} and ${WELDALL_GIT_CREDENTIAL_PREFIX}${"k".repeat(40)}`,
      refUpdates: [
        { ref: `refs/heads/${installationToken}`, oldCommit: zero, newCommit: sha("d") },
      ],
      refUpdateCount: 1,
      credentialId: null,
      requestBytes: null,
      responseBytes: null,
      durationMs: null,
      upstreamStatus: null,
    });
    const text = JSON.stringify(stored());
    expect(text).not.toContain(installationToken);
    expect(text).not.toContain("k".repeat(40));
    expect(stored().reason).toBe("upstream said Authorization: [***] and [***]");
    expect(stored().refUpdates[0].ref).toBe("refs/heads/[***]");
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
    expect(stored()).toEqual({ note: "remote https://[***]@github.com/a/b" });
  });

  it("rejects invalid commit ids, unknown fields and lists over their bound", () => {
    const schema = gitMetadataSchemas["git_push.completed"];
    const valid = { ...target, refUpdates: [], refUpdateCount: 0, ...transfer };
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
    expect(() =>
      gitMetadataSchemas["git_pull_request.opened"].parse({
        ...target,
        number: 1,
        webUrl: "https://github.com/acme/expense-tracker/pull/1",
        headBranch: "publish/1",
        baseBranch: "main",
        headCommit: zero,
        commits: Array.from({ length: GIT_AUDIT_LIMITS.commits + 1 }, () => zero),
        commitCount: GIT_AUDIT_LIMITS.commits + 1,
        existingPullRequest: false,
        warnings: [],
      }),
    ).toThrow();
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
