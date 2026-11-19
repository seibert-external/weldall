/**
 * An `OpenGitApp` for tests: the real choice code runs on a registry the test serves, and only
 * the token part is left out. Requests the CLI would send with DPoP to `<origin>/api/<path>` go
 * as plain HTTP to the test's stand-in of that Git app (`apis`), because the stand-ins' TLS
 * certificates are self-signed. An origin without a stand-in is unreachable, like a host that
 * does not exist.
 */
import type { ResourceRegistryEntry } from "@weldall/sdk";
import { parseRegistry } from "../../src/services/resources.js";
import { GitAppAccessError, type OpenGitApp } from "../../src/git/git-apps.js";

export interface TestGitAppsOptions {
  /** Weldall's resource registry for the person, read on every open like the real one. */
  registry: () => Promise<unknown>;
  /** Git app origin to the plain-HTTP base URL of its stand-in. */
  apis: () => Promise<Record<string, string>> | Record<string, string>;
  /** Every request the CLI sent, for assertions. */
  requests?: Array<{ origin: string; scope: string; method: string; path: string; body?: unknown }>;
}

export function testOpenGitApp({ registry, apis, requests }: TestGitAppsOptions): OpenGitApp {
  return async (choose, scope) => {
    const resources: ResourceRegistryEntry[] = parseRegistry(await registry());
    const gitApp = choose(resources);
    if (!gitApp.resource.grantedScopes.includes(scope))
      throw new GitAppAccessError(
        "refused",
        `The requested scopes are not granted for ${gitApp.name}`,
      );
    return {
      gitApp,
      async send({ method, path, body }) {
        requests?.push({
          origin: gitApp.origin,
          scope,
          method,
          path,
          ...(body === undefined ? {} : { body }),
        });
        const base = (await apis())[gitApp.origin];
        if (!base)
          throw new GitAppAccessError(
            "network",
            `fetch failed: getaddrinfo ENOTFOUND ${gitApp.origin}`,
          );
        const response = await fetch(`${base}/api/${path}`, {
          method,
          headers: {
            "x-test-scope": scope,
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
        return { status: response.status, body: value };
      },
    };
  };
}
