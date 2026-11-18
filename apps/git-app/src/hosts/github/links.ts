import { z } from "zod";
import { GitAppError } from "../../errors.js";
import { safeHttpsUrl } from "../../git-text.js";

/**
 * Where the CI's preview and live links are read from. How the template's CI reports its link is
 * not settled (INV-185); this reads GitHub deployments, the place the spike recommended, and is
 * the only function to replace when the template settles on another source (commit statuses,
 * check runs or a file in the repository).
 *
 * - Preview: the newest deployment of the pull request's head commit in an environment that is
 *   not a live environment, whose newest status is `success` with an https `environment_url`.
 * - Live: the newest such deployment in one of the configured live environments, whatever its
 *   commit (production deploys the default branch, not the pull request).
 */
export async function readGitHubDeploymentLinks({
  get,
  headCommit,
  liveEnvironments,
}: {
  /** GET below `/repos/{owner}/{repository}`; returns the JSON body of a 200 or throws. */
  get: (path: string) => Promise<unknown>;
  /** Head commit of the current pull request; null skips the preview lookup. */
  headCommit: string | null;
  /** Compared without case, see the configured `liveEnvironments`. */
  liveEnvironments: readonly string[];
}): Promise<{ preview: string | null; live: string | null }> {
  const live = new Set(liveEnvironments.map((name) => name.toLowerCase()));
  const isLive = (environment: string) => live.has(environment.toLowerCase());

  async function linkOf(deployments: Deployment[]): Promise<string | null> {
    for (const deployment of deployments.slice(0, DEPLOYMENTS_CHECKED)) {
      const statuses = parseOrThrow(
        deploymentStatusesResponse,
        await get(`/deployments/${deployment.id}/statuses?per_page=1`),
      );
      // GitHub lists the newest status first; an older success of a failed redeploy does not count.
      const [newest] = statuses;
      if (newest?.state !== "success") continue;
      const url = safeHttpsUrl(newest.environment_url);
      if (url) return url;
    }
    return null;
  }

  let preview: string | null = null;
  if (headCommit) {
    const deployments = parseOrThrow(
      deploymentsResponse,
      await get(`/deployments?${new URLSearchParams({ sha: headCommit, per_page: "20" })}`),
    );
    preview = await linkOf(deployments.filter(({ environment }) => !isLive(environment)));
  }
  let liveLink: string | null = null;
  for (const environment of liveEnvironments) {
    const deployments = parseOrThrow(
      deploymentsResponse,
      await get(`/deployments?${new URLSearchParams({ environment, per_page: "5" })}`),
    );
    liveLink = await linkOf(deployments.filter((deployment) => isLive(deployment.environment)));
    if (liveLink) break;
  }
  return { preview, live: liveLink };
}

/** Deployments (newest first) whose statuses are read per lookup. */
const DEPLOYMENTS_CHECKED = 3;

const deploymentsResponse = z.array(
  z.object({ id: z.number().int().positive(), environment: z.string() }),
);
type Deployment = z.infer<typeof deploymentsResponse>[number];
const deploymentStatusesResponse = z.array(
  z.object({ state: z.string(), environment_url: z.string().nullable().optional() }),
);

function parseOrThrow<T extends z.ZodType>(schema: T, json: unknown): z.output<T> {
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new GitAppError("upstream_protocol_error", "GitHub sent an invalid response.", 502);
  return parsed.data;
}
