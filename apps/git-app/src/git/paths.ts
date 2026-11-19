/**
 * Paths of the git proxy: `/git/<owner>/<repository>.git` followed by one of the smart-HTTP
 * endpoints. Adapted from the server's `git-proxy/paths.ts` without the connector segment: one
 * Git app instance serves one Git host, so the instance itself is what the connector key named.
 * Segments are matched on the raw, still encoded path, so encoded slashes, dots or other escapes
 * never reach the registry lookup; owner and repository are matched case-insensitively there
 * because hosts treat them that way.
 */

export interface GitRepositoryPath {
  /** As written in the URL; the registry lookup ignores case. */
  owner: string;
  name: string;
}

export type GitService = "git-upload-pack" | "git-receive-pack";

export type GitProxyEndpoint =
  { kind: "advertisement"; service: GitService } | { kind: "rpc"; service: GitService };

/** First segment of every git proxy path. */
export const GIT_PATH_PREFIX = "git";

const hostName = /^[A-Za-z0-9._-]{1,100}$/;
const services = new Set<string>(["git-upload-pack", "git-receive-pack"]);

function repositoryFrom(segments: readonly string[]): GitRepositoryPath | null {
  const [owner = "", repository = ""] = segments;
  if (!repository.endsWith(".git")) return null;
  const name = repository.slice(0, -4);
  if (
    !hostName.test(owner) ||
    !hostName.test(name) ||
    [owner, name].some((part) => part === "." || part === "..")
  )
    return null;
  return { owner, name };
}

/** The path of a repository's git remote on this instance: `/git/<owner>/<repository>.git`. */
export const gitRemotePath = ({ owner, name }: GitRepositoryPath) =>
  `/${GIT_PATH_PREFIX}/${owner}/${name}.git`;

/**
 * Parses a repository path as the credential endpoint receives it from git's credential helper
 * (`git/<owner>/<repository>.git`, with or without the leading slash). Null when it is not
 * exactly that shape.
 */
export function parseGitRemotePath(path: string): GitRepositoryPath | null {
  const segments = (path.startsWith("/") ? path.slice(1) : path).split("/");
  if (segments.length !== 3 || segments[0] !== GIT_PATH_PREFIX) return null;
  return repositoryFrom(segments.slice(1));
}

/**
 * Parses a proxy request: the raw URL path plus the method and `service` query decide which of the
 * three smart-HTTP endpoints is meant. Everything else (dumb-protocol files, other services, extra
 * or empty segments) yields null.
 */
export function parseGitProxyRequest(
  method: string,
  url: URL,
): { repository: GitRepositoryPath; endpoint: GitProxyEndpoint } | null {
  const segments = url.pathname.split("/");
  // "", "git", owner, repo.git, ...endpoint
  if (segments[0] !== "" || segments[1] !== GIT_PATH_PREFIX) return null;
  const repository = repositoryFrom(segments.slice(2, 4));
  if (!repository) return null;
  const tail = segments.slice(4).join("/");
  if (method === "GET" && tail === "info/refs") {
    const service = url.searchParams.get("service") ?? "";
    return services.has(service)
      ? { repository, endpoint: { kind: "advertisement", service: service as GitService } }
      : null;
  }
  if (method === "POST" && services.has(tail))
    return { repository, endpoint: { kind: "rpc", service: tail as GitService } };
  return null;
}
