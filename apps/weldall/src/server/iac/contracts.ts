import { createHash } from "node:crypto";
import { z } from "zod";

export const IAC_MANIFEST_VERSION = "weldall.dev/v1alpha1" as const;
export const IAC_API_VERSION = "v1" as const;
export const IAC_SCOPE = "weldall:iac" as const;
export const IAC_LIMITS = {
  payloadBytes: 1_000_000,
  objects: 1_000,
  includes: 100,
  relationItems: 100,
  addresses: 200,
} as const;

const key = z.string().trim().min(1).max(160);
const addressKey = z.string().regex(/^[a-z][a-z0-9_-]{0,119}$/);
const stringSet = z.array(key).max(IAC_LIMITS.relationItems).transform(canonicalSet);
const publicJwk = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().min(1).max(200),
    y: z.string().min(1).max(200),
    alg: z.literal("ES256").optional(),
    use: z.literal("sig").optional(),
  })
  .strict();

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
        z.object({ key, description: z.string().trim().min(1).max(500) }).strict(),
      )
      .default({}),
    resources: z
      .record(
        addressKey,
        z
          .object({
            key: z.string().regex(/^[a-z0-9._-]{1,120}$/),
            name: z.string().trim().min(1).max(200),
            resourceIdentifier: z.string().url(),
            authorizationServer: z.string().url(),
            downstreamClientId: z.string().trim().min(1).max(200),
            enabled: z.boolean(),
            skillDiscoveryEnabled: z.boolean().default(false),
            requestPrefixes: stringSet,
            scopes: stringSet,
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
          .object({ email: z.string().trim().toLowerCase().email().max(320), scopes: stringSet })
          .strict(),
      )
      .default({}),
    groupAssignments: z
      .record(addressKey, z.object({ provider: key, groupId: key, scopes: stringSet }).strict())
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
      if (["weldall:login", "weldall:administer", IAC_SCOPE].includes(scope.key))
        context.addIssue({
          code: "custom",
          message: `System scope ${scope.key} cannot be declared`,
        });
    }
    for (const assignment of [
      ...Object.values(manifest.emailAssignments),
      ...Object.values(manifest.groupAssignments),
    ]) {
      if (assignment.scopes.includes(IAC_SCOPE))
        context.addIssue({ code: "custom", message: `${IAC_SCOPE} is machine-only` });
    }
  });

export type DesiredState = z.output<typeof desiredStateSchema>;
export type IacKind = "scope" | "resource" | "machine" | "emailAssignment" | "groupAssignment";
export type IacActionType =
  "create" | "update" | "replace" | "delete" | "recreate" | "register_key" | "revoke_key" | "noop";
export interface IacAction {
  address: string;
  kind: IacKind;
  action: IacActionType;
  identity: string;
  drift?: boolean;
  irreversible?: boolean;
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

export function publicKeySummary(
  kid: string,
  jwk: { kty: string; crv: string; x: string; y: string },
) {
  const thumbprint = createHash("sha256")
    .update(canonicalJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest("base64url");
  return { kid, thumbprint };
}
