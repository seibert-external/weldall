/**
 * Publish branches. The
 * git proxy (`git/rules.ts`) accepts pushes only to these branches; pull requests and status reads
 * refer only to them.
 */

/** Branches a publish pushes: `refs/heads/weldall/publish-<name>`. */
export const GIT_PUBLISH_BRANCH_PREFIX = "weldall/publish-";
const MAX_BRANCH_LENGTH = 200;
const BRANCH_REF = "refs/heads/";

/**
 * `git check-ref-format` rules, on top of printable ASCII only: the name that is checked is the
 * name that is audited and forwarded, so nothing may be ambiguous or normalised later.
 */
export function validRefName(ref: string) {
  return (
    /^[\x21-\x7e]+$/.test(ref) &&
    !/[~^:?*[\\]/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    ref !== "@" &&
    !ref.endsWith("/") &&
    !ref.endsWith(".") &&
    ref
      .split("/")
      .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

/** Git's own ref-name rules, as far as they matter for a publish branch. */
export function validBranchName(branch: string) {
  return (
    branch.length <= MAX_BRANCH_LENGTH &&
    /^[A-Za-z0-9._/-]+$/.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")) &&
    !branch.endsWith("/") &&
    !branch.endsWith(".")
  );
}

/** Whether `branch` (without `refs/heads/`) is a publish branch of an app with `defaultBranch`. */
export function isPublishBranch(branch: string, defaultBranch: string): boolean {
  return (
    validRefName(`${BRANCH_REF}${branch}`) &&
    branch.toLowerCase() !== defaultBranch.toLowerCase() &&
    branch.startsWith(GIT_PUBLISH_BRANCH_PREFIX) &&
    branch !== GIT_PUBLISH_BRANCH_PREFIX &&
    validBranchName(branch)
  );
}
