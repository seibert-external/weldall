import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function dereferenceTagCommit(ref, run = execFileSync) {
  return run("git", ["rev-parse", `${ref}^{commit}`], { encoding: "utf8" }).trim();
}

export function verifyReleaseTag(ref, expectedSha, run = execFileSync) {
  const actualSha = dereferenceTagCommit(ref, run);
  if (actualSha !== expectedSha)
    throw new Error(`Release tag ${ref} resolves to ${actualSha}, expected ${expectedSha}`);
  return actualSha;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [ref, expectedSha] = process.argv.slice(2);
  if (!ref || !expectedSha)
    throw new Error("Usage: node verify-release-tag.mjs <tag-ref> <expected-commit-sha>");
  verifyReleaseTag(ref, expectedSha);
}
