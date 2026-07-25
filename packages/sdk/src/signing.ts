import { createPrivateKey, createPublicKey, type JsonWebKey } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  calculateJwkThumbprint,
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from "jose";
import { assertPublicP256, safeEqual, validateEs256KeyPair } from "./crypto.js";
import { WeldallAuthError } from "./errors.js";
import { signEs256 } from "./jwt.js";
import type { DirectSigningKey, ProviderSigningKey, Signing, SigningKeyProvider } from "./types.js";

const isDirect = (signing: Signing): signing is DirectSigningKey => "privateJwk" in signing;

export function assertSigningConfig(signing: Signing): void {
  if (!signing || typeof signing !== "object") throw new TypeError("signingKey is required");
  if (isDirect(signing)) {
    if (
      typeof signing.kid !== "string" ||
      !signing.kid ||
      !signing.privateJwk ||
      !signing.publicJwk
    )
      throw new TypeError("invalid direct signing key");
    try {
      if (
        signing.privateJwk.kty !== "EC" ||
        signing.privateJwk.crv !== "P-256" ||
        !signing.privateJwk.d ||
        signing.publicJwk.kty !== "EC" ||
        signing.publicJwk.crv !== "P-256" ||
        signing.publicJwk.d
      )
        throw new Error("shape");
      const derived = createPublicKey(
        createPrivateKey({ key: signing.privateJwk as JsonWebKey, format: "jwk" }),
      ).export({ format: "jwk" });
      createPublicKey({ key: signing.publicJwk as JsonWebKey, format: "jwk" });
      if (
        typeof derived.x !== "string" ||
        typeof derived.y !== "string" ||
        typeof signing.publicJwk.x !== "string" ||
        typeof signing.publicJwk.y !== "string" ||
        !safeEqual(derived.x, signing.publicJwk.x) ||
        !safeEqual(derived.y, signing.publicJwk.y)
      )
        throw new Error("mismatch");
    } catch {
      throw new TypeError("invalid direct ES256 signing key");
    }
    return;
  }
  if (typeof signing.current !== "function" || typeof signing.jwks !== "function")
    throw new TypeError("invalid signing key provider");
}

export function createSigningProvider(signing: Signing): SigningKeyProvider {
  if (!isDirect(signing)) return signing;
  let validated: Promise<{ privateJwk: JWK; publicJwk: JWK }> | undefined;
  const get = () => (validated ??= validateEs256KeyPair(signing.privateJwk, signing.publicJwk));
  return {
    async current() {
      const key = await get();
      return {
        kid: signing.kid,
        publicJwk: key.publicJwk,
        sign: (payload, header) =>
          signEs256(payload, { kid: header.kid, privateJwk: key.privateJwk, typ: header.typ }),
      };
    },
    async jwks() {
      const key = await get();
      return [{ ...key.publicJwk, kid: signing.kid, alg: "ES256", use: "sig" }];
    },
  };
}

export async function validatedJwks(provider: SigningKeyProvider): Promise<JWK[]> {
  let keys: readonly JWK[];
  try {
    keys = await provider.jwks();
  } catch {
    throw new WeldallAuthError("server_error", "signing provider unavailable", 500);
  }
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 20)
    throw new WeldallAuthError("server_error", "signing provider returned an invalid JWKS", 500);
  const result: JWK[] = [];
  const kids = new Set<string>();
  for (const candidate of keys) {
    const kid = candidate.kid;
    if (typeof kid !== "string" || !kid || kids.has(kid))
      throw new WeldallAuthError("server_error", "signing provider returned an invalid JWKS", 500);
    try {
      await assertPublicP256(candidate);
    } catch {
      throw new WeldallAuthError("server_error", "signing provider returned an invalid JWKS", 500);
    }
    kids.add(kid);
    result.push({ ...candidate, kid, alg: "ES256", use: "sig" });
  }
  return result;
}

export async function signWithProvider(
  provider: SigningKeyProvider,
  payload: JWTPayload,
  typ: string,
): Promise<string> {
  let key: ProviderSigningKey;
  try {
    key = await provider.current();
  } catch {
    throw new WeldallAuthError("server_error", "signing provider unavailable", 500);
  }
  if (!key || typeof key.kid !== "string" || !key.kid || typeof key.sign !== "function")
    throw new WeldallAuthError("server_error", "signing provider returned an invalid key", 500);
  const verificationJwk = structuredClone(key.publicJwk);
  try {
    await assertPublicP256(verificationJwk);
  } catch {
    throw new WeldallAuthError("server_error", "signing provider returned an invalid key", 500);
  }
  const published = await validatedJwks(provider);
  const publishedKey = published.find((candidate) => candidate.kid === key.kid);
  if (
    !publishedKey ||
    !safeEqual(
      await calculateJwkThumbprint(publishedKey, "sha256"),
      await calculateJwkThumbprint(verificationJwk, "sha256"),
    )
  )
    throw new WeldallAuthError(
      "server_error",
      "active signing key is not present in provider JWKS",
      500,
    );
  const header = { alg: "ES256" as const, kid: key.kid, typ };
  const expectedPayload = structuredClone(payload);
  let token: string;
  try {
    token = await key.sign(structuredClone(expectedPayload), header);
  } catch {
    throw new WeldallAuthError("server_error", "token signing failed", 500);
  }
  try {
    const verified = await jwtVerify(token, await importJWK(verificationJwk, "ES256"), {
      algorithms: ["ES256"],
      typ,
    });
    const actualHeader = decodeProtectedHeader(token);
    if (
      actualHeader.kid !== key.kid ||
      actualHeader.alg !== "ES256" ||
      actualHeader.typ !== typ ||
      !isDeepStrictEqual(decodeJwt(token), expectedPayload) ||
      !isDeepStrictEqual(verified.payload, expectedPayload)
    )
      throw new Error("provider changed token");
  } catch {
    throw new WeldallAuthError(
      "server_error",
      "signing provider returned an invalid signature",
      500,
    );
  }
  return token;
}
