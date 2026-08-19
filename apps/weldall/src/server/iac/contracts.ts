import { createHash, createPublicKey } from "node:crypto";
import { IAC_SCOPE_KEY, isMachineOnlySystemScope, SYSTEM_SCOPE_DEFINITIONS } from "@weldall/db";
import {
  normalizeAuthorizationServer,
  normalizeRequestPrefix,
  normalizeResourceIdentifier,
} from "@weldall/sdk";
import { z } from "zod";

export const IAC_MANIFEST_VERSION = "weldall.dev/v1" as const;
export const IAC_API_VERSION = "v1" as const;
export const IAC_SCOPE = IAC_SCOPE_KEY;
export const IAC_LIMITS = {
  payloadBytes: 1_000_000,
  objects: 1_000,
  includes: 100,
  relationItems: 100,
  addresses: 200,
} as const;

const key = z.string().trim().min(1).max(160);
const groupId = z.string().trim().min(1).max(191);
const scopeKey = z
  .string()
  .regex(/^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/)
  .max(160);
const addressKey = z.string().regex(/^[a-z][a-z0-9_-]{0,119}$/);
const stringSet = z.array(key).max(IAC_LIMITS.relationItems).transform(canonicalSet);
const nonEmptyStringSet = z.array(key).min(1).max(IAC_LIMITS.relationItems).transform(canonicalSet);
const canonicalUrl = (normalizer: (value: string) => string) =>
  z
    .string()
    .url()
    .refine((value) => {
      try {
        return normalizer(value) === value;
      } catch {
        return false;
      }
    }, "URL must be canonical HTTPS without credentials or forbidden components");
const publicJwk = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    alg: z.literal("ES256").optional(),
    use: z.literal("sig").optional(),
  })
  .strict()
  .refine((value) => {
    try {
      createPublicKey({ key: value, format: "jwk" });
      return true;
    } catch {
      return false;
    }
  }, "JWK must be a valid public P-256 key");

export const desiredStateSchema = z
  .object({
    apiVersion: z.literal(IAC_MANIFEST_VERSION),
    workspace: z
      .object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(200),
        issuer: z
          .string()
          .url()
          .refine((value) => new URL(value).protocol === "https:"),
      })
      .strict(),
    scopes: z
      .record(
        addressKey,
        z.object({ key: scopeKey, description: z.string().trim().min(1).max(500) }).strict(),
      )
      .default({}),
    resources: z
      .record(
        addressKey,
        z
          .object({
            key: z.string().regex(/^[a-z0-9._-]{1,120}$/),
            name: z.string().trim().min(1).max(200),
            resourceIdentifier: canonicalUrl(normalizeResourceIdentifier),
            authorizationServer: canonicalUrl(normalizeAuthorizationServer),
            downstreamClientId: z.string().trim().min(1).max(200),
            enabled: z.boolean(),
            skillDiscoveryEnabled: z.boolean().default(false),
            requestPrefixes: z
              .array(canonicalUrl(normalizeRequestPrefix))
              .min(1)
              .max(IAC_LIMITS.relationItems)
              .transform(canonicalSet),
            scopes: stringSet,
          })
          .strict(),
      )
      .default({}),
    skills: z
      .record(
        addressKey,
        z
          .object({
            slug: z
              .string()
              .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
              .max(120),
            title: z.string().trim().min(1).max(200),
            content: z.string().trim().min(1).max(100_000),
            requiredScopes: z.array(scopeKey).max(IAC_LIMITS.relationItems).transform(canonicalSet),
            visibility: z.enum(["DEFAULT", "HIDDEN_IF_UNALLOWED"]),
          })
          .strict(),
      )
      .default({}),
    machines: z
      .record(
        addressKey,
        z
          .object({
            clientId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
            name: z.string().trim().min(1).max(200),
            enabled: z.boolean(),
            publicKeys: z.record(addressKey, publicJwk).default({}),
            resources: stringSet,
            scopes: stringSet,
          })
          .strict(),
      )
      .default({}),
    emailAssignments: z
      .record(
        addressKey,
        z
          .object({
            email: z.string().trim().toLowerCase().email().max(320),
            scopes: nonEmptyStringSet,
          })
          .strict(),
      )
      .default({}),
    groupAssignments: z
      .record(addressKey, z.object({ provider: key, groupId, scopes: nonEmptyStringSet }).strict())
      .default({}),
  })
  .strict()
  .superRefine((manifest, context) => {
    const identities = new Set<string>();
    const entries: Array<[string, string]> = [
      ...Object.values(manifest.scopes).map((item) => ["scope", item.key] as [string, string]),
      ...Object.values(manifest.resources).map(
        (item) => ["resource", item.key] as [string, string],
      ),
      ...Object.values(manifest.machines).map(
        (item) => ["machine", item.clientId] as [string, string],
      ),
      ...Object.values(manifest.skills).map((item) => ["skill", item.slug] as [string, string]),
      ...Object.values(manifest.emailAssignments).map(
        (item) => ["email", item.email] as [string, string],
      ),
      ...Object.values(manifest.groupAssignments).map(
        (item) => ["group", `${item.provider}:${item.groupId}`] as [string, string],
      ),
    ];
    if (entries.length > IAC_LIMITS.objects)
      context.addIssue({ code: "custom", message: "Manifest object limit exceeded" });
    for (const [kind, identity] of entries) {
      const composite = `${kind}:${identity}`;
      if (identities.has(composite))
        context.addIssue({ code: "custom", message: `Duplicate natural identity ${identity}` });
      identities.add(composite);
    }
    for (const scope of Object.values(manifest.scopes)) {
      if (SYSTEM_SCOPE_DEFINITIONS.some(({ key }) => key === scope.key))
        context.addIssue({
          code: "custom",
          message: `System scope ${scope.key} cannot be declared`,
        });
    }
    for (const assignment of [
      ...Object.values(manifest.emailAssignments),
      ...Object.values(manifest.groupAssignments),
    ]) {
      const machineOnlyScope = assignment.scopes.find(isMachineOnlySystemScope);
      if (machineOnlyScope)
        context.addIssue({ code: "custom", message: `${machineOnlyScope} is machine-only` });
    }
  });

export type DesiredState = z.output<typeof desiredStateSchema>;
export type IacKind =
  "scope" | "resource" | "machine" | "emailAssignment" | "groupAssignment" | "skill";
export type IacActionType =
  "create" | "update" | "replace" | "delete" | "recreate" | "register_key" | "revoke_key" | "noop";
export interface IacAction {
  address: string;
  kind: IacKind;
  action: IacActionType;
  identity: string;
  observedVersion?: number;
  drift?: boolean;
  irreversible?: boolean;
  keyId?: string;
  keyThumbprint?: string;
}
export interface IacBlocker {
  code: string;
  address?: string;
  message: string;
  ownerWorkspaceId?: string;
}
export interface IacPlan {
  version: 1;
  workspaceId: string;
  revision: number;
  configDigest: string;
  actions: IacAction[];
  blockers: IacBlocker[];
  digest: string;
}

export function canonicalSet(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseDesiredState(value: unknown): DesiredState {
  return desiredStateSchema.parse(value);
}

const operationId = z.string().uuid();
const logicalAddress = z
  .string()
  .regex(
    /^(scope|resource|machine|emailAssignment|groupAssignment|skill)\.[a-z][a-z0-9_-]{0,119}$/,
  );
export const planRequestSchema = z.object({ manifest: desiredStateSchema }).strict();
export const applyRequestSchema = z
  .object({
    manifest: desiredStateSchema,
    plannedRevision: z.number().int().min(0),
    configDigest: z.string().regex(/^[a-f0-9]{64}$/),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/),
    operationId,
  })
  .strict();
export const importRequestSchema = z
  .object({
    workspace: desiredStateSchema.shape.workspace,
    kind: z.enum(["scope", "resource", "machine", "emailAssignment", "groupAssignment", "skill"]),
    identity: key,
    address: logicalAddress,
    operationId,
  })
  .strict()
  .refine(({ kind, address }) => address.startsWith(`${kind}.`), {
    message: "Import address must have the exact primitive kind prefix",
    path: ["address"],
  });
export const unmanageRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    address: logicalAddress,
    manifest: desiredStateSchema,
    configDigest: z.string().regex(/^[a-f0-9]{64}$/),
    operationId,
  })
  .strict();
export const moveRequestSchema = z
  .object({ workspaceId: z.string().uuid(), from: logicalAddress, to: logicalAddress, operationId })
  .strict()
  .refine(({ from, to }) => from !== to, { message: "Source and destination must differ" })
  .refine(({ from, to }) => from.split(".", 1)[0] === to.split(".", 1)[0], {
    message: "Source and destination must have the same primitive kind",
  });
export const workspaceIdSchema = z.string().uuid();

export function publicKeySummary(
  kid: string,
  jwk: { kty: string; crv: string; x: string; y: string },
) {
  const thumbprint = createHash("sha256")
    .update(canonicalJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest("base64url");
  return { kid, thumbprint };
}
