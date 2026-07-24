import {
  createDpopProof,
  ID_JAG_TOKEN_TYPE,
  JWT_DPOP_GRANT,
  WELDALL_CLIENT_ID,
  REFRESH_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT,
} from "@weldall/oauth";
import type { WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { isRecord, successfulResponse } from "../http.js";
import { validateIdJagResponse } from "../oauth/session.js";
import { withLock } from "../storage/lock.js";
import { withAccess, type AccessSession } from "./auth.js";

export interface ResourceGrant {
  name: string;
  authorizationServer: string;
  resource: string;
  downstreamClientId: string;
  scopes: string[];
}

const parseRegistry = (value: unknown): ResourceGrant[] => {
  if (
    !Array.isArray(value) ||
    value.some(
      (grant) =>
        !isRecord(grant) ||
        typeof grant.name !== "string" ||
        typeof grant.authorizationServer !== "string" ||
        typeof grant.resource !== "string" ||
        typeof grant.downstreamClientId !== "string" ||
        !Array.isArray(grant.scopes) ||
        grant.scopes.some((scope) => typeof scope !== "string"),
    )
  )
    throw new CliError("Weldall returned an invalid resource registry");
  return value as ResourceGrant[];
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

export async function listScopes(config: WeldallConfig, resource?: string) {
  return withLock(() =>
    withAccess(config, async (session) => {
      const grants = await registry(config, session);
      const filtered = resource ? grants.filter((grant) => grant.name === resource) : grants;
      if (resource && filtered.length === 0)
        throw new CliError(`No resource named ${JSON.stringify(resource)} is granted`);
      return filtered;
    }),
  );
}

const safeHttpsOrigin = (value: string, label: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new CliError(`Weldall returned an invalid ${label}`, { cause: error });
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new CliError(`Weldall returned an unsafe ${label}`);
  }
  return url;
};

const targetUrl = (value: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new CliError("Request URL must be an absolute HTTPS URL", { cause: error });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new CliError("Request URL must be HTTPS and must not contain credentials or a fragment");
  }
  return url;
};

export async function resourceRequest(
  config: WeldallConfig,
  input: {
    url: string;
    method: string;
    scopes: string[];
    headers?: Record<string, string>;
    body?: string;
    json?: unknown;
  },
) {
  return withLock(() =>
    withAccess(config, async (session) => {
      const target = targetUrl(input.url);
      const grants = await registry(config, session);
      const requestedScopes = [...new Set(input.scopes)].sort();
      const candidates = grants.filter((candidate) =>
        requestedScopes.every((scope) => candidate.scopes.includes(scope)),
      );
      if (candidates.length === 0) {
        throw new CliError("The requested scopes are not granted for one resource");
      }
      if (candidates.length > 1) {
        throw new CliError("The requested scopes match multiple resources", {
          hint: "Use resource-specific scope names so Weldall can select one authorization server.",
        });
      }
      const grant = candidates[0]!;
      const authorizationServer = safeHttpsOrigin(
        grant.authorizationServer,
        "resource authorization server",
      );

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
            audience: grant.authorizationServer,
            resource: grant.resource,
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
          authorizationServer: grant.authorizationServer,
          resource: grant.resource,
          clientId: grant.downstreamClientId,
          scopes: requestedScopes,
        },
      );

      const downstreamTokenEndpoint = new URL("/oauth/token", authorizationServer).toString();
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
      return successfulResponse(
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
