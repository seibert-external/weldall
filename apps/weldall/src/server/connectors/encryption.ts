import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Prisma, EncryptedValue, EnvelopeProvider } from "@weldall/db";
import { decodeEnvelopeBytes, buildEnvelopeAad, getEnvelopeProvider } from "./envelope-providers";
import { createEnvelopeError, EnvelopeEncryptionError } from "./envelope-errors";

type Client = Prisma.TransactionClient;

type EncryptionContext = { provider: EnvelopeProvider; context: string; connectorId?: string };

/**
 * Wraps a fresh encryption key before requesting new tokens, so an OpenBao outage cannot
 * leave us with rotated tokens we cannot encrypt for storage. Encryption then happens locally,
 * without another OpenBao call. Always call dispose() in finally, even if the write is abandoned.
 */
export async function prepareSecretEncryption({
  provider,
  context,
  connectorId,
}: EncryptionContext) {
  const metadata = { formatVersion: 1, provider, context };
  const authenticatedContext = { ...metadata, ...(connectorId ? { connectorId } : {}) };
  const dek = randomBytes(32);
  let disposed = false;
  const dispose = () => {
    dek.fill(0);
    disposed = true;
  };
  try {
    const wrappedDek = await getEnvelopeProvider(provider).wrapDek({
      dek,
      context: authenticatedContext,
    });
    return {
      dispose,
      encrypt(plaintext: string) {
        try {
          if (disposed) throw new Error();
          const nonce = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", dek, nonce);
          cipher.setAAD(buildEnvelopeAad({ layer: "data", context: authenticatedContext }));
          const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
          return {
            ...metadata,
            nonce: nonce.toString("base64"),
            ciphertext: ciphertext.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
            wrappedDek,
          };
        } catch {
          throw createEnvelopeError({ code: "envelope_encryption_failed", operation: "encrypt" });
        } finally {
          dispose();
        }
      },
    };
  } catch (error) {
    dispose();
    if (error instanceof EnvelopeEncryptionError) throw error;
    throw createEnvelopeError({ code: "envelope_encryption_failed", operation: "encrypt" });
  }
}

/** Each complete logical-object write gets its own random DEK; only its wrapped form is persisted. */
export async function encrypt({
  plaintext,
  ...context
}: EncryptionContext & { plaintext: string }) {
  const prepared = await prepareSecretEncryption(context);
  try {
    return prepared.encrypt(plaintext);
  } finally {
    prepared.dispose();
  }
}

/** Decrypt only after authorization, using a caller-derived stable entity/purpose context. */
export async function decrypt({
  envelope,
  context,
  connectorId,
}: {
  envelope: Pick<
    EncryptedValue,
    "formatVersion" | "provider" | "context" | "nonce" | "ciphertext" | "tag" | "wrappedDek"
  >;
  context: string;
  connectorId?: string;
}): Promise<string> {
  const authenticatedContext = {
    formatVersion: envelope.formatVersion,
    provider: envelope.provider,
    context,
    ...(connectorId ? { connectorId } : {}),
  };
  let dek: Buffer | undefined;
  try {
    if (envelope.formatVersion !== 1)
      throw createEnvelopeError({ code: "envelope_format_unsupported", operation: "decrypt" });
    if (envelope.context !== context)
      throw createEnvelopeError({ code: "envelope_context_mismatch", operation: "decrypt" });
    dek = await getEnvelopeProvider(envelope.provider).unwrapDek({
      wrappedDek: envelope.wrappedDek,
      context: authenticatedContext,
    });
    if (dek.length !== 32)
      throw createEnvelopeError({ code: "encryption_dek_invalid", operation: "decrypt" });
    const nonce = decodeEnvelopeBytes({
      value: envelope.nonce,
      length: 12,
      operation: "decrypt",
      field: "nonce",
    });
    const tag = decodeEnvelopeBytes({
      value: envelope.tag,
      length: 16,
      operation: "decrypt",
      field: "tag",
    });
    const ciphertext = decodeEnvelopeBytes({
      value: envelope.ciphertext,
      operation: "decrypt",
      field: "ciphertext",
    });
    const cipher = createDecipheriv("aes-256-gcm", dek, nonce);
    cipher.setAAD(buildEnvelopeAad({ layer: "data", context: authenticatedContext }));
    cipher.setAuthTag(tag);
    const plaintext = cipher.update(ciphertext);
    try {
      let final: Buffer;
      try {
        final = cipher.final();
      } catch {
        throw createEnvelopeError({ code: "envelope_authentication_failed", operation: "decrypt" });
      }
      return Buffer.concat([plaintext, final]).toString("utf8");
    } finally {
      plaintext.fill(0);
    }
  } catch (error) {
    if (error instanceof EnvelopeEncryptionError) throw error;
    throw createEnvelopeError({ code: "envelope_decryption_failed", operation: "decrypt" });
  } finally {
    dek?.fill(0);
  }
}

/** Crypto stages deliberately have no database client. */
export const prepareSecretEnvelope = encrypt;
export const decryptSecretEnvelope = decrypt;

/** Load only through the already authorized connector relation; no remote I/O. */
export async function loadSecretEnvelope({
  tx,
  id,
  connectorId,
}: {
  tx: Client;
  id: string;
  connectorId: string;
}) {
  const envelope = await tx.encryptedValue.findFirstOrThrow({
    where: { id, OR: [{ connection: { connectorId } }, { attempt: { connectorId } }] },
  });
  return { envelope, connectorId };
}

/** Persists only already-prepared ciphertext; safe inside a serializable transaction. */
export async function persistSecretEnvelope({
  tx,
  envelope,
  id,
}: {
  tx: Client;
  envelope: Awaited<ReturnType<typeof prepareSecretEnvelope>>;
  id?: string | null;
}) {
  return id
    ? tx.encryptedValue.update({ where: { id }, data: envelope })
    : tx.encryptedValue.create({ data: envelope });
}
