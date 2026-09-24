import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Prisma, EncryptedValue, EnvelopeProvider } from "@weldall/db";
import {
  decodeEnvelopeBytes,
  envelopeAad,
  getEnvelopeProvider,
  keyUnavailable,
} from "./envelope-providers";

type Client = Prisma.TransactionClient;

/** Each complete logical-object write gets its own random DEK; only its wrapped form is persisted. */
export async function encrypt({
  provider,
  plaintext,
  context,
}: {
  provider: EnvelopeProvider;
  plaintext: string;
  context: string;
}) {
  const metadata = { formatVersion: 1, provider, context };
  const dek = randomBytes(32);
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dek, nonce);
    cipher.setAAD(envelopeAad("data", metadata));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const wrappedDek = await getEnvelopeProvider(provider).wrapDek({ dek, context: metadata });
    return {
      ...metadata,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      wrappedDek,
    };
  } catch {
    throw keyUnavailable();
  } finally {
    dek.fill(0);
  }
}

/** Decrypt only after authorization, using a caller-derived stable entity/purpose context. */
export async function decrypt({
  envelope,
  context,
}: {
  envelope: Pick<
    EncryptedValue,
    "formatVersion" | "provider" | "context" | "nonce" | "ciphertext" | "tag" | "wrappedDek"
  >;
  context: string;
}): Promise<string> {
  let dek: Buffer | undefined;
  try {
    if (envelope.formatVersion !== 1 || envelope.context !== context) throw keyUnavailable();
    dek = await getEnvelopeProvider(envelope.provider).unwrapDek({
      wrappedDek: envelope.wrappedDek,
      context: envelope,
    });
    if (dek.length !== 32) throw keyUnavailable();
    const cipher = createDecipheriv("aes-256-gcm", dek, decodeEnvelopeBytes(envelope.nonce, 12));
    cipher.setAAD(envelopeAad("data", envelope));
    cipher.setAuthTag(decodeEnvelopeBytes(envelope.tag, 16));
    return Buffer.concat([
      cipher.update(decodeEnvelopeBytes(envelope.ciphertext)),
      cipher.final(),
    ]).toString("utf8");
  } catch {
    throw keyUnavailable();
  } finally {
    dek?.fill(0);
  }
}

/** Reads one encrypted object for an authenticated server-side workflow. */
export async function readSecret({ tx, id, context }: { tx: Client; id: string; context: string }) {
  return decrypt({
    envelope: await tx.encryptedValue.findUniqueOrThrow({ where: { id } }),
    context,
  });
}

/** Replaces the complete credential object with fresh data and wrapping nonces and a fresh DEK. */
export async function saveSecret({
  tx,
  provider,
  context,
  value,
  id,
}: {
  tx: Client;
  provider: EnvelopeProvider;
  context: string;
  value: string;
  id?: string | null;
}) {
  const data = await encrypt({ provider, plaintext: value, context });
  return id
    ? tx.encryptedValue.update({ where: { id }, data })
    : tx.encryptedValue.create({ data });
}
