import { createHash } from "node:crypto";
import { z } from "zod";
import { logger } from "../observability/logger";

const APPROVAL_MODES = ["chat", "approve", "smart_approve", "auto"] as const;
type ApprovalMode = (typeof APPROVAL_MODES)[number];

const policyFields = {
  version: z.literal(1),
  approvalMode: z.enum(APPROVAL_MODES).optional(),
  extensions: z
    .record(z.string().min(1).max(100), z.boolean())
    .refine((value) => Object.keys(value).length <= 100, "At most 100 extensions.")
    .optional(),
  shell: z.boolean().optional(),
  models: z
    .object({
      provider: z.string().min(1).max(100),
      allowed: z
        .array(
          z
            .object({
              name: z.string().min(1).max(200),
              context_limit: z.number().int().positive(),
              supports_vision: z.boolean(),
            })
            .strict(),
        )
        .min(1)
        .max(200),
    })
    .strict()
    .optional(),
};

export const clientPolicySchema = z
  .object({ ...policyFields, instructions: z.string().max(100_000).optional() })
  .strict();

export const defaultClientPolicySchema = z.object(policyFields).strict();

export type ClientPolicy = z.infer<typeof clientPolicySchema>;
export type ClientPolicyWithoutInstructions = Omit<ClientPolicy, "instructions">;

const permissiveness = (mode: ApprovalMode) => APPROVAL_MODES.indexOf(mode);

/**
 * Merges the default policy with the caller's group policies (already in stable order). A field
 * set by any group replaces the default's value; where groups disagree the most permissive wins.
 * The default's instructions are not merged: the organization appendix is added by the route.
 */
export function mergeClientPolicies(
  defaultPolicy: ClientPolicy | null,
  groupPolicies: ClientPolicy[],
): ClientPolicy {
  const set = <K extends keyof ClientPolicy>(key: K) =>
    groupPolicies
      .map((policy) => policy[key])
      .filter((value): value is NonNullable<ClientPolicy[K]> => value !== undefined);
  const merged: ClientPolicy = { version: 1 };
  const modes = set("approvalMode");
  const approvalMode = modes.length
    ? modes.reduce((left, right) => (permissiveness(right) > permissiveness(left) ? right : left))
    : defaultPolicy?.approvalMode;
  if (approvalMode) merged.approvalMode = approvalMode;

  const extensionSets = set("extensions");
  if (extensionSets.length) {
    const extensions: Record<string, boolean> = {};
    for (const entries of extensionSets)
      for (const [name, enabled] of Object.entries(entries))
        extensions[name] = (extensions[name] ?? false) || enabled;
    merged.extensions = extensions;
  } else if (defaultPolicy?.extensions) merged.extensions = defaultPolicy.extensions;

  const shells = set("shell");
  const shell = shells.length ? shells.some(Boolean) : defaultPolicy?.shell;
  if (shell !== undefined) merged.shell = shell;

  const modelSets = set("models");
  if (modelSets.length) {
    const provider = modelSets[0]!.provider;
    const allowed: NonNullable<ClientPolicy["models"]>["allowed"] = [];
    for (const models of modelSets) {
      if (models.provider !== provider) {
        logger.warn({
          event: "client_policy.models.provider_conflict",
          provider,
          ignoredProvider: models.provider,
        });
        continue;
      }
      for (const model of models.allowed)
        if (!allowed.some((entry) => entry.name === model.name)) allowed.push(model);
    }
    merged.models = { provider, allowed };
  } else if (defaultPolicy?.models) merged.models = defaultPolicy.models;

  const instructions = set("instructions").filter(Boolean);
  if (instructions.length) merged.instructions = instructions.join("\n\n");
  return merged;
}

export function withoutInstructions(policy: ClientPolicy): ClientPolicyWithoutInstructions {
  const { instructions: _instructions, ...rest } = policy;
  return rest;
}

/** Sorted-key JSON; `null` and `undefined` both serialise as `null`. */
export function canonicalPolicyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalPolicyJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, item]) => `${JSON.stringify(name)}:${canonicalPolicyJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function policyEtag(policy: ClientPolicyWithoutInstructions): string {
  return createHash("sha256").update(canonicalPolicyJson(policy)).digest("base64url");
}
