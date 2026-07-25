export const releasePackages = Object.freeze([
  Object.freeze({
    name: "@weldall/sdk",
    directory: "packages/sdk",
    tagPrefix: "sdk-v",
  }),
  Object.freeze({
    name: "@weldall/ci",
    directory: "apps/cli",
    tagPrefix: "ci-v",
  }),
]);

export const compareReleaseVersions = (left, right) => {
  const parse = (version) => {
    const [core, prerelease = ""] = version.split("-", 2);
    return { core: core.split(".").map(Number), prerelease: prerelease.split(".").filter(Boolean) };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined)
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
    if (leftNumber !== undefined || rightNumber !== undefined)
      return leftNumber !== undefined ? -1 : 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
};

export const sortReleaseEntries = (entries, firstParentCommits) => {
  const commitOrder = new Map(firstParentCommits.map((commit, index) => [commit, index]));
  const packageOrder = new Map(releasePackages.map(({ name }, index) => [name, index]));
  return entries.sort(
    (left, right) =>
      (commitOrder.get(left.targetCommit) ?? Number.MAX_SAFE_INTEGER) -
        (commitOrder.get(right.targetCommit) ?? Number.MAX_SAFE_INTEGER) ||
      (packageOrder.get(left.name) ?? Number.MAX_SAFE_INTEGER) -
        (packageOrder.get(right.name) ?? Number.MAX_SAFE_INTEGER),
  );
};
