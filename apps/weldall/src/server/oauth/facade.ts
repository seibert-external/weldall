import { createHash, randomUUID } from "node:crypto";
import { db, type OAuthDeviceRefreshBinding } from "@weldall/db";
import {
  ID_JAG_TOKEN_TYPE,
  WeldallAuthError,
  REFRESH_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT,
  inMemory,
  issueIdJag,
  oauthErrorResponse,
  safeEqual,
  verifyEs256,
  verifyStrictDpop,
} from "@weldall/sdk";
import {
  WELDALL_CLIENT_ID,
  WELDALL_ISSUER,
  WELDALL_RESOURCE,
  WELDALL_REVOCATION_ENDPOINT,
  WELDALL_TOKEN_ENDPOINT,
} from "./constants";
import { auth } from "../auth/auth";
import { exchangePolicyFor } from "../policy/resources";
import { getWeldallSigningKey } from "./jwt";

const hash = (value: string) => createHash("sha256").update(value, "ascii").digest("base64url");
const confirmationJkt = (value: unknown): string | undefined => {
  let confirmation = value;
  if (typeof confirmation === "string") {
    try {
      confirmation = JSON.parse(confirmation);
    } catch {
      return undefined;
    }
  }
  if (!confirmation || typeof confirmation !== "object" || Array.isArray(confirmation))
    return undefined;
  const jkt = (confirmation as Record<string, unknown>).jkt;
  return typeof jkt === "string" && jkt.length > 0 ? jkt : undefined;
};
const replay = inMemory({ suppressWarning: true });
const securityParameters = [
  "grant_type",
  "code",
  "redirect_uri",
  "code_verifier",
  "refresh_token",
  "token",
  "token_type_hint",
  "client_id",
  "requested_token_type",
  "audience",
  "resource",
  "scope",
  "subject_token",
  "subject_token_type",
] as const;

function rejectDuplicateParameters(form: FormData): void {
  if (securityParameters.some((name) => form.getAll(name).length > 1))
    throw new WeldallAuthError("invalid_request", "duplicate OAuth parameter");
}

function requiredString(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string") throw new WeldallAuthError("invalid_request", `missing ${name}`);
  return value;
}

const findBinding = (token: string) =>
  db.oAuthDeviceRefreshBinding.findUnique({ where: { tokenHash: hash(token) } });

async function validateBoundProof(
  request: Request,
  binding?: OAuthDeviceRefreshBinding | null,
  url = WELDALL_TOKEN_ENDPOINT,
) {
  const proof = request.headers.get("dpop");
  if (!proof) throw new WeldallAuthError("invalid_dpop_proof");
  return verifyStrictDpop(proof, {
    method: "POST",
    url,
    replay,
    ...(binding ? { expectedJkt: binding.dpopJkt } : {}),
  });
}

async function exchange(request: Request, form: FormData) {
  if (
    requiredString(form, "requested_token_type") !== ID_JAG_TOKEN_TYPE ||
    requiredString(form, "subject_token_type") !== REFRESH_TOKEN_TYPE ||
    requiredString(form, "client_id") !== WELDALL_CLIENT_ID
  )
    throw new WeldallAuthError("invalid_target");
  const audience = requiredString(form, "audience");
  const resourceIdentifier = requiredString(form, "resource");
  const subject = requiredString(form, "subject_token");
  const tokenHash = hash(subject);
  const [binding, providerToken] = await Promise.all([
    findBinding(subject),
    db.oauthRefreshToken.findUnique({ where: { token: tokenHash } }),
  ]);
  const providerJkt = confirmationJkt(providerToken?.confirmation);
  if (
    !binding ||
    binding.clientId !== WELDALL_CLIENT_ID ||
    binding.revokedAt ||
    binding.rotatedAt ||
    binding.expiresAt <= new Date() ||
    !providerToken ||
    providerToken.clientId !== binding.clientId ||
    providerToken.userId !== binding.userId ||
    providerToken.revoked ||
    providerToken.rotatedAt ||
    providerToken.expiresAt <= new Date() ||
    typeof providerJkt !== "string" ||
    !safeEqual(providerJkt, binding.dpopJkt)
  )
    throw new WeldallAuthError("invalid_grant");
  await validateBoundProof(request, binding);
  const user = await db.user.findUnique({ where: { id: binding.userId } });
  if (!user?.emailVerified) throw new WeldallAuthError("invalid_grant");
  const policy = await exchangePolicyFor({
    email: user.email,
    resourceIdentifier,
    authorizationServer: audience,
  });
  if (!policy) throw new WeldallAuthError("invalid_target");
  const scopes = [...new Set(requiredString(form, "scope").split(" ").filter(Boolean))].sort();
  if (
    !scopes.length ||
    scopes.some(
      (scope) => !policy.supportedScopes.includes(scope) || !policy.grantedScopes.includes(scope),
    )
  )
    throw new WeldallAuthError("invalid_scope");
  const signingKey = await getWeldallSigningKey();
  const accessToken = await issueIdJag({
    issuer: WELDALL_ISSUER,
    subject: user.id,
    audience: policy.authorizationServer,
    clientId: policy.downstreamClientId,
    resource: policy.resourceIdentifier,
    scopes,
    jkt: binding.dpopJkt,
    kid: signingKey.kid,
    privateJwk: signingKey.privateJwk,
  });
  return Response.json(
    {
      access_token: accessToken,
      issued_token_type: ID_JAG_TOKEN_TYPE,
      token_type: "N_A",
      expires_in: 300,
      scope: scopes.join(" "),
    },
    { headers: { "cache-control": "no-store", pragma: "no-cache" } },
  );
}

export async function tokenFacade(request: Request) {
  try {
    const form = await request.clone().formData();
    rejectDuplicateParameters(form);
    const grantType = requiredString(form, "grant_type");
    if (grantType === TOKEN_EXCHANGE_GRANT) return await exchange(request, form);

    let previous: OAuthDeviceRefreshBinding | null = null;
    let verifiedJkt: string | undefined;
    if (grantType === "refresh_token") {
      previous = await findBinding(requiredString(form, "refresh_token"));
      if (!previous || previous.revokedAt || previous.expiresAt <= new Date())
        throw new WeldallAuthError("invalid_grant");
      if (previous.rotatedAt) {
        await db.oAuthDeviceRefreshBinding.updateMany({
          where: { familyId: previous.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        throw new WeldallAuthError("invalid_grant", "refresh token reuse detected");
      }
      verifiedJkt = (await validateBoundProof(request, previous)).jkt;
    }

    // Better Auth validates DPoP against request.url. Canonicalize the URL because
    // Next.js may expose Caddy's internal upstream URL instead of the public endpoint.
    const response = await auth.handler(new Request(WELDALL_TOKEN_ENDPOINT, request));
    if (grantType === "refresh_token" && previous && !response.ok) {
      const providerError = (await response
        .clone()
        .json()
        .catch(() => null)) as { error?: unknown } | null;
      if (providerError?.error === "invalid_grant")
        await db.oAuthDeviceRefreshBinding.updateMany({
          where: { familyId: previous.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      return response;
    }
    if (!response.ok || (grantType !== "authorization_code" && grantType !== "refresh_token"))
      return response;

    const data = (await response.clone().json()) as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
    };
    if (!data.refresh_token || !data.access_token || data.token_type !== "DPoP")
      throw new WeldallAuthError("server_error", "invalid provider token response", 500);

    if (!verifiedJkt) verifiedJkt = (await validateBoundProof(request)).jkt;
    const signingKey = await getWeldallSigningKey();
    const payload = await verifyEs256(data.access_token, {
      issuer: WELDALL_ISSUER,
      audience: WELDALL_RESOURCE,
      kid: signingKey.kid,
      publicJwk: signingKey.publicJwk,
      typ: "at+jwt",
      errorCode: "server_error",
      errorStatus: 500,
    });
    const audiences =
      typeof payload.aud === "string"
        ? [payload.aud]
        : Array.isArray(payload.aud) &&
            payload.aud.every((audience) => typeof audience === "string")
          ? payload.aud
          : [];
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      !audiences.includes(WELDALL_RESOURCE) ||
      new Set(audiences).size !== audiences.length ||
      payload.client_id !== WELDALL_CLIENT_ID ||
      (audiences.length > 1 && payload.azp !== WELDALL_CLIENT_ID) ||
      typeof (payload.cnf as { jkt?: unknown } | undefined)?.jkt !== "string" ||
      !safeEqual((payload.cnf as { jkt: string }).jkt, verifiedJkt)
    )
      throw new WeldallAuthError("server_error", "provider returned an unbound token", 500);

    const tokenHash = hash(data.refresh_token);
    if (previous) {
      await db.$transaction([
        db.oAuthDeviceRefreshBinding.update({
          where: { id: previous.id },
          data: { rotatedAt: new Date(), replacementHash: tokenHash },
        }),
        db.oAuthDeviceRefreshBinding.create({
          data: {
            tokenHash,
            familyId: previous.familyId,
            clientId: previous.clientId,
            userId: previous.userId,
            dpopJkt: previous.dpopJkt,
            expiresAt: new Date(Date.now() + 30 * 86_400_000),
          },
        }),
      ]);
      const familyWasRevoked = await db.oAuthDeviceRefreshBinding.findFirst({
        where: { familyId: previous.familyId, revokedAt: { not: null } },
        select: { id: true },
      });
      if (familyWasRevoked)
        await db.oAuthDeviceRefreshBinding.updateMany({
          where: { familyId: previous.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
    } else {
      await db.oAuthDeviceRefreshBinding.create({
        data: {
          tokenHash,
          familyId: randomUUID(),
          clientId: WELDALL_CLIENT_ID,
          userId: payload.sub,
          dpopJkt: verifiedJkt,
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
        },
      });
    }
    return response;
  } catch (error) {
    return oauthErrorResponse(error);
  }
}

export async function revocationFacade(request: Request) {
  try {
    const form = await request.clone().formData();
    rejectDuplicateParameters(form);
    const binding = await findBinding(requiredString(form, "token"));
    if (!binding || binding.revokedAt)
      return new Response(null, {
        status: 200,
        headers: { "cache-control": "no-store", pragma: "no-cache" },
      });
    await validateBoundProof(request, binding, WELDALL_REVOCATION_ENDPOINT);
    const response = await auth.handler(new Request(WELDALL_REVOCATION_ENDPOINT, request));
    if (response.ok)
      await db.oAuthDeviceRefreshBinding.updateMany({
        where: { familyId: binding.familyId },
        data: { revokedAt: new Date() },
      });
    return response;
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
