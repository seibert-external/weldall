import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Prisma, EncryptedValue } from "@weldall/db";
import { ConnectorError } from "./contracts";

type Client = Prisma.TransactionClient;
const unavailable = () =>
  new ConnectorError(
    "key_unavailable",
    "Encryption key is unavailable or changed. Restore its original material.",
    503,
  );
/** Only deployment-approved names may be resolved. Values must be canonical base64, exactly 32 random bytes. */
function material(name: string): Buffer {
  const approved = (process.env.WELDALL_ENCRYPTION_SOURCES ?? "").split(",").map((s) => s.trim());
  if (!approved.includes(name)) throw unavailable();
  const value = process.env[name] ?? "";
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw unavailable();
  return key;
}
export function sourceFingerprint(name: string): string {
  return createHash("sha256").update(material(name)).digest("hex");
}
async function resolveVersion(tx: Client, keyId: string, version: string) {
  const binding = await tx.encryptionKeyVersion.findUnique({
    where: { keyId_version: { keyId, version } },
  });
  if (!binding) throw unavailable();
  const key = material(binding.sourceName);
  if (createHash("sha256").update(key).digest("hex") !== binding.fingerprint) throw unavailable();
  return key;
}
const aad = (keyId: string, keyVersion: string, context: string) =>
  Buffer.from(JSON.stringify([1, keyId, keyVersion, context]));
/** Context includes purpose and stable entity ID. Key version, format version and configuration revision are distinct. */
export async function encrypt(tx: Client, keyId: string, plaintext: string, context: string) {
  const logical = await tx.encryptionKey.findUniqueOrThrow({ where: { id: keyId } });
  const keyVersion = logical.activeVersion;
  const key = await resolveVersion(tx, keyId, keyVersion);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(keyId, keyVersion, context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    keyId,
    keyVersion,
    formatVersion: 1,
    context,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
/** Decrypt using the envelope's historical key, never the connector's current selection. No plaintext fallback. */
export async function decrypt(
  tx: Client,
  envelope: EncryptedValue,
  context: string,
): Promise<string> {
  if (envelope.formatVersion !== 1 || envelope.context !== context) throw unavailable();
  const key = await resolveVersion(tx, envelope.keyId, envelope.keyVersion);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
    decipher.setAAD(aad(envelope.keyId, envelope.keyVersion, context));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw unavailable();
  }
}
export async function readSecret(tx: Client, id: string, context: string) {
  return decrypt(tx, await tx.encryptedValue.findUniqueOrThrow({ where: { id } }), context);
}
export async function saveSecret(
  tx: Client,
  keyId: string,
  context: string,
  value: string,
  id?: string | null,
) {
  const data = await encrypt(tx, keyId, value, context);
  return id
    ? tx.encryptedValue.update({ where: { id }, data: { ...data, version: { increment: 1 } } })
    : tx.encryptedValue.create({ data });
}
