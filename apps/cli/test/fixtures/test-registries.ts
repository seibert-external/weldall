/**
 * An `OpenRegistry` for tests: the real choice code runs on the registry list (`GET
 * /api/me/apps`) and resource registry the test serves, and only the token part is left out.
 * Requests the CLI would send with DPoP to `<origin>/<path>` go as plain HTTP to the test's
 * stand-in of that registry (`apis`), because the stand-ins' TLS certificates are self-signed. An
 * origin without a stand-in is unreachable, like a host that does not exist.
 */
import type { ResourceRegistryEntry } from "@weldall/sdk";
import { parseAppRegistries } from "../../src/services/apps.js";
import { parseRegistry } from "../../src/services/resources.js";
import {
  isBelowResource,
  RegistryAccessError,
  scopeFor,
  trustedRegistries,
  type OpenRegistry,
} from "../../src/git/registries.js";
import { retryAfterSeconds } from "../../src/git/weldall-access.js";

export interface TestRegistriesOptions {
  /** Weldall's resource registry for the person, read on every open like the real one. */
  registry: () => Promise<unknown>;
  /** Weldall's `GET /api/me/apps` answer, or null when the server lacks the route (404). */
  apps: () => Promise<unknown>;
  /** Registry origin to the plain-HTTP base URL of its stand-in. */
  apis: () => Promise<Record<string, string>> | Record<string, string>;
  /** Every request the CLI sent, for assertions. */
  requests?: Array<{ origin: string; scope: string; method: string; path: string; body?: unknown }>;
}

const plainBase = async (options: TestRegistriesOptions, origin: string) => {
  const base = (await options.apis())[origin];
  if (!base) throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${origin}`);
  return base;
};

export function testOpenRegistry(options: TestRegistriesOptions): OpenRegistry {
  const { registry, apps, requests } = options;
  return async (choose, need) => {
    const resources: ResourceRegistryEntry[] = parseRegistry(await registry());
    const answer = await apps();
    const found = trustedRegistries(answer === null ? null : parseAppRegistries(answer), resources);
    const chosen = choose(found);
    const scope = scopeFor(chosen, need);
    if (!scope || !chosen.resource.grantedScopes.includes(scope))
      throw new RegistryAccessError(
        "refused",
        `The requested scopes are not granted for ${chosen.name}`,
      );
    return {
      registry: chosen,
      async send({ method, url, body }) {
        // Like the real client: only below the chosen resource.
        if (!isBelowResource(chosen.resource, url))
          throw new Error(`No registered resource accepts ${url}`);
        const target = new URL(url);
        requests?.push({
          origin: target.origin,
          scope,
          method,
          path: `${target.pathname}${target.search}`,
          ...(body === undefined ? {} : { body }),
        });
        let base: string;
        try {
          base = await plainBase(options, target.origin);
        } catch (error) {
          throw new RegistryAccessError("network", (error as Error).message);
        }
        const response = await fetch(`${base}${target.pathname}${target.search}`, {
          method,
          headers: {
            "x-test-scope": scope,
            "x-test-origin": target.origin,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        let value: unknown = text || null;
        try {
          value = JSON.parse(text);
        } catch {
          // Not JSON: passed on as text, like the direct client does.
        }
        return {
          status: response.status,
          body: value,
          retryAfter: retryAfterSeconds(response.headers.get("retry-after")),
        };
      },
    };
  };
}
