import type { ResourceDto } from "@/server/admin/service";

/**
 * Why a reload left the agents as they were, said only as far as it is true: whether people still
 * see the last copy depends on its age and on whether the resource changed since it was read.
 */
export function agentReloadFailureDetail(
  resource: Pick<ResourceDto, "skillDiscoveryEnabled" | "catalogStatus"> | null | undefined,
): string {
  const skills = resource?.skillDiscoveryEnabled ? "The skills were reloaded. " : "";
  const agents = resource?.catalogStatus?.agents;
  const copy = !agents
    ? ""
    : !agents.lastSuccessfulRefreshAt
      ? "No agents have been read from this resource yet. "
      : agents.state === "expired"
        ? "The last copy of the agents stays hidden until they can be read again. "
        : "People keep seeing the last copy of the agents. ";
  return `${skills}${copy}See the agent discovery status for details`;
}
