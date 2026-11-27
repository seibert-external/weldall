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
 * The metadata schemas of the audit events an app host reports through the app host API
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
  it("registers every event type an app host reports with a metadata schema", () => {
    const gitTypes = AUDIT_EVENT_TYPES.filter(
      (type) =>
        type.startsWith("git_") ||
        type.startsWith("app_confirmation.") ||
        type.startsWith("app_owner."),
    );
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

  it("stores the metadata of the other event types as given, token-shaped or not", async () => {
    // Only Git free text is redacted; these values were stored unredacted before and still are.
    const writeAs = (eventType: AuditEventInput["eventType"], metadata: unknown) =>
      prismaAuditWriter.write({
        eventType,
        actorType: "user",
        actorId: "user-1",
        requestId: "req-1",
        outcome: "success",
        metadata,
      });
    const digest = "d".repeat(64);
    const cases: [AuditEventInput["eventType"], Record<string, unknown>][] = [
      [
        "machine_key.registered",
        { clientId: "m", kid: "k", thumbprint: `gh${"s_"}${"T".repeat(39)}`, revokedAt: null },
      ],
      [
        "machine_key.revoked",
        {
          clientId: "m",
          kid: "k",
          thumbprint: `${"T".repeat(20)}-gh${"p_"}${"a".repeat(18)}`,
          revokedAt: new Date(0).toISOString(),
        },
      ],
      [
        "cli_settings.updated",
        {
          before: { appendixSha256: digest, logoUrl: "", version: 1 },
          after: {
            appendixSha256: digest,
            logoUrl: `https://user:${"p".repeat(20)}@cdn.example.com/logo.svg`,
            version: 2,
          },
        },
      ],
      [
        "resource_scopes.created",
        {
          entityType: "scope_definition",
          source: "admin_api",
          resourceIdentifier: null,
          before: null,
          after: {
            key: "acme:read",
            description: `Sends Authorization: Bearer ${"b".repeat(20)}1 upstream.`,
            isSystem: false,
            version: 1,
          },
          addedScopes: ["acme:read"],
          changedScopes: [],
          removedScopes: [],
          contentDigest: digest,
        },
      ],
      [
        "iac.plan.generated",
        { note: `remote https://x-access-token:${"z".repeat(20)}@github.com/a/b` },
      ],
    ];
    for (const [index, [eventType, metadata]] of cases.entries()) {
      await writeAs(eventType, metadata);
      expect(stored(index)).toEqual(metadata);
    }
  });

  it("never redacts identifiers in Git metadata", async () => {
    const credentialId = `${WELDALL_GIT_CREDENTIAL_PREFIX}${"k".repeat(20)}`;
    const identifiers = {
      resourceId: `gh${"s_"}resource1234`,
      appId: `gh${"p_"}app12345678`,
      repositoryOwner: `gh${"o_"}owner1234`,
      repositoryName: `gh${"u_"}name12345`,
    };
    const metadata = {
      ...identifiers,
      credentialId,
      access: "write",
      expiresAt: new Date(0).toISOString(),
    };
    await write("git_credential.issued", metadata);
    expect(stored()).toEqual(metadata);
    await write("git_push.completed", {
      ...identifiers,
      refUpdates: [],
      refUpdateCount: 0,
      ...transfer,
      credentialId,
    });
    expect(stored(1)).toMatchObject({ ...identifiers, credentialId });
  });

  it.each([
    ["a lone high surrogate", "bad \ud800 ref", "bad \ufffd ref"],
    ["a lone low surrogate", "bad \udfff ref", "bad \ufffd ref"],
    ["reversed surrogates", "\udc00\ud800", "\ufffd\ufffd"],
    ["NUL", "bad\u0000ref", "bad ref"],
    ["only control characters", "\u0000\u0001", "-"],
    ["an intact pair", "ok 😀", "ok 😀"],
  ])("makes free text with %s storable in every free-text field", async (_, input, expected) => {
    const rejected = { ...target, reason: input };
    await write("git_pull_request.denied", { ...rejected, headBranch: input });
    expect(stored(0)).toMatchObject({ reason: expected, headBranch: expected });
    await write("git_repository.created", {
      ...target,
      repositoryId: null,
      template: input,
      templateCommit: null,
      defaultBranch: input,
      existingRepository: false,
      warnings: [],
    });
    expect(stored(1)).toMatchObject({ template: expected, defaultBranch: expected });
    await write("git_push.forwarded", {
      ...target,
      refUpdates: [{ ref: input, oldCommit: zero, newCommit: sha("e") }],
      refUpdateCount: 1,
      credentialId: null,
    });
    expect(stored(2).refUpdates[0].ref).toBe(expected);
    await write("git_pull_request.opened", {
      ...target,
      number: 1,
      webUrl: "https://github.com/acme/expense-tracker/pull/1",
      headBranch: input,
      baseBranch: input,
      headCommit: zero,
      commits: [],
      commitCount: 0,
      existingPullRequest: false,
      warnings: [],
    });
    expect(stored(3)).toMatchObject({ headBranch: expected, baseBranch: expected });
    // JSON keeps no lone surrogate escape (PostgreSQL's JSONB refuses `\ud800`) and no NUL.
    for (let index = 0; index < 4; index += 1)
      expect(JSON.stringify(stored(index))).not.toMatch(/\\u(?:d[89a-f][0-9a-f]{2}|0000)/i);
  });

  it("refuses counts beyond exact integers instead of storing them", () => {
    const schema = gitMetadataSchemas["git_push.completed"];
    const valid = { ...target, refUpdates: [], refUpdateCount: 0, ...transfer };
    expect(schema.safeParse({ ...valid, refUpdateCount: Number.MAX_SAFE_INTEGER }).success).toBe(
      true,
    );
    for (const value of [1e300, Number.MAX_SAFE_INTEGER + 1, Infinity])
      expect(schema.safeParse({ ...valid, refUpdateCount: value }).success).toBe(false);
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
