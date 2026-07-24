import { SignJWT, importJWK, jwtVerify, type JWK, type JWTPayload } from "jose";
import { validateEs256KeyPair } from "./crypto.js";
import { OAuthError } from "./errors.js";
export async function signEs256(
  payload: JWTPayload,
  key: { kid: string; privateJwk: JWK; typ?: string },
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: key.typ ?? "JWT" })
    .sign(await importJWK(key.privateJwk, "ES256"));
}
export async function verifyEs256(
  token: string,
  input: {
    kid: string;
    publicJwk: JWK;
    issuer: string;
    audience: string;
    maxTokenAge?: string;
    typ?: string;
  },
): Promise<JWTPayload> {
  try {
    const result = await jwtVerify(token, await importJWK(input.publicJwk, "ES256"), {
      algorithms: ["ES256"],
      issuer: input.issuer,
      audience: input.audience,
      requiredClaims: ["iss", "aud", "exp", "iat"],
      clockTolerance: 5,
      ...(input.maxTokenAge ? { maxTokenAge: input.maxTokenAge } : {}),
    });
    if (
      result.protectedHeader.kid !== input.kid ||
      result.protectedHeader.typ !== (input.typ ?? "JWT")
    )
      throw new Error("header");
    return result.payload;
  } catch {
    throw new OAuthError("invalid_grant", "token validation failed");
  }
}
export function parseJwkEnv(name: string, value: string | undefined): JWK {
  if (!value) throw new Error(`${name} is required`);
  try {
    return JSON.parse(value) as JWK;
  } catch {
    throw new Error(`${name} must be JSON`);
  }
}

export async function loadEs256KeyPairFromEnv(input: {
  privateName: string;
  privateValue: string | undefined;
  publicName: string;
  publicValue: string | undefined;
}): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  return validateEs256KeyPair(
    parseJwkEnv(input.privateName, input.privateValue),
    parseJwkEnv(input.publicName, input.publicValue),
  );
}
