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
  connectorId?: string;
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
      ...(context.provider === "OPENBAO" ? [openBaoKeyName(context.connectorId)] : []),
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

const transitCiphertext = z
  .string()
  .max(512)
  .regex(/^vault:v[1-9][0-9]*:[A-Za-z0-9+/]+={0,2}$/)
  .refine((value) => {
    const encoded = value.split(":")[2] ?? "";
    const bytes = Buffer.from(encoded, "base64");
    return bytes.length === 60 && bytes.toString("base64") === encoded;
  });
const openBaoWrappedDek = z.object({ ciphertext: transitCiphertext }).strict();

/** Identity comes from the authorized connector, never from stored wrapping output. */
function openBaoKeyName(connectorId: string | undefined): string {
  if (!connectorId || !z.uuid().safeParse(connectorId).success)
    throw createEnvelopeError({ code: "envelope_context_mismatch", operation: "select_provider" });
  return `weldall-connector-${connectorId}`;
}

function openBaoConfiguration(operation: EnvelopeOperation) {
  const host = process.env.WELDALL_OPENBAO_HOST;
  const token = process.env.WELDALL_OPENBAO_TOKEN;
  if (!host || !token)
    throw createEnvelopeError({ code: "openbao_configuration_missing", operation });
  try {
    const url = new URL(host);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      !/^https?:\/\/[^/?#]+\/?$/.test(host) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          loopback &&
          ["development", "test"].includes(process.env.NODE_ENV ?? "")
        )) ||
      !/^[\x21-\x7e]+$/.test(token)
    )
      throw new Error();
    return { origin: url.origin, token };
  } catch {
    throw createEnvelopeError({ code: "openbao_configuration_invalid", operation });
  }
}

/** One bounded request, including response consumption. Never retries or follows redirects. */
async function transitRequest({
  operation,
  context,
  body,
}: {
  operation: "wrap" | "unwrap";
  context: EnvelopeContext;
  body: Record<string, string>;
}): Promise<unknown> {
  const { origin, token } = openBaoConfiguration(operation);
  const key = encodeURIComponent(openBaoKeyName(context.connectorId));
  const signal = AbortSignal.timeout(5_000);
  try {
    const response = await fetch(
      `${origin}/v1/transit/${operation === "wrap" ? "encrypt" : "decrypt"}/${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Vault-Token": token },
        body: JSON.stringify(body),
        redirect: "error",
        signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw createEnvelopeError({
        code: response.status >= 500 ? "openbao_unavailable" : "openbao_rejected",
        operation,
      });
    }
    // Transit responses contain only a wrapped 32-byte key; bound even a hostile response.
    const reader = response.body?.getReader();
    if (!reader) throw createEnvelopeError({ code: "openbao_response_invalid", operation });
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 16_384)
          throw createEnvelopeError({ code: "openbao_response_invalid", operation });
        chunks.push(chunk.value);
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw createEnvelopeError({ code: "openbao_response_invalid", operation });
      }
    } finally {
      await reader.cancel();
    }
  } catch (error) {
    if (error instanceof EnvelopeEncryptionError) throw error;
    throw createEnvelopeError({
      code: signal.aborted ? "openbao_timeout" : "openbao_unavailable",
      operation,
    });
  }
}

const openBaoClient = {
  async encryptDek(dek: Buffer, context: EnvelopeContext): Promise<WrappedDek> {
    if (dek.length !== 32)
      throw createEnvelopeError({ code: "encryption_dek_invalid", operation: "wrap" });
    const response = await transitRequest({
      operation: "wrap",
      context,
      body: {
        plaintext: dek.toString("base64"),
        associated_data: buildEnvelopeAad({ layer: "wrap", context }).toString("base64"),
        type: "aes256-gcm96",
      },
    });
    const parsed = z
      .object({ data: z.object({ ciphertext: transitCiphertext }) })
      .safeParse(response);
    if (!parsed.success)
      throw createEnvelopeError({ code: "openbao_response_invalid", operation: "wrap" });
    return { ciphertext: parsed.data.data.ciphertext };
  },
  async decryptDek(wrappedDek: unknown, context: EnvelopeContext): Promise<Buffer> {
    const wrapped = openBaoWrappedDek.safeParse(wrappedDek);
    if (!wrapped.success)
      throw createEnvelopeError({
        code: "envelope_invalid",
        operation: "unwrap",
        field: "wrappedDek",
      });
    const response = await transitRequest({
      operation: "unwrap",
      context,
      body: {
        ciphertext: wrapped.data.ciphertext,
        associated_data: buildEnvelopeAad({ layer: "wrap", context }).toString("base64"),
      },
    });
    const parsed = z.object({ data: z.object({ plaintext: z.string() }) }).safeParse(response);
    if (!parsed.success)
      throw createEnvelopeError({ code: "openbao_response_invalid", operation: "unwrap" });
    const dek = Buffer.from(parsed.data.data.plaintext, "base64");
    if (dek.length !== 32 || dek.toString("base64") !== parsed.data.data.plaintext) {
      dek.fill(0);
      throw createEnvelopeError({ code: "openbao_response_invalid", operation: "unwrap" });
    }
    return dek;
  },
};
const openBaoProvider: EnvelopeKeyProvider = {
  wrapDek: ({ dek, context }) => openBaoClient.encryptDek(dek, context),
  unwrapDek: ({ wrappedDek, context }) => openBaoClient.decryptDek(wrappedDek, context),
};

/** Selects an implemented key provider without accepting provider configuration or key material. */
export function getEnvelopeProvider(provider: string): EnvelopeKeyProvider {
  if (provider === "OPENBAO") return openBaoProvider;
  if (provider !== "LOCAL_ENV")
    throw createEnvelopeError({
      code: "envelope_provider_unsupported",
      operation: "select_provider",
    });
  return localEnvironmentProvider;
}
