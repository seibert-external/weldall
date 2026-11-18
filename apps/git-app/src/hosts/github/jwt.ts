import { createPrivateKey, sign } from "node:crypto";

/** GitHub recommends backdating `iat` by 60 seconds against clock drift. */
export const APP_JWT_CLOCK_SKEW_SECONDS = 60;
/**
 * GitHub rejects `exp` more than 10 minutes ahead. Nine minutes keeps the token valid for GitHub
 * even when this server's clock runs up to a minute ahead.
 */
export const APP_JWT_LIFETIME_SECONDS = 9 * 60;

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Creates the short-lived RS256 JWT that authenticates as the App itself. */
export function createAppJwt({
  appId,
  privateKey,
  now = Date.now(),
}: {
  appId: string;
  privateKey: string;
  now?: number;
}): string {
  const seconds = Math.floor(now / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: seconds - APP_JWT_CLOCK_SKEW_SECONDS,
    exp: seconds + APP_JWT_LIFETIME_SECONDS,
    iss: appId,
  })}`;
  const signature = sign("sha256", Buffer.from(unsigned), createPrivateKey(privateKey));
  return `${unsigned}.${signature.toString("base64url")}`;
}
