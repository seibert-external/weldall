import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { LoginError } from "./oidc-config";
export const randomValue = () => randomBytes(32).toString("base64url");
export const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
const setupTokenPattern = /^[A-Za-z0-9_-]{43,128}$/;
// Return variable names only; never pass configured secrets to the browser.
export function setupConfigurationIssues(): string[] {
  const issues: string[] = [];
  if (!setupTokenPattern.test(process.env.WELDALL_SETUP_TOKEN ?? ""))
    issues.push("WELDALL_SETUP_TOKEN");
  try {
    key();
  } catch {
    issues.push("WELDALL_CREDENTIAL_ENCRYPTION_KEY");
  }
  return issues;
}
export function requireSetupToken(value: string) {
  const expected = process.env.WELDALL_SETUP_TOKEN;
  if (!expected || !setupTokenPattern.test(expected)) throw new LoginError("setup_unavailable");
  if (!timingSafeEqual(Buffer.from(digest(value)), Buffer.from(digest(expected))))
    throw new LoginError("setup_unauthorized");
}
function key() {
  const value = process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY ?? "";
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value)
    throw new LoginError("encryption_unavailable");
  return key;
}
/**
 * Encrypts an OIDC provider secret or transient login-attempt payload before database storage.
 * AES-GCM authenticated data binds the ciphertext to its purpose and row id to prevent swaps.
 */
export function seal(purpose: "provider" | "attempt", id: string, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(`weldall-login:v1:${purpose}:${id}`));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    encrypted.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}
/** Decrypts a sealed database value and rejects a changed key, purpose, row id, or payload. */
export function unseal(purpose: "provider" | "attempt", id: string, value: string): string {
  try {
    const [version, iv, encrypted, tag, extra] = value.split(".");
    if (version !== "v1" || !iv || !encrypted || !tag || extra) throw new Error();
    const cipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    cipher.setAAD(Buffer.from(`weldall-login:v1:${purpose}:${id}`));
    cipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      cipher.update(Buffer.from(encrypted, "base64url")),
      cipher.final(),
    ]).toString("utf8");
  } catch {
    throw new LoginError("credential_unavailable");
  }
}
