import { logger } from "../observability/logger";
import { ConnectorError } from "./errors";

const errorMessages = {
  encryption_key_missing: "Encryption is unavailable: WELDALL_CONNECTOR_KEK is not configured.",
  encryption_key_invalid:
    "Encryption is unavailable: WELDALL_CONNECTOR_KEK must be canonical base64 encoding of 32 bytes.",
  envelope_provider_unsupported:
    "Encryption is unavailable: the envelope provider is not supported.",
  envelope_format_unsupported:
    "Encryption is unavailable: the envelope format version is not supported.",
  envelope_context_mismatch:
    "Encryption is unavailable: the stored envelope does not match the expected entity and purpose.",
  envelope_invalid: "Encryption is unavailable: the stored envelope has malformed fields.",
  encryption_dek_invalid:
    "Encryption is unavailable: the data-encryption key must contain 32 bytes.",
  envelope_authentication_failed:
    "Encryption is unavailable: authentication failed. The key may have changed or the encrypted data or metadata may have been altered.",
  envelope_encryption_failed: "Encryption is unavailable: the encryption operation failed.",
  envelope_decryption_failed: "Encryption is unavailable: the decryption operation failed.",
} as const;

type EnvelopeErrorCode = keyof typeof errorMessages;
export type EnvelopeOperation = "encrypt" | "decrypt" | "wrap" | "unwrap" | "select_provider";
export type EnvelopeField = "wrappedDek" | "ciphertext" | "nonce" | "tag";

/** Marks already classified failures so outer encryption layers preserve them without duplicate logs. */
export class EnvelopeEncryptionError extends ConnectorError {}

/** Reports only fixed diagnostic labels and returns a safe error; never accepts secret values or causes. */
export function createEnvelopeError({
  code,
  operation,
  field,
}: {
  code: EnvelopeErrorCode;
  operation: EnvelopeOperation;
  field?: EnvelopeField;
}): EnvelopeEncryptionError {
  logger.error("connector.encryption.failed", {
    operation,
    reason: code,
    ...(field ? { field } : {}),
  });
  return new EnvelopeEncryptionError(code, errorMessages[code], 503);
}
