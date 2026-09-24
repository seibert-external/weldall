import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Prisma, EncryptedValue } from "@weldall/db";
import { ConnectorError } from "./contracts";
import { resolveKeyMaterial } from "./key-providers";

type Client = Prisma.TransactionClient;
/** Builds the stable service error used when configured encryption material cannot be resolved. */
const createKeyUnavailableError = () =>
  new ConnectorError(
    "key_unavailable",
    "Encryption key is unavailable or changed. Restore its original material.",
    503,
  );
/** Resolves one immutable provider binding into the data key needed by connector encryption. */
async function resolveEncryptionKeyVersion({
  tx,
  keyId,
  version,
}: {
  tx: Client;
  keyId: string;
  version: string;
}) {
  const binding = await tx.encryptionKeyVersion.findUnique({
    where: { keyId_version: { keyId, version } },
  });
  if (!binding) throw createKeyUnavailableError();
  return resolveKeyMaterial(binding);
}
/** Binds ciphertext to its database record and application context to prevent substitution. */
const buildAdditionalAuthenticatedData = ({
  keyId,
  keyVersion,
  context,
}: {
  keyId: string;
  keyVersion: string;
  context: string;
}) => Buffer.from(JSON.stringify([1, keyId, keyVersion, context]));

/** Encrypts one connector secret with purpose-bound AAD before it enters private database storage. */
export async function encrypt({
  tx,
  keyId,
  plaintext,
  context,
}: {
  tx: Client;
  keyId: string;
  plaintext: string;
  context: string;
}) {
  const logical = await tx.encryptionKey.findUniqueOrThrow({ where: { id: keyId } });
  const keyVersion = logical.activeVersion;
  const key = await resolveEncryptionKeyVersion({ tx, keyId, version: keyVersion });
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(buildAdditionalAuthenticatedData({ keyId, keyVersion, context }));
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
/**
 * Decrypts private connector storage with the envelope's historical key, never the connector's
 * current selection, and deliberately provides no plaintext fallback.
 */
export async function decrypt({
  tx,
  envelope,
  context,
}: {
  tx: Client;
  envelope: EncryptedValue;
  context: string;
}): Promise<string> {
  if (envelope.formatVersion !== 1 || envelope.context !== context)
    throw createKeyUnavailableError();
  const key = await resolveEncryptionKeyVersion({
    tx,
    keyId: envelope.keyId,
    version: envelope.keyVersion,
  });
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
    decipher.setAAD(
      buildAdditionalAuthenticatedData({
        keyId: envelope.keyId,
        keyVersion: envelope.keyVersion,
        context,
      }),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw createKeyUnavailableError();
  }
}
/** Reads one encrypted connector secret for an authenticated server-side workflow. */
export async function readSecret({ tx, id, context }: { tx: Client; id: string; context: string }) {
  return decrypt({
    tx,
    envelope: await tx.encryptedValue.findUniqueOrThrow({ where: { id } }),
    context,
  });
}

/** Creates or rotates one encrypted connector secret without exposing plaintext through public APIs. */
export async function saveSecret({
  tx,
  keyId,
  context,
  value,
  id,
}: {
  tx: Client;
  keyId: string;
  context: string;
  value: string;
  id?: string | null;
}) {
  const data = await encrypt({ tx, keyId, plaintext: value, context });
  return id
    ? tx.encryptedValue.update({ where: { id }, data: { ...data, version: { increment: 1 } } })
    : tx.encryptedValue.create({ data });
}
