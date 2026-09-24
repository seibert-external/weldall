import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { ConnectorError } from "./contracts";

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

export const keyUnavailable = () =>
  new ConnectorError(
    "key_unavailable",
    "Encryption material is unavailable or changed. Restore the original deployment secrets.",
    503,
  );

/** Domain-separates wrapping from data encryption and binds both to the stable entity/purpose. */
export const envelopeAad = (layer: "data" | "wrap", context: EnvelopeContext) =>
  Buffer.from(
    JSON.stringify([
      "weldall-envelope",
      layer,
      context.formatVersion,
      context.provider,
      context.context,
    ]),
  );

function localKek(): Buffer {
  const value = process.env.WELDALL_CONNECTOR_KEK ?? "";
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw keyUnavailable();
  return key;
}

/** Reject noncanonical encodings as well as malformed nonce/tag/key lengths. */
export function decodeEnvelopeBytes(value: string, length?: number): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (length !== undefined && bytes.length !== length))
    throw keyUnavailable();
  return bytes;
}
const localWrappedDek = z
  .object({ ciphertext: z.string(), nonce: z.string(), tag: z.string() })
  .strict();
const localEnvironmentProvider: EnvelopeKeyProvider = {
  async wrapDek({ dek, context }) {
    const kek = localKek();
    try {
      if (dek.length !== 32) throw keyUnavailable();
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", kek, nonce);
      cipher.setAAD(envelopeAad("wrap", context));
      return {
        ciphertext: Buffer.concat([cipher.update(dek), cipher.final()]).toString("base64"),
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      };
    } catch {
      throw keyUnavailable();
    } finally {
      kek.fill(0);
    }
  },
  async unwrapDek({ wrappedDek, context }) {
    const kek = localKek();
    try {
      const wrapped = localWrappedDek.parse(wrappedDek);
      const cipher = createDecipheriv("aes-256-gcm", kek, decodeEnvelopeBytes(wrapped.nonce, 12));
      cipher.setAAD(envelopeAad("wrap", context));
      cipher.setAuthTag(decodeEnvelopeBytes(wrapped.tag, 16));
      return Buffer.concat([
        cipher.update(decodeEnvelopeBytes(wrapped.ciphertext, 32)),
        cipher.final(),
      ]);
    } catch {
      throw keyUnavailable();
    } finally {
      kek.fill(0);
    }
  },
};

/** No provider configuration or key material crosses this boundary. */
export function getEnvelopeProvider(provider: string): EnvelopeKeyProvider {
  if (provider !== "LOCAL_ENV") throw keyUnavailable();
  return localEnvironmentProvider;
}
