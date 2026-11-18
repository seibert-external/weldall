import { z } from "zod";

/** Ordered from least to most permissive. */
export const CLIENT_POLICY_APPROVAL_MODES = ["chat", "approve", "smart_approve", "auto"] as const;
export type ClientPolicyApprovalMode = (typeof CLIENT_POLICY_APPROVAL_MODES)[number];

const policyFields = {
  version: z.literal(1),
  approvalMode: z.enum(CLIENT_POLICY_APPROVAL_MODES).optional(),
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

/** A group's client policy. Only groups carry instructions. */
export const clientPolicySchema = z
  .object({ ...policyFields, instructions: z.string().max(100_000).optional() })
  .strict();

/** The organization's default client policy (the IaC `cli.policy` block). */
export const defaultClientPolicySchema = z.object(policyFields).strict();

export type ClientPolicy = z.infer<typeof clientPolicySchema>;
export type ClientPolicyWithoutInstructions = Omit<ClientPolicy, "instructions">;
