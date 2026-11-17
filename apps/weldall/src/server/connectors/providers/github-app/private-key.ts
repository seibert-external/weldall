import { createPrivateKey, type KeyObject } from "node:crypto";
import { ConnectorError } from "../../errors";

export const PRIVATE_KEY_INPUT_LIMIT = 16 * 1024;
const MINIMUM_MODULUS_BITS = 2048;

/** Fixed messages only: neither key material nor parser details may reach the caller. */
const invalid = (detail: string) =>
  new ConnectorError(
    "invalid_private_key",
    `Upload the GitHub App private key as the PEM file GitHub generated. ${detail}`,
  );

/**
 * Accepts one unencrypted RSA private key in PEM (PKCS#1 as GitHub issues it, or PKCS#8) and
 * returns it as canonical PKCS#8 PEM. Everything else is rejected with an explanation.
 */
export function parseGitHubAppPrivateKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw invalid("The key is empty.");
  if (value.length > PRIVATE_KEY_INPUT_LIMIT) throw invalid("The input is too large for a key.");
  const text = value.trim().replace(/\r\n/g, "\n");
  if (/^-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text) || /Proc-Type:\s*4,ENCRYPTED/.test(text))
    throw invalid("Encrypted keys are not supported.");
  const block = /^-----BEGIN ([A-Z0-9 ]{1,40})-----\n([A-Za-z0-9+/=\n]+)\n-----END \1-----$/.exec(
    text,
  );
  if (!block) throw invalid("The text is not a single PEM block.");
  if (block[1] !== "RSA PRIVATE KEY" && block[1] !== "PRIVATE KEY")
    throw invalid(`It contains a ${block[1]} instead of a private key.`);
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: text, format: "pem" });
  } catch {
    throw invalid("The key could not be read.");
  }
  if (key.asymmetricKeyType !== "rsa") throw invalid("GitHub App keys are RSA keys.");
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MINIMUM_MODULUS_BITS)
    throw invalid(`The RSA key must have at least ${MINIMUM_MODULUS_BITS} bits.`);
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}
