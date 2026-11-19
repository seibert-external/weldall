import type { PullRequestState } from "../hosts/git-host.js";
import { GIT_PUBLISH_BRANCH_PREFIX, validBranchName, validRefName } from "../publish-branches.js";
import {
  capabilityName,
  requestsStatusReport,
  type ReceivePackRequest,
  type RefUpdateCommand,
} from "./pkt-line.js";

/**
 * Push rules of the git proxy, carried over from the server's `git-proxy/rules.ts`. A push may
 * update only publish branches (`refs/heads/weldall/publish-<name>`, see `publish-branches.ts`);
 * every other ref is refused.
 */

/** A publish pushes one branch; a few more leave room without allowing bulk ref changes. */
export const GIT_MAX_REF_UPDATES = 5;
/**
 * Capabilities a push may announce: what Apple Git 2.39 and current git send for a normal push
 * (`report-status`/`report-status-v2`, `side-band-64k`/`side-band`, `quiet`, `atomic`, `agent`,
 * `object-format`, `session-id`) plus `ofs-delta`. `push-options` and `push-cert` have their own
 * reasons; anything else is refused, because the proxy cannot know how it changes the request.
 */
export const GIT_PUSH_CAPABILITIES: ReadonlySet<string> = new Set([
  "report-status",
  "report-status-v2",
  "side-band-64k",
  "side-band",
  "quiet",
  "atomic",
  "ofs-delta",
  "agent",
  "object-format",
  "session-id",
]);

const BRANCH_REF = "refs/heads/";

/** Reasons are shown by git as `! [remote rejected] <ref> (<reason>)`. */
const reason = (text: string) => `weldall: ${text}`;

export const GIT_PUSH_REASONS = {
  onlyPublishBranches: reason(`only branches named ${GIT_PUBLISH_BRANCH_PREFIX}* can be pushed`),
  defaultBranch: reason("the default branch changes only through a reviewed pull request"),
  deletion: reason("deleting branches is not allowed"),
  tag: reason("pushing tags is not allowed"),
  invalidBranch: reason("invalid branch name"),
  auditUnavailable: reason("the audit log is unavailable, nothing was pushed; retry later"),
  noStatusReport: reason("pushes must ask for a status report (report-status)"),
  tooManyRefs: reason(`push at most ${GIT_MAX_REF_UPDATES} branches at once`),
  pushOptions: reason("push options are not supported"),
  signedPush: reason("signed pushes are not supported"),
  duplicateRef: reason("the same branch appears twice in this push"),
  otherRefRejected: reason("push refused because another branch in it was refused"),
  pullRequestClosed: reason(
    "the pull request of this branch is closed or merged; publish to a new branch",
  ),
  pullRequestUnknown: reason("could not check the pull request of this branch; retry later"),
} as const;

export interface RefRejection {
  ref: string;
  reason: string;
}

const zeroId = (id: string) => /^0+$/.test(id);

/** Branch name below `refs/heads/`, or null for any other ref. */
export function branchOf(ref: string): string | null {
  return ref.startsWith(BRANCH_REF) ? ref.slice(BRANCH_REF.length) : null;
}

export const unsupportedCapabilityReason = (name: string) =>
  reason(`unsupported push capability ${name.replace(/[^\x21-\x7e]/g, "?").slice(0, 40)}`);

function commandRejection(command: RefUpdateCommand, defaultBranch: string): string | null {
  if (!validRefName(command.ref)) return GIT_PUSH_REASONS.invalidBranch;
  const branch = branchOf(command.ref);
  if (command.ref.startsWith("refs/tags/")) return GIT_PUSH_REASONS.tag;
  if (branch === null) return GIT_PUSH_REASONS.onlyPublishBranches;
  // Git refs are case-sensitive, but hosts on case-insensitive storage may not be.
  if (branch.toLowerCase() === defaultBranch.toLowerCase()) return GIT_PUSH_REASONS.defaultBranch;
  if (zeroId(command.newId)) return GIT_PUSH_REASONS.deletion;
  if (!branch.startsWith(GIT_PUBLISH_BRANCH_PREFIX) || branch === GIT_PUBLISH_BRANCH_PREFIX)
    return GIT_PUSH_REASONS.onlyPublishBranches;
  if (!validBranchName(branch)) return GIT_PUSH_REASONS.invalidBranch;
  return null;
}

/**
 * Applies the push rules to a parsed receive-pack request. Returns one rejection per command when
 * any rule fails (the push is all or nothing), or null when every update may be forwarded.
 *
 * What the rules cannot see: whether an update is a fast-forward (that needs the history). The
 * expected old state is enforced by the host: receive-pack updates a ref only if it still points
 * to the command's old id, so creating a branch that exists, or updating one that moved, fails
 * there.
 */
export function checkPushRules(
  request: ReceivePackRequest,
  defaultBranch: string,
): RefRejection[] | null {
  const { commands } = request;
  const names = request.capabilities.map(capabilityName);
  const unknown = names.find(
    (name) => name !== "push-options" && name !== "push-cert" && !GIT_PUSH_CAPABILITIES.has(name),
  );
  const pushLevel = request.pushCert
    ? GIT_PUSH_REASONS.signedPush
    : request.pushOptions.length || names.includes("push-options")
      ? GIT_PUSH_REASONS.pushOptions
      : unknown !== undefined
        ? unsupportedCapabilityReason(unknown)
        : !requestsStatusReport(request.capabilities)
          ? GIT_PUSH_REASONS.noStatusReport
          : commands.length > GIT_MAX_REF_UPDATES
            ? GIT_PUSH_REASONS.tooManyRefs
            : new Set(commands.map(({ ref }) => ref)).size !== commands.length
              ? GIT_PUSH_REASONS.duplicateRef
              : null;
  if (pushLevel) {
    // A signed push carries its commands inside the certificate; name the push as a whole.
    const refs = commands.length ? commands.map(({ ref }) => ref) : ["(signed push)"];
    return refs.map((ref) => ({ ref, reason: pushLevel }));
  }
  const reasons = commands.map((command) => commandRejection(command, defaultBranch));
  return rejectAll(commands, reasons);
}

/** Rejection for a branch whose pull request is in `state`, or null when pushing may continue. */
export function pullRequestRejection(state: PullRequestState | null): string | null {
  return state === "closed" || state === "merged" ? GIT_PUSH_REASONS.pullRequestClosed : null;
}

/** All-or-nothing: when any command has a reason, the others are refused because of it. */
export function rejectAll(
  commands: readonly RefUpdateCommand[],
  reasons: readonly (string | null)[],
): RefRejection[] | null {
  if (reasons.every((value) => value === null)) return null;
  return commands.map(({ ref }, index) => ({
    ref,
    reason: reasons[index] ?? GIT_PUSH_REASONS.otherRefRejected,
  }));
}
