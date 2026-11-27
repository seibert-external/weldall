import type { ResourceDto } from "@/server/admin/service";
import type { ResourceCatalogRefreshOutcome } from "@/server/skills/catalogs";
import { listing } from "@/lib/listing";

type SideKind = "agents" | "apps";
const SIDE_KINDS: readonly SideKind[] = ["agents", "apps"];
const ITEM: Record<SideKind, string> = { agents: "agent", apps: "app" };

/** The sides a reload left as they were (`agents_failed`, `apps_failed`, `agents_and_apps_failed`). */
export const failedSides = (outcome: ResourceCatalogRefreshOutcome): SideKind[] =>
  outcome.endsWith("_failed") && outcome !== "failed"
    ? SIDE_KINDS.filter((kind) => outcome.split("_").includes(kind))
    : [];

/** What a reload reads: "skills", "agents", "skills, agents and apps", ... */
export const reloadedKinds = (
  resource: Pick<
    ResourceDto,
    "skillDiscoveryEnabled" | "agentDiscoveryEnabled" | "appDiscoveryEnabled"
  >,
): string[] => [
  ...(resource.skillDiscoveryEnabled ? ["skills"] : []),
  ...(resource.agentDiscoveryEnabled ? ["agents"] : []),
  ...(resource.appDiscoveryEnabled ? ["apps"] : []),
];

/**
 * Why a reload left some sides as they were, said only as far as it is true: what was reloaded
 * instead, and whether people still see the last copy of each failed side, which depends on its age
 * and on whether the resource changed since it was read.
 */
export function sideReloadFailureDetail(
  resource:
    | Pick<
        ResourceDto,
        "skillDiscoveryEnabled" | "agentDiscoveryEnabled" | "appDiscoveryEnabled" | "catalogStatus"
      >
    | null
    | undefined,
  failed: readonly SideKind[],
): string {
  const reloaded = resource
    ? reloadedKinds(resource).filter((kind) => !failed.includes(kind as SideKind))
    : [];
  const done = reloaded.length ? `The ${listing(reloaded)} were reloaded. ` : "";
  const copies = failed
    .map((kind) => {
      const side = resource?.catalogStatus?.[kind];
      return !side
        ? ""
        : !side.lastSuccessfulRefreshAt
          ? `No ${kind} have been read from this resource yet. `
          : side.state === "expired"
            ? `The last copy of the ${kind} stays hidden until they can be read again. `
            : `People keep seeing the last copy of the ${kind}. `;
    })
    .join("");
  return `${done}${copies}See the ${listing(failed.map((kind) => ITEM[kind]))} discovery status for details`;
}
