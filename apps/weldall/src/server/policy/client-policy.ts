import { createHash } from "node:crypto";
import {
  CLIENT_POLICY_APPROVAL_MODES,
  type ClientPolicy,
  type ClientPolicyApprovalMode,
  type ClientPolicyWithoutInstructions,
} from "@weldall/sdk";
import { logger } from "../observability/logger";

export {
  clientPolicySchema,
  defaultClientPolicySchema,
  type ClientPolicy,
  type ClientPolicyWithoutInstructions,
} from "@weldall/sdk";

const permissiveness = (mode: ClientPolicyApprovalMode) =>
  CLIENT_POLICY_APPROVAL_MODES.indexOf(mode);

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

  // Per key: a key any group sets replaces the default's value; the default's other keys stay.
  const groupExtensions: Record<string, boolean> = {};
  for (const entries of set("extensions"))
    for (const [name, enabled] of Object.entries(entries))
      groupExtensions[name] = (groupExtensions[name] ?? false) || enabled;
  const extensions = { ...defaultPolicy?.extensions, ...groupExtensions };
  if (Object.keys(extensions).length) merged.extensions = extensions;

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
