import { base64url, sha256Base64url, utf8Base64url } from "./base64.js";

export function normalizeRequestTarget(input: string | URL): string {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new TypeError(
      "DPoP target must be an absolute HTTPS URL without credentials or fragment",
    );
  if (url.pathname.includes("%"))
    throw new TypeError("DPoP target paths must not contain percent encoding");
  return url.toString();
}

/** RFC 9449 `htu` excludes query and fragment components. */
export function normalizeHtu(input: string | URL): string {
  const url = new URL(normalizeRequestTarget(input));
  url.search = "";
  return url.toString();
}

export async function calculateJkt(publicJwk: JsonWebKey): Promise<string> {
  if (
    publicJwk.kty !== "EC" ||
    publicJwk.crv !== "P-256" ||
    !publicJwk.x ||
    !publicJwk.y ||
    publicJwk.d
  )
    throw new TypeError("Expected a public P-256 JWK");
  return sha256Base64url(
    JSON.stringify({ crv: "P-256", kty: "EC", x: publicJwk.x, y: publicJwk.y }),
  );
}

export async function createBrowserDpopProof(input: {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  method: string;
  url: string | URL;
  accessToken?: string;
}): Promise<string> {
  const htu = normalizeHtu(input.url);
  const header = utf8Base64url(
    JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: input.publicJwk }),
  );
  const payload = utf8Base64url(
    JSON.stringify({
      htu,
      htm: input.method.toUpperCase(),
      iat: Math.floor(Date.now() / 1_000),
      jti: crypto.randomUUID(),
      ...(input.accessToken ? { ath: await sha256Base64url(input.accessToken) } : {}),
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    input.privateKey,
    new TextEncoder().encode(signingInput),
  );
  const raw = new Uint8Array(signature);
  if (raw.byteLength !== 64) throw new TypeError("Browser returned a non-JOSE ES256 signature");
  return `${signingInput}.${base64url(raw)}`;
}
