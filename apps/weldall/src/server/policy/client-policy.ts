import { createHash } from "node:crypto";
import {
  CLIENT_POLICY_APPROVAL_MODES,
  type ClientPolicy,
  type ClientPolicyApprovalMode,
  type ClientPolicyWithoutInstructions,
  type DefaultClientPolicy,
} from "@weldall/sdk";
import { logger } from "../observability/logger";

export {
  clientPolicySchema,
  defaultClientPolicySchema,
  type ClientPolicy,
  type ClientPolicyWithoutInstructions,
  type DefaultClientPolicy,
} from "@weldall/sdk";

/** A merged policy: group fields, group instructions and the default's `modelKey`. */
export type MergedClientPolicy = ClientPolicy & Pick<DefaultClientPolicy, "modelKey">;

const permissiveness = (mode: ClientPolicyApprovalMode) =>
  CLIENT_POLICY_APPROVAL_MODES.indexOf(mode);

/**
 * Merges the default policy with the caller's group policies (already in stable order). A field
 * set by any group replaces the default's value; where groups disagree the most permissive wins.
 * Home skills are combined instead: every group's pins, then the default's.
 * The default's instructions are not merged: the organization appendix is added by the route.
 */
export function mergeClientPolicies(
  defaultPolicy: DefaultClientPolicy | null,
  groupPolicies: ClientPolicy[],
): MergedClientPolicy {
  const set = <K extends keyof ClientPolicy>(key: K) =>
    groupPolicies
      .map((policy) => policy[key])
      .filter((value): value is NonNullable<ClientPolicy[K]> => value !== undefined);
  const merged: MergedClientPolicy = { version: 1 };
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

  const sandboxes = set("sandbox");
  const sandbox = sandboxes.length ? sandboxes.every(Boolean) : defaultPolicy?.sandbox;
  if (sandbox !== undefined) merged.sandbox = sandbox;

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

  // Groups' pins come first because they are more specific than the default's.
  const homeSkills = [
    ...set("homeSkills"),
    ...(defaultPolicy?.homeSkills ? [defaultPolicy.homeSkills] : []),
  ];
  if (homeSkills.length) merged.homeSkills = [...new Set(homeSkills.flat())].slice(0, 50);

  // Organization-wide: a group cannot set it.
  if (defaultPolicy?.modelKey) merged.modelKey = defaultPolicy.modelKey;

  const instructions = set("instructions").filter(Boolean);
  if (instructions.length) merged.instructions = instructions.join("\n\n");
  return merged;
}

export function withoutInstructions(policy: MergedClientPolicy): ClientPolicyWithoutInstructions {
  const { instructions: _instructions, ...rest } = policy;
  return rest;
}

type ClientPolicyField = Exclude<keyof ClientPolicy, "version">;

/** Every policy field except `version`, sorted. Shared by the audit helper and its schema. */
export const CLIENT_POLICY_FIELDS = [
  "approvalMode",
  "extensions",
  "instructions",
  "models",
  "sandbox",
  "shell",
] as const satisfies readonly ClientPolicyField[];

// Fails to compile when the SDK schema gains a field that is missing above.
const _everyClientPolicyField: Record<
  Exclude<ClientPolicyField, (typeof CLIENT_POLICY_FIELDS)[number]>,
  never
> = {};

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
