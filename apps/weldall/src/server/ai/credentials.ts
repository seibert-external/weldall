import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const ALGORITHM = "A256GCM";
const CIPHER_ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = 1;
const PURPOSE = "chat-api-key";

const envelopeSchema = z
  .object({
    version: z.literal(ENVELOPE_VERSION),
    algorithm: z.literal(ALGORITHM),
    keyVersion: z.number().int().positive(),
    nonce: z.string().min(1),
    ciphertext: z.string(),
    tag: z.string().min(1),
  })
  .strict();

export function encryptChatApiKey(
  settingsId: string,
  apiKey: string,
): { encryptedApiKey: string; encryptionKeyVersion: number } {
  const keyVersion = encryptionKeyVersion();
  const nonce = randomBytes(12);
  const cipher = createCipheriv(CIPHER_ALGORITHM, encryptionKey(), nonce);
  cipher.setAAD(associatedData(settingsId, keyVersion));
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return {
    encryptedApiKey: JSON.stringify({
      version: ENVELOPE_VERSION,
      algorithm: ALGORITHM,
      keyVersion,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    }),
    encryptionKeyVersion: keyVersion,
  };
}

export function decryptChatApiKey(input: {
  id: string;
  encryptedApiKey: string;
  encryptionKeyVersion: number;
}): string {
  try {
    const envelope = envelopeSchema.parse(JSON.parse(input.encryptedApiKey));
    if (envelope.keyVersion !== input.encryptionKeyVersion) throw new Error("version mismatch");
    const decipher = createDecipheriv(
      CIPHER_ALGORITHM,
      encryptionKey(),
      Buffer.from(envelope.nonce, "base64url"),
    );
    decipher.setAAD(associatedData(input.id, envelope.keyVersion));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("The chat API credential cannot be decrypted.");
  }
}

function encryptionKeyVersion(): number {
  const version = Number(process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY_VERSION ?? "1");
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("Weldall credential encryption key version is invalid.");
  }
  return version;
}

function encryptionKey(): Buffer {
  const configured = process.env.WELDALL_CREDENTIAL_ENCRYPTION_KEY;
  if (!configured) throw new Error("WELDALL_CREDENTIAL_ENCRYPTION_KEY is required.");
  const key = Buffer.from(configured, "base64");
  if (key.byteLength !== 32) {
    throw new Error("WELDALL_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }
  return key;
}

function associatedData(settingsId: string, keyVersion: number): Buffer {
  return Buffer.from(`${PURPOSE}\0${settingsId}\0${keyVersion}`, "utf8");
}
