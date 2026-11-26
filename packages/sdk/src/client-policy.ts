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
  sandbox: z.boolean().optional(),
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
  /** Skill slugs the client pins on its home screen, in order. It skips slugs the user lacks. */
  homeSkills: z
    .array(z.string().min(1).max(200))
    .max(50)
    .refine((slugs) => new Set(slugs).size === slugs.length, "Duplicate skill slugs.")
    .optional(),
};

/** A lower-case DNS name or IPv4 address: no scheme, port or path. */
const hostname = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/);

/** Where the client fetches the user's personal model key. Organization-wide only. */
const modelKeySchema = z
  .object({ url: z.string().max(2000), hosts: z.array(hostname).min(1).max(20) })
  .strict()
  .superRefine(({ url, hosts }, context) => {
    const parsed = URL.canParse(url) ? new URL(url) : null;
    if (parsed?.protocol !== "https:")
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "Must be an absolute https URL.",
      });
    else if (!hosts.includes(parsed.hostname))
      context.addIssue({ code: "custom", path: ["url"], message: "Host must be one of hosts." });
  });

/** A group's client policy. Only groups carry instructions. */
export const clientPolicySchema = z
  .object({ ...policyFields, instructions: z.string().max(100_000).optional() })
  .strict();

/** The organization's default client policy (the IaC `cli.policy` block). */
export const defaultClientPolicySchema = z
  .object({ ...policyFields, modelKey: modelKeySchema.optional() })
  .strict();

export type ClientPolicy = z.infer<typeof clientPolicySchema>;
export type DefaultClientPolicy = z.infer<typeof defaultClientPolicySchema>;
/** The merged policy as served: group fields plus the default's organization-wide `modelKey`. */
export type ClientPolicyWithoutInstructions = Omit<ClientPolicy, "instructions"> &
  Pick<DefaultClientPolicy, "modelKey">;
