import type { ResourceGrant } from "./services/resources.js";
import { block, inlineArray, joined, row } from "./toon.js";

// What an agent acts on is which scopes it holds and which URLs a resource answers for. The
// resource identifier, authorization server, and downstream client id are OAuth plumbing the
// agent never sends anywhere itself, so they stay in `--json`.
const RESOURCE_FIELDS = [
  "key",
  "name",
  "grantedScopes",
  "supportedScopes",
  "requestPrefixes",
] as const;

const resourceRow = (resource: ResourceGrant) =>
  row([
    resource.key,
    resource.name,
    joined(resource.grantedScopes),
    joined(resource.supportedScopes),
    joined(resource.requestPrefixes),
  ]);

export function scopesToon(permissions: {
  assignedScopes: string[];
  resources: ResourceGrant[];
}): string {
  return [
    inlineArray("assignedScopes", permissions.assignedScopes),
    block("resources", RESOURCE_FIELDS, permissions.resources.map(resourceRow)),
  ]
    .join("\n")
    .concat("\n");
}
