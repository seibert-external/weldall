import type { Prisma } from "@weldall/db";
import type { AuditReasonCode } from "../../lib/audit";
import { prismaAuditWriter } from "../audit/service";
import {
  GIT_AUDIT_LIMITS,
  type GitAuditEventType,
  type GitAuditMetadata,
} from "../audit/git-metadata";
import type { ConnectorActor } from "./contracts";
import type { GitAccess, GitRepositoryRef } from "./git-host";

/**
 * Typed writers for the Git host audit events (repository creation, proxied push and fetch,
 * pull requests, git credentials). The person is the entry's actor; the connector, repository
 * and app registry entry go into the metadata. Every rejection is audited with its reason.
 */

interface GitAuditContext {
  actor: ConnectorActor;
  tx?: Prisma.TransactionClient;
}
/** A resolved repository on a Git host connector together with its app registry entry. */
interface GitTarget {
  connectorId: string;
  appId: string;
  repository: GitRepositoryRef;
}
/** Whatever was known when the operation was denied or failed. */
interface GitRejection {
  outcome: "denied" | "failed";
  /** Shown to administrators; credentials are redacted and long text is truncated. */
  reason: string;
  /** Defaults to `invalid_request` for denied and `internal_error` for failed. */
  reasonCode?: AuditReasonCode;
  connectorId?: string | null;
  appId?: string | null;
  repository?: GitRepositoryRef | null;
}
type GitAuditInput<Success, Rejected = object> = GitAuditContext &
  (({ outcome: "success" } & GitTarget & Success) | (GitRejection & Rejected));

export interface GitRefUpdate {
  /** Full ref name, e.g. `refs/heads/publish/...`. */
  ref: string;
  oldCommit: string;
  newCommit: string;
}
export interface GitTransfer {
  credentialId: string | null;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  upstreamStatus: number;
}

/** Keeps the first `maximum` entries and the full count. */
function capped<T>(items: readonly T[], maximum: number) {
  return { items: items.slice(0, maximum), count: items.length };
}

function targetMetadata(input: GitTarget | GitRejection) {
  return {
    connectorId: input.connectorId ?? null,
    appId: input.appId ?? null,
    repositoryOwner: input.repository?.owner ?? null,
    repositoryName: input.repository?.name ?? null,
  };
}

function write(
  input: GitAuditContext &
    (GitTarget | GitRejection) & { outcome: "success" | "denied" | "failed" },
  successEvent: GitAuditEventType,
  metadata: object,
) {
  const family = successEvent.slice(0, successEvent.indexOf("."));
  const eventType = (
    input.outcome === "success" ? successEvent : `${family}.${input.outcome}`
  ) as GitAuditEventType;
  const subject = input.appId
    ? { subjectType: "app", subjectId: input.appId }
    : input.connectorId
      ? { subjectType: "connector", subjectId: input.connectorId }
      : {};
  return prismaAuditWriter.write(
    {
      eventType,
      actorType: input.actor.type ?? "user",
      actorId: input.actor.id,
      ...(input.actor.email ? { actorEmail: input.actor.email } : {}),
      ...(input.actor.clientId ? { clientId: input.actor.clientId } : {}),
      requestId: input.actor.requestId,
      ...(input.actor.correlationId ? { correlationId: input.actor.correlationId } : {}),
      outcome: input.outcome,
      ...(input.outcome === "success"
        ? {}
        : {
            reasonCode:
              (input as GitRejection).reasonCode ??
              (input.outcome === "denied" ? "invalid_request" : "internal_error"),
          }),
      ...subject,
      metadata: {
        ...targetMetadata(input),
        ...(input.outcome === "success" ? {} : { reason: (input as GitRejection).reason }),
        ...metadata,
      },
    },
    input.tx,
  );
}

/** `git_repository.created` / `.denied` / `.failed` (step 3b). */
export function writeGitRepositoryAudit(
  input: GitAuditInput<
    {
      repositoryId: string | null;
      template: string;
      templateCommit: string | null;
      defaultBranch: string;
      /** True when the call resumed with a repository an earlier attempt had created. */
      existingRepository: boolean;
      /** Codes of prerequisite warnings for administrators, e.g. an unprotected default branch. */
      warnings: readonly string[];
    },
    { template?: string | null }
  >,
) {
  const metadata =
    input.outcome === "success"
      ? {
          repositoryId: input.repositoryId,
          template: input.template,
          templateCommit: input.templateCommit,
          defaultBranch: input.defaultBranch,
          existingRepository: input.existingRepository,
          warnings: capped(input.warnings, GIT_AUDIT_LIMITS.warnings).items,
        }
      : { template: input.template ?? null };
  return write(input, "git_repository.created", metadata);
}

/** `git_push.completed` / `.denied` / `.failed`: one entry per proxied push (step 3c). */
export function writeGitPushAudit(
  input: GitAuditInput<
    GitTransfer & { refUpdates: readonly GitRefUpdate[] },
    Partial<GitTransfer> & { refUpdates?: readonly GitRefUpdate[] }
  >,
) {
  const { items, count } = capped(input.refUpdates ?? [], GIT_AUDIT_LIMITS.refUpdates);
  return write(input, "git_push.completed", {
    refUpdates: items.map(({ ref, oldCommit, newCommit }) => ({ ref, oldCommit, newCommit })),
    refUpdateCount: count,
    ...transferMetadata(input),
  });
}

/**
 * `git_push.forwarded`: written before a push is forwarded to the host, so a push that the host
 * applies is attributable even if the client disconnects or the final entry cannot be written.
 * Throws when the entry cannot be stored; the proxy then forwards nothing.
 */
export function writeGitPushForwardedAudit(
  input: GitAuditContext &
    GitTarget & { credentialId: string | null; refUpdates: readonly GitRefUpdate[] },
) {
  const { items, count } = capped(input.refUpdates, GIT_AUDIT_LIMITS.refUpdates);
  return prismaAuditWriter.write({
    eventType: "git_push.forwarded",
    actorType: input.actor.type ?? "user",
    actorId: input.actor.id,
    ...(input.actor.email ? { actorEmail: input.actor.email } : {}),
    ...(input.actor.clientId ? { clientId: input.actor.clientId } : {}),
    requestId: input.actor.requestId,
    ...(input.actor.correlationId ? { correlationId: input.actor.correlationId } : {}),
    outcome: "success",
    subjectType: "app",
    subjectId: input.appId,
    metadata: {
      ...targetMetadata(input),
      refUpdates: items.map(({ ref, oldCommit, newCommit }) => ({ ref, oldCommit, newCommit })),
      refUpdateCount: count,
      credentialId: input.credentialId,
    },
  });
}

/** `git_fetch.completed` / `.denied` / `.failed`: one entry per proxied fetch or clone (step 3c). */
export function writeGitFetchAudit(input: GitAuditInput<GitTransfer, Partial<GitTransfer>>) {
  return write(input, "git_fetch.completed", transferMetadata(input));
}

function transferMetadata(input: Partial<GitTransfer>) {
  return {
    credentialId: input.credentialId ?? null,
    requestBytes: input.requestBytes ?? null,
    responseBytes: input.responseBytes ?? null,
    durationMs: input.durationMs === undefined ? null : Math.round(input.durationMs),
    upstreamStatus: input.upstreamStatus ?? null,
  };
}

/**
 * `git_pull_request.opened` / `.denied` / `.failed`, with the commits the pull request contains
 * at that moment, which may include commits others pushed on the host (step 3d).
 * Also written when an already open pull request of the branch is returned (`existingPullRequest`).
 */
export function writeGitPullRequestAudit(
  input: GitAuditInput<
    {
      number: number;
      webUrl: string;
      headBranch: string;
      baseBranch: string;
      headCommit: string;
      /** Null when the host could not list them. */
      commits: readonly string[] | null;
      /** Full number of commits when the host reports more than it lists; defaults to the list's length. */
      commitCount?: number;
      existingPullRequest?: boolean;
      warnings?: readonly string[];
    },
    { headBranch?: string | null }
  >,
) {
  if (input.outcome !== "success")
    return write(input, "git_pull_request.opened", { headBranch: input.headBranch ?? null });
  const { items, count } = capped(input.commits ?? [], GIT_AUDIT_LIMITS.commits);
  const metadata: Omit<
    GitAuditMetadata<"git_pull_request.opened">,
    "connectorId" | "appId" | "repositoryOwner" | "repositoryName"
  > = {
    number: input.number,
    webUrl: input.webUrl,
    headBranch: input.headBranch,
    baseBranch: input.baseBranch,
    headCommit: input.headCommit,
    commits: items,
    commitCount: input.commits === null ? null : Math.max(input.commitCount ?? count, count),
    existingPullRequest: input.existingPullRequest ?? false,
    warnings: capped(input.warnings ?? [], GIT_AUDIT_LIMITS.warnings).items,
  };
  return write(input, "git_pull_request.opened", metadata);
}

/** `git_credential.issued` / `.denied` / `.failed`; never records the credential itself (step 3c). */
export function writeGitCredentialAudit(
  input: GitAuditInput<
    { credentialId: string; access: GitAccess; expiresAt: Date },
    { access?: GitAccess | null }
  >,
) {
  return write(
    input,
    "git_credential.issued",
    input.outcome === "success"
      ? {
          credentialId: input.credentialId,
          access: input.access,
          expiresAt: input.expiresAt.toISOString(),
        }
      : { access: input.access ?? null },
  );
}

/** `git_host.checked`: an administrator ran the connect checklist of a Git host connector (step 3g). */
export function writeGitHostCheckAudit(input: {
  actor: ConnectorActor;
  connectorId: string;
  /** The existing app repository the checks used, if any. */
  repository: GitRepositoryRef | null;
  checks: readonly { id: string; state: "pass" | "fail" | "unverifiable" }[];
  durationMs: number;
}) {
  const count = (state: string) => input.checks.filter((check) => check.state === state).length;
  return prismaAuditWriter.write({
    eventType: "git_host.checked",
    actorType: input.actor.type ?? "user",
    actorId: input.actor.id,
    ...(input.actor.email ? { actorEmail: input.actor.email } : {}),
    ...(input.actor.clientId ? { clientId: input.actor.clientId } : {}),
    requestId: input.actor.requestId,
    ...(input.actor.correlationId ? { correlationId: input.actor.correlationId } : {}),
    outcome: "success",
    subjectType: "connector",
    subjectId: input.connectorId,
    metadata: {
      connectorId: input.connectorId,
      repositoryOwner: input.repository?.owner ?? null,
      repositoryName: input.repository?.name ?? null,
      passed: count("pass"),
      failed: count("fail"),
      unverifiable: count("unverifiable"),
      failedChecks: capped(
        input.checks.filter((check) => check.state === "fail").map((check) => check.id),
        GIT_AUDIT_LIMITS.checks,
      ).items,
      durationMs: Math.max(0, Math.round(input.durationMs)),
    },
  });
}
