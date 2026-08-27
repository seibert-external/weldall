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
import { CONFIG_REFRESH_HINT, type WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { isRecord, successfulResponse, successfulResponseStream } from "../http.js";
import { WELDALL_CLIENT_ID } from "../oauth/constants.js";
import { validateIdJagResponse } from "../oauth/session.js";
import { phaseTiming, timingNow } from "../timing.js";
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
  )
    throw new CliError("Weldall returned an invalid resource registry");
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
  const value = await successfulResponse(response, "Weldall grants request", CONFIG_REFRESH_HINT);
  if (!stringArray(value) || value.some((scope) => !scope) || new Set(value).size !== value.length)
    throw new CliError("Weldall returned invalid assigned scopes");
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
      CONFIG_REFRESH_HINT,
    ),
  );
};

export async function listScopesWithSubject(config: WeldallConfig) {
  return withAccess(config, async (session) => {
    const [scopes, resources] = await Promise.all([
      assignedScopes(config, session),
      registry(config, session),
    ]);
    return {
      result: {
        assignedScopes:
          scopes ?? [...new Set(resources.flatMap((resource) => resource.grantedScopes))].sort(),
        resources,
      },
      subject: session.subject,
    };
  });
}

export async function listScopes(config: WeldallConfig) {
  return (await listScopesWithSubject(config)).result;
}

export interface PreparedRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | Blob | FormData;
  json?: unknown;
  signal?: AbortSignal;
}

export interface PreparedResourceClient {
  resource: ResourceRegistryEntry;
  scopes: string[];
  request(input: PreparedRequest): Promise<Response>;
}

const targetUrl = (input: string): URL => {
  try {
    return normalizeRequestTarget(input);
  } catch (error) {
    throw new CliError("Request URL must be HTTPS and must not contain credentials or a fragment", {
      cause: error,
    });
  }
};

const resourceForTarget = (resources: ResourceRegistryEntry[], target: URL) => {
  const candidates = resolveResourceForTarget(resources, target);
  if (candidates.length === 0)
    throw new CliError(`No registered resource accepts ${target.toString()}`, {
      hint: "Use a URL documented by an available Weldall skill.",
    });
  if (candidates.length > 1)
    throw new CliError(`Multiple registered resources accept ${target.toString()}`);
  return candidates[0]!;
};

const validateScopes = (resource: ResourceRegistryEntry, scopes: string[]) => {
  const requestedScopes = [...new Set(scopes)].sort();
  const unsupportedScopes = requestedScopes.filter(
    (scope) => !resource.supportedScopes.includes(scope),
  );
  if (!requestedScopes.length || unsupportedScopes.length > 0)
    throw new CliError(
      requestedScopes.length === 0
        ? `No scopes were requested for ${resource.name}`
        : unsupportedScopes.length === 1
          ? `The requested scope ${JSON.stringify(unsupportedScopes[0])} is not supported by ${resource.name}`
          : `The requested scopes ${unsupportedScopes.map((scope) => JSON.stringify(scope)).join(", ")} are not supported by ${resource.name}`,
      {
        hint:
          `Supported scopes: ${resource.supportedScopes.join(", ") || "none"}. ` +
          `Granted scopes: ${resource.grantedScopes.join(", ") || "none"}.`,
      },
    );
  if (requestedScopes.some((scope) => !resource.grantedScopes.includes(scope)))
    throw new CliError(`The requested scopes are not granted for ${resource.name}`);
  return requestedScopes;
};

export async function prepareResourceClient(
  config: WeldallConfig,
  targetInput: URL | string,
  scopes: string[],
): Promise<PreparedResourceClient> {
  const target = targetUrl(targetInput.toString());
  return withAccess(config, async (session) => {
    const registryStartedAt = timingNow();
    const resource = resourceForTarget(await registry(config, session), target);
    phaseTiming("registry", registryStartedAt);
    const requestedScopes = validateScopes(resource, scopes);

    const exchangeStartedAt = timingNow();
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
      CONFIG_REFRESH_HINT,
    );
    if (!isRecord(exchange)) throw new CliError("Weldall returned an invalid token exchange");
    const assertion = await validateIdJagResponse(config, exchange, session.credentials.publicJwk, {
      subject: session.subject,
      authorizationServer: resource.authorizationServer,
      resource: resource.resourceIdentifier,
      clientId: resource.downstreamClientId,
      scopes: requestedScopes,
    });

    phaseTiming("token-exchange", exchangeStartedAt);
    const resourceTokenStartedAt = timingNow();
    const downstreamTokenEndpoint = `${resource.authorizationServer}/oauth/token`;
    const downstreamProof = await createDpopProof({
      ...session.credentials,
      method: "POST",
      url: downstreamTokenEndpoint,
    });
    const downstream = await successfulResponse(
      await fetch(downstreamTokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", dpop: downstreamProof },
        body: new URLSearchParams({ grant_type: JWT_DPOP_GRANT, assertion }),
        redirect: "error",
      }),
      "Resource token request",
    );
    if (
      !isRecord(downstream) ||
      downstream.token_type !== "DPoP" ||
      typeof downstream.access_token !== "string" ||
      !downstream.access_token ||
      typeof downstream.expires_in !== "number" ||
      !Number.isInteger(downstream.expires_in) ||
      downstream.expires_in < 1 ||
      downstream.expires_in > 3_600
    )
      throw new CliError("The resource server returned an invalid token response");
    const accessToken = downstream.access_token;
    phaseTiming("resource-token", resourceTokenStartedAt);

    return {
      resource,
      scopes: requestedScopes,
      request: async (input: PreparedRequest) => {
        const requestTarget = targetUrl(input.url);
        resourceForTarget([resource], requestTarget);
        const apiProof = await createDpopProof({
          ...session.credentials,
          method: input.method,
          url: requestTarget.toString(),
          accessToken,
        });
        const headers = new Headers(input.headers);
        if (!headers.has("accept")) headers.set("accept", "application/json");
        headers.set("authorization", `DPoP ${accessToken}`);
        headers.set("dpop", apiProof);
        if (input.json !== undefined) headers.set("content-type", "application/json");
        return successfulResponseStream(
          await fetch(requestTarget, {
            method: input.method,
            headers,
            ...(input.json !== undefined
              ? { body: JSON.stringify(input.json) }
              : input.body !== undefined
                ? { body: input.body }
                : {}),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            redirect: "error",
          }),
          `${input.method} ${requestTarget.toString()}`,
        );
      },
    };
  });
}

export async function resourceRequest(
  config: WeldallConfig,
  input: PreparedRequest & { scopes: string[] },
) {
  const client = await prepareResourceClient(config, input.url, input.scopes);
  return client.request(input);
}
