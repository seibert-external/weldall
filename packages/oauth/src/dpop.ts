import { randomUUID } from "node:crypto";
import {
  SignJWT,
  calculateJwkThumbprint,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";
import { DPOP_FUTURE_SKEW_SECONDS, DPOP_MAX_AGE_SECONDS } from "./constants.js";
import { assertPublicP256, base64urlSha256, safeEqual } from "./crypto.js";
import { OAuthError } from "./errors.js";
import { ReplayStore } from "./replay.js";
import type { VerifiedDpop } from "./types.js";
export function normalizeHtu(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
    throw new OAuthError("invalid_dpop_proof", "invalid htu scheme");
  if (url.username || url.password)
    throw new OAuthError("invalid_dpop_proof", "htu must not contain credentials");
  url.search = "";
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  )
    url.port = "";
  return url.toString();
}
export async function createDpopProof(input: {
  privateJwk: JWK;
  publicJwk: JWK;
  method: string;
  url: string;
  accessToken?: string;
  now?: number;
  jti?: string;
}): Promise<string> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    htm: input.method.toUpperCase(),
    htu: normalizeHtu(input.url),
    iat: now,
    jti: input.jti ?? randomUUID(),
  };
  if (input.accessToken) payload.ath = base64urlSha256(input.accessToken);
  const key = await importJWK(input.privateJwk, "ES256");
  return new SignJWT(payload)
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: input.publicJwk })
    .sign(key);
}
export async function verifyStrictDpop(
  proof: string,
  input: {
    method: string;
    url: string;
    replay: ReplayStore;
    accessToken?: string;
    expectedJkt?: string;
    now?: number;
  },
): Promise<VerifiedDpop> {
  let header: ReturnType<typeof decodeProtectedHeader>;
  let proofJwk: JWK;
  try {
    header = decodeProtectedHeader(proof);
    if (header.typ !== "dpop+jwt" || header.alg !== "ES256" || header.crit || !header.jwk)
      throw new Error("header");
    proofJwk = header.jwk;
    await assertPublicP256(proofJwk);
  } catch {
    throw new OAuthError("invalid_dpop_proof", "invalid DPoP header");
  }
  let payload;
  try {
    const key = await importJWK(proofJwk, "ES256");
    ({ payload } = await jwtVerify(proof, key, { algorithms: ["ES256"], typ: "dpop+jwt" }));
  } catch {
    throw new OAuthError("invalid_dpop_proof", "invalid DPoP signature");
  }
  const { htm, htu, iat, jti, ath } = payload;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  let proofUrl: URL | undefined;
  if (typeof htu === "string") {
    try {
      proofUrl = new URL(htu);
    } catch {
      throw new OAuthError("invalid_dpop_proof", "invalid DPoP htu");
    }
  }
  if (
    typeof htm !== "string" ||
    htm !== input.method.toUpperCase() ||
    !proofUrl ||
    proofUrl.search !== "" ||
    proofUrl.hash !== "" ||
    normalizeHtu(proofUrl.toString()) !== normalizeHtu(input.url) ||
    !Number.isInteger(iat) ||
    (iat as number) < now - DPOP_MAX_AGE_SECONDS ||
    (iat as number) > now + DPOP_FUTURE_SKEW_SECONDS ||
    typeof jti !== "string" ||
    jti.length < 1 ||
    jti.length > 128
  )
    throw new OAuthError("invalid_dpop_proof", "invalid DPoP claims");
  const jkt = await calculateJwkThumbprint(header.jwk, "sha256");
  if (input.expectedJkt !== undefined && !safeEqual(jkt, input.expectedJkt))
    throw new OAuthError("invalid_dpop_proof", "DPoP key mismatch");
  if (input.accessToken) {
    if (typeof ath !== "string" || !safeEqual(ath, base64urlSha256(input.accessToken)))
      throw new OAuthError("invalid_dpop_proof", "access token hash mismatch");
  } else if (ath !== undefined)
    throw new OAuthError("invalid_dpop_proof", "ath is not allowed at this endpoint");
  input.replay.consume(
    `${jkt}:${jti}`,
    ((iat as number) + DPOP_MAX_AGE_SECONDS + 1) * 1000,
    now * 1000,
  );
  return { payload: payload as VerifiedDpop["payload"], publicJwk: proofJwk, jkt };
}
