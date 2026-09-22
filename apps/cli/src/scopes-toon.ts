import { encode } from "@toon-format/toon";
import type { ResourceGrant } from "./services/resources.js";
import { TOON_OPTIONS, joined } from "./toon.js";

// What an agent acts on is which scopes it holds and which URLs a resource answers for. The
// resource identifier, authorization server, and downstream client id are OAuth plumbing the
// agent never sends anywhere itself, so they stay in `--json`.
const resourceRow = (resource: ResourceGrant) => ({
  key: resource.key,
  name: resource.name,
  grantedScopes: joined(resource.grantedScopes),
  supportedScopes: joined(resource.supportedScopes),
  requestPrefixes: joined(resource.requestPrefixes),
});

export function scopesToon(permissions: {
  assignedScopes: string[];
  resources: ResourceGrant[];
}): string {
  return encode(
    {
      assignedScopes: permissions.assignedScopes,
      resources: permissions.resources.map(resourceRow),
    },
    TOON_OPTIONS,
  ).concat("\n");
}
