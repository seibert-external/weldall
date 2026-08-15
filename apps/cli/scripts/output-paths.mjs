import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export async function canonicalOutputDirectory(path, repositoryRoot, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  const canonical = await realpath(path);
  const canonicalRepository = await realpath(resolve(repositoryRoot));
  const fromRepository = relative(canonicalRepository, canonical);
  if (fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository)))
    throw new Error(`${label} must be outside the repository`);
  return canonical;
}
