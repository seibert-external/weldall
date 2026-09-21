import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type ConnectorSecretPurpose = "connector-config" | "authorization" | "handoff";

function credentialKey(): Buffer {
  const value = process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY ?? "";
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error("WELDALL_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

export function sealConnectorValue(
  purpose: ConnectorSecretPurpose,
  id: string,
  value: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", credentialKey(), iv);
  cipher.setAAD(Buffer.from(`weldall-connector:v1:${purpose}:${id}`));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    encrypted.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

export function unsealConnectorValue(
  purpose: ConnectorSecretPurpose,
  id: string,
  value: string,
): string {
  try {
    const [version, iv, encrypted, tag, extra] = value.split(".");
    if (version !== "v1" || !iv || !encrypted || !tag || extra) throw new Error("invalid value");
    const decipher = createDecipheriv("aes-256-gcm", credentialKey(), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(`weldall-connector:v1:${purpose}:${id}`));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Connector credential is unavailable");
  }
}
