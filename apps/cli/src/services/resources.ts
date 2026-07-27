import {
  createDpopProof,
  ID_JAG_TOKEN_TYPE,
  JWT_DPOP_GRANT,
  normalizeAuthorizationServer,
  normalizeRequestPrefix,
  normalizeRequestTarget,
  normalizeResourceIdentifier,
  resolveResourceForTarget,
  REFRESH_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT,
  type ResourceRegistryEntry,
} from "@weldall/sdk";
import type { WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { isRecord, successfulResponse, successfulResponseStream } from "../http.js";
import { WELDALL_CLIENT_ID } from "../oauth/constants.js";
import { validateIdJagResponse } from "../oauth/session.js";
import { withLock } from "../storage/lock.js";
import { withAccess, type AccessSession } from "./auth.js";

export type ResourceGrant = ResourceRegistryEntry;

const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export const parseRegistry = (value: unknown): ResourceRegistryEntry[] => {
  if (
    !Array.isArray(value) ||
    value.some(
      (resource) =>
        !isRecord(resource) ||
        typeof resource.key !== "string" ||
        typeof resource.name !== "string" ||
        typeof resource.resourceIdentifier !== "string" ||
        typeof resource.authorizationServer !== "string" ||
        typeof resource.downstreamClientId !== "string" ||
        !stringArray(resource.requestPrefixes) ||
        !stringArray(resource.supportedScopes) ||
        !stringArray(resource.grantedScopes),
    )
  ) {
    throw new CliError("Weldall returned an invalid resource registry");
  }
  const resources = value as ResourceRegistryEntry[];
  try {
    for (const resource of resources) {
      if (!resource.key || !resource.name || !resource.downstreamClientId) throw new TypeError();
      if (normalizeResourceIdentifier(resource.resourceIdentifier) !== resource.resourceIdentifier)
        throw new TypeError();
      if (
        normalizeAuthorizationServer(resource.authorizationServer) !== resource.authorizationServer
      )
        throw new TypeError();
      if (
        !resource.requestPrefixes.length ||
        resource.requestPrefixes.some((prefix) => normalizeRequestPrefix(prefix) !== prefix) ||
        resource.grantedScopes.some((scope) => !resource.supportedScopes.includes(scope))
      )
        throw new TypeError();
    }
  } catch (error) {
    throw new CliError("Weldall returned an unsafe resource registry", { cause: error });
  }
  return resources;
};

const assignedScopes = async (config: WeldallConfig, session: AccessSession) => {
  const proof = await createDpopProof({
    ...session.credentials,
    method: "GET",
    url: config.grants,
    accessToken: session.accessToken,
  });
  const response = await fetch(config.grants, {
    headers: {
      accept: "application/json",
      authorization: `DPoP ${session.accessToken}`,
      dpop: proof,
    },
    redirect: "error",
  });
  if (response.status === 404) return null;
  const value = await successfulResponse(response, "Weldall grants request");
  if (
    !stringArray(value) ||
    value.some((scope) => !scope) ||
    new Set(value).size !== value.length
  ) {
    throw new CliError("Weldall returned invalid assigned scopes");
  }
  return [...value].sort();
};

const registry = async (config: WeldallConfig, session: AccessSession) => {
  const proof = await createDpopProof({
    ...session.credentials,
    method: "GET",
    url: config.scopes,
    accessToken: session.accessToken,
  });
  return parseRegistry(
    await successfulResponse(
      await fetch(config.scopes, {
        headers: {
          accept: "application/json",
          authorization: `DPoP ${session.accessToken}`,
          dpop: proof,
        },
        redirect: "error",
      }),
      "Weldall resource request",
    ),
  );
};

export async function listScopes(config: WeldallConfig) {
  return withLock(() =>
    withAccess(config, async (session) => {
      const [scopes, resources] = await Promise.all([
        assignedScopes(config, session),
        registry(config, session),
      ]);
      return {
        assignedScopes:
          scopes ?? [...new Set(resources.flatMap((resource) => resource.grantedScopes))].sort(),
        resources,
      };
    }),
  );
}

export async function resourceRequest(
  config: WeldallConfig,
  input: {
    url: string;
    method: string;
    scopes: string[];
    headers?: Record<string, string>;
    body?: string | Blob | FormData;
    json?: unknown;
  },
) {
  return withLock(() =>
    withAccess(config, async (session) => {
      let target: URL;
      try {
        target = normalizeRequestTarget(input.url);
      } catch (error) {
        throw new CliError(
          "Request URL must be HTTPS and must not contain credentials or a fragment",
          { cause: error },
        );
      }
      const resources = await registry(config, session);
      const candidates = resolveResourceForTarget(resources, target);
      if (candidates.length === 0) {
        throw new CliError(`No registered resource accepts ${target.toString()}`, {
          hint: "Use a URL documented by an available Weldall skill.",
        });
      }
      if (candidates.length > 1) {
        throw new CliError(`Multiple registered resources accept ${target.toString()}`);
      }
      const resource = candidates[0]!;
      const requestedScopes = [...new Set(input.scopes)].sort();
      if (
        !requestedScopes.length ||
        requestedScopes.some((scope) => !resource.supportedScopes.includes(scope))
      ) {
        throw new CliError(`The requested scopes are not supported by ${resource.name}`);
      }
      if (requestedScopes.some((scope) => !resource.grantedScopes.includes(scope))) {
        throw new CliError(`The requested scopes are not granted for ${resource.name}`);
      }

      const proof = await createDpopProof({
        ...session.credentials,
        method: "POST",
        url: config.token,
      });
      const exchange = await successfulResponse(
        await fetch(config.token, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
          body: new URLSearchParams({
            grant_type: TOKEN_EXCHANGE_GRANT,
            requested_token_type: ID_JAG_TOKEN_TYPE,
            audience: resource.authorizationServer,
            resource: resource.resourceIdentifier,
            scope: requestedScopes.join(" "),
            subject_token: session.credentials.refreshToken,
            subject_token_type: REFRESH_TOKEN_TYPE,
            client_id: WELDALL_CLIENT_ID,
          }),
          redirect: "error",
        }),
        "Weldall token exchange",
      );
      if (!isRecord(exchange)) throw new CliError("Weldall returned an invalid token exchange");
      const assertion = await validateIdJagResponse(
        config,
        exchange,
        session.credentials.publicJwk,
        {
          authorizationServer: resource.authorizationServer,
          resource: resource.resourceIdentifier,
          clientId: resource.downstreamClientId,
          scopes: requestedScopes,
        },
      );

      const downstreamTokenEndpoint = `${resource.authorizationServer}/oauth/token`;
      const downstreamProof = await createDpopProof({
        ...session.credentials,
        method: "POST",
        url: downstreamTokenEndpoint,
      });
      const downstream = await successfulResponse(
        await fetch(downstreamTokenEndpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            dpop: downstreamProof,
          },
          body: new URLSearchParams({ grant_type: JWT_DPOP_GRANT, assertion }),
          redirect: "error",
        }),
        "Resource token request",
      );
      if (!isRecord(downstream) || typeof downstream.access_token !== "string") {
        throw new CliError("The resource server returned an invalid token response");
      }

      const apiProof = await createDpopProof({
        ...session.credentials,
        method: input.method,
        url: target.toString(),
        accessToken: downstream.access_token,
      });
      const headers = new Headers(input.headers);
      if (!headers.has("accept")) headers.set("accept", "application/json");
      headers.set("authorization", `DPoP ${downstream.access_token}`);
      headers.set("dpop", apiProof);
      if (input.json !== undefined) headers.set("content-type", "application/json");
      return successfulResponseStream(
        await fetch(target, {
          method: input.method,
          headers,
          ...(input.json !== undefined
            ? { body: JSON.stringify(input.json) }
            : input.body !== undefined
              ? { body: input.body }
              : {}),
          redirect: "error",
        }),
        `${input.method} ${target.toString()}`,
      );
    }),
  );
}
