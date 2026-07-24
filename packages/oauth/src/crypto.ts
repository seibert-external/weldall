import { createHash, timingSafeEqual } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import type { DpopKeyPair } from "./types.js";
export const base64urlSha256 = (value: string): string =>
  createHash("sha256").update(value, "ascii").digest("base64url");
export const safeEqual = (a: string, b: string): boolean => {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
export const isSha256JwkThumbprint = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export async function publicJwk(jwk: JWK): Promise<JWK> {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y)
    throw new Error("invalid P-256 JWK");
  await importJWK(jwk, "ES256");
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}
export async function generateEs256KeyPair(): Promise<DpopKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  const pub = await exportJWK(publicKey);
  return { privateJwk, publicJwk: pub, jkt: await calculateJwkThumbprint(pub, "sha256") };
}
export async function assertPublicP256(jwk: JWK): Promise<void> {
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    !jwk.x ||
    !jwk.y ||
    jwk.d ||
    (jwk.alg !== undefined && jwk.alg !== "ES256") ||
    (jwk.use !== undefined && jwk.use !== "sig") ||
    (jwk.key_ops !== undefined &&
      (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== "verify")) ||
    Object.keys(jwk).some(
      (k) => !["kty", "crv", "x", "y", "use", "key_ops", "kid", "alg"].includes(k),
    )
  )
    throw new Error("invalid public P-256 JWK");
  await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, "ES256");
}

export async function validateEs256KeyPair(
  privateJwk: JWK,
  configuredPublicJwk: JWK,
): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  if (
    privateJwk.kty !== "EC" ||
    privateJwk.crv !== "P-256" ||
    !privateJwk.x ||
    !privateJwk.y ||
    !privateJwk.d
  )
    throw new Error("invalid private P-256 JWK");
  await importJWK(privateJwk, "ES256");
  await assertPublicP256(configuredPublicJwk);
  const derivedPublicJwk = await publicJwk(privateJwk);
  const [derivedJkt, configuredJkt] = await Promise.all([
    calculateJwkThumbprint(derivedPublicJwk, "sha256"),
    calculateJwkThumbprint(configuredPublicJwk, "sha256"),
  ]);
  if (!safeEqual(derivedJkt, configuredJkt)) throw new Error("ES256 public/private key mismatch");
  return { privateJwk, publicJwk: derivedPublicJwk };
}
