import { loadEs256KeyPairFromEnv } from "@weldall/sdk";
import { SignJWT, importJWK, type JWK, type JWTPayload } from "jose";

let cachedSource: string | undefined;
let cachedKey: Promise<{ kid: string; privateJwk: JWK; publicJwk: JWK }> | undefined;

export function getWeldallSigningKey() {
  const kid = process.env.WELDALL_SIGNING_KID;
  const privateValue = process.env.WELDALL_SIGNING_PRIVATE_JWK;
  const publicValue = process.env.WELDALL_SIGNING_PUBLIC_JWK;
  if (!kid) throw new Error("WELDALL_SIGNING_KID is required");
  const source = `${kid}\u0000${privateValue ?? ""}\u0000${publicValue ?? ""}`;
  if (source !== cachedSource || !cachedKey) {
    cachedSource = source;
    cachedKey = loadEs256KeyPairFromEnv({
      privateName: "WELDALL_SIGNING_PRIVATE_JWK",
      privateValue,
      publicName: "WELDALL_SIGNING_PUBLIC_JWK",
      publicValue,
    }).then((key) => ({ ...key, kid }));
  }
  return cachedKey;
}

export async function signWeldallJwt(payload: JWTPayload): Promise<string> {
  const key = await getWeldallSigningKey();
  return new SignJWT(payload)
    .setProtectedHeader({
      alg: "ES256",
      kid: key.kid,
      typ: typeof payload.scope === "string" ? "at+jwt" : "JWT",
    })
    .sign(await importJWK(key.privateJwk, "ES256"));
}
