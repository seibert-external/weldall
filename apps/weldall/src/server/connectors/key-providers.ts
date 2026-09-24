import { createHash } from "node:crypto";
import type { EncryptionKeyVersion, Prisma } from "@weldall/db";
import { z } from "zod";
import { ConnectorError, type KeySource } from "./contracts";

type StoredBinding = Pick<
  EncryptionKeyVersion,
  "providerType" | "providerConfig" | "providerState"
>;
type NewBinding = {
  providerType: string;
  providerConfig: Prisma.InputJsonValue;
  providerState: Prisma.InputJsonValue;
};

/** Internal adapter contract separating persisted provider bindings from runtime key custody. */
interface KeyProvider {
  readonly type: KeySource["type"];
  /** Binds public source configuration to immutable opaque state for a logical key version. */
  bindSource(source: KeySource): Promise<NewBinding>;
  /** Projects a stored binding back to its non-secret admin and IaC representation. */
  describeSource(binding: StoredBinding): KeySource;
  /** Resolves runtime data-key material without exposing it through configuration APIs. */
  resolveMaterial(binding: StoredBinding): Promise<Buffer>;
}

const localEnvironmentConfig = z
  .object({ variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,199}$/) })
  .strict();
const localEnvironmentState = z
  .object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
/** Builds the stable provider-boundary error returned for missing or changed key material. */
const createKeyUnavailableError = () =>
  new ConnectorError(
    "key_unavailable",
    "Encryption key is unavailable or changed. Restore its original material.",
    503,
  );

/** Resolves approved deployment key material for the built-in local environment provider. */
function readLocalEnvironmentMaterial(variable: string): Buffer {
  const approved = (process.env.WELDALL_ENCRYPTION_SOURCES ?? "")
    .split(",")
    .map((value) => value.trim());
  if (!approved.includes(variable)) throw createKeyUnavailableError();
  const value = process.env[variable] ?? "";
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw createKeyUnavailableError();
  return key;
}

const localEnvironmentProvider: KeyProvider = {
  type: "local-env",
  async bindSource(source) {
    if (source.type !== this.type) throw createKeyUnavailableError();
    const material = readLocalEnvironmentMaterial(source.variable);
    return {
      providerType: this.type,
      providerConfig: { variable: source.variable },
      providerState: { fingerprint: createHash("sha256").update(material).digest("hex") },
    };
  },
  describeSource(binding) {
    try {
      if (binding.providerType !== this.type) throw createKeyUnavailableError();
      const config = localEnvironmentConfig.parse(binding.providerConfig);
      return { type: this.type, variable: config.variable };
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw createKeyUnavailableError();
    }
  },
  async resolveMaterial(binding) {
    try {
      const source = this.describeSource(binding);
      const state = localEnvironmentState.parse(binding.providerState);
      const material = readLocalEnvironmentMaterial(source.variable);
      if (createHash("sha256").update(material).digest("hex") !== state.fingerprint)
        throw createKeyUnavailableError();
      return material;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw createKeyUnavailableError();
    }
  },
};

const providers = new Map<KeySource["type"], KeyProvider>([
  [localEnvironmentProvider.type, localEnvironmentProvider],
]);

/** Selects the server-side implementation for a persisted encryption-key provider type. */
function getKeyProvider(type: string) {
  const value = providers.get(type as KeySource["type"]);
  if (!value) throw createKeyUnavailableError();
  return value;
}

/** Creates immutable provider configuration and opaque state for a new logical key version. */
export function bindKeySource(source: KeySource) {
  return getKeyProvider(source.type).bindSource(source);
}

/** Returns the public source reference used by UI and IaC without exposing opaque provider state. */
export function describeKeySource(binding: StoredBinding) {
  return getKeyProvider(binding.providerType).describeSource(binding);
}

/** Resolves the 32-byte data key used by connector encryption; KMS providers may cache unwraps here. */
export async function resolveKeyMaterial(binding: StoredBinding) {
  const material = await getKeyProvider(binding.providerType).resolveMaterial(binding);
  if (material.length !== 32) throw createKeyUnavailableError();
  return material;
}

/** Reports whether an immutable key binding is usable by the current Weldall server instance. */
export async function checkKeyBindingAvailability(binding: StoredBinding) {
  try {
    await resolveKeyMaterial(binding);
    return true;
  } catch {
    return false;
  }
}
