import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  createEnvelopeError,
  EnvelopeEncryptionError,
  type EnvelopeField,
  type EnvelopeOperation,
} from "./envelope-errors";

export interface EnvelopeContext {
  formatVersion: number;
  provider: string;
  context: string;
}
/** Opaque provider output; only the selected provider interprets its contents. */
export type WrappedDek = { [key: string]: string };
export interface EnvelopeKeyProvider {
  wrapDek(input: { dek: Buffer; context: EnvelopeContext }): Promise<WrappedDek>;
  unwrapDek(input: { wrappedDek: unknown; context: EnvelopeContext }): Promise<Buffer>;
}

/** Domain-separates wrapping from data encryption and binds both to the stable entity/purpose. */
export const buildEnvelopeAad = ({
  layer,
  context,
}: {
  layer: "data" | "wrap";
  context: EnvelopeContext;
}) =>
  Buffer.from(
    JSON.stringify([
      "weldall-envelope",
      layer,
      context.formatVersion,
      context.provider,
      context.context,
    ]),
  );

/** Loads the deployment KEK, distinguishing absent configuration from invalid key encoding. */
function readLocalKek(operation: EnvelopeOperation): Buffer {
  const value = process.env.WELDALL_CONNECTOR_KEK;
  if (!value) throw createEnvelopeError({ code: "encryption_key_missing", operation });
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    key.fill(0);
    throw createEnvelopeError({ code: "encryption_key_invalid", operation });
  }
  return key;
}

/** Rejects noncanonical encodings and incorrect field lengths without logging the input bytes. */
export function decodeEnvelopeBytes({
  value,
  length,
  operation,
  field,
}: {
  value: unknown;
  length?: number;
  operation: EnvelopeOperation;
  field: EnvelopeField;
}): Buffer {
  if (typeof value !== "string")
    throw createEnvelopeError({ code: "envelope_invalid", operation, field });
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (length !== undefined && bytes.length !== length))
    throw createEnvelopeError({ code: "envelope_invalid", operation, field });
  return bytes;
}
const localWrappedDek = z
  .object({ ciphertext: z.string(), nonce: z.string(), tag: z.string() })
  .strict();
const localEnvironmentProvider: EnvelopeKeyProvider = {
  /** Wraps one DEK using the deployment KEK and authenticated entity/purpose metadata. */
  async wrapDek({ dek, context }) {
    if (dek.length !== 32)
      throw createEnvelopeError({ code: "encryption_dek_invalid", operation: "wrap" });
    const kek = readLocalKek("wrap");
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", kek, nonce);
      cipher.setAAD(buildEnvelopeAad({ layer: "wrap", context }));
      return {
        ciphertext: Buffer.concat([cipher.update(dek), cipher.final()]).toString("base64"),
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      };
    } catch {
      throw createEnvelopeError({ code: "envelope_encryption_failed", operation: "wrap" });
    } finally {
      kek.fill(0);
    }
  },
  /** Validates and unwraps a DEK; authentication failure cannot distinguish tampering from a changed KEK. */
  async unwrapDek({ wrappedDek, context }) {
    const parsed = localWrappedDek.safeParse(wrappedDek);
    if (!parsed.success)
      throw createEnvelopeError({
        code: "envelope_invalid",
        operation: "unwrap",
        field: "wrappedDek",
      });
    const wrapped = parsed.data;
    const kek = readLocalKek("unwrap");
    try {
      const nonce = decodeEnvelopeBytes({
        value: wrapped.nonce,
        length: 12,
        operation: "unwrap",
        field: "nonce",
      });
      const tag = decodeEnvelopeBytes({
        value: wrapped.tag,
        length: 16,
        operation: "unwrap",
        field: "tag",
      });
      const ciphertext = decodeEnvelopeBytes({
        value: wrapped.ciphertext,
        length: 32,
        operation: "unwrap",
        field: "ciphertext",
      });
      const cipher = createDecipheriv("aes-256-gcm", kek, nonce);
      cipher.setAAD(buildEnvelopeAad({ layer: "wrap", context }));
      cipher.setAuthTag(tag);
      const plaintext = cipher.update(ciphertext);
      try {
        let final: Buffer;
        try {
          final = cipher.final();
        } catch {
          throw createEnvelopeError({
            code: "envelope_authentication_failed",
            operation: "unwrap",
          });
        }
        return Buffer.concat([plaintext, final]);
      } finally {
        plaintext.fill(0);
      }
    } catch (error) {
      if (error instanceof EnvelopeEncryptionError) throw error;
      throw createEnvelopeError({ code: "envelope_decryption_failed", operation: "unwrap" });
    } finally {
      kek.fill(0);
    }
  },
};

/** Selects an implemented key provider without accepting provider configuration or key material. */
export function getEnvelopeProvider(provider: string): EnvelopeKeyProvider {
  if (provider !== "LOCAL_ENV")
    throw createEnvelopeError({
      code: "envelope_provider_unsupported",
      operation: "select_provider",
    });
  return localEnvironmentProvider;
}
