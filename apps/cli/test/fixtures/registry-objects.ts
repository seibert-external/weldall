import type { ResourceRegistryEntry } from "@weldall/sdk";
import type { FoundRegistries, Registry } from "../../src/git/registries.js";

/** A registry as the CLI takes it from Weldall's list, for tests that leave the lists out. */
export function registryOf(
  key: string,
  origin: string,
  grantedScopes: string[],
  { changes = true, admin = true }: { changes?: boolean; admin?: boolean } = {},
): Registry {
  const resource: ResourceRegistryEntry = {
    key,
    name: `Registry ${key}`,
    resourceIdentifier: `${origin}/api`,
    authorizationServer: origin,
    downstreamClientId: "weldall-cli-at-registry",
    requestPrefixes: [`${origin}/api`],
    supportedScopes: ["registry:admin", "registry:agents", "registry:publish"],
    grantedScopes,
  };
  return {
    key,
    name: resource.name,
    origin,
    resource,
    api: `${origin}/api/`,
    publishScope: "registry:publish",
    publishAllowed: grantedScopes.includes("registry:publish"),
    adminScope: admin ? "registry:admin" : null,
    adminAllowed: admin && grantedScopes.includes("registry:admin"),
    git: changes ? `${origin}/git/` : null,
    gitCredentials: changes ? `${origin}/api/git-credentials` : null,
  };
}

export const foundOf = (registries: Registry[]): FoundRegistries => ({
  listed: true,
  registries,
  resources: registries.map(({ resource }) => resource),
  rejected: [],
});
