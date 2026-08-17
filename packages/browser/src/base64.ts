export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function utf8Base64url(value: string): string {
  return base64url(new TextEncoder().encode(value));
}

export async function sha256Base64url(value: string): Promise<string> {
  return base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new TypeError("JWT payload is missing");
  const padded = part
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(part.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("JWT payload is invalid");
  return value as Record<string, unknown>;
}
