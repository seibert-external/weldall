import { z } from "zod";

// Mirrors apps/weldall/src/server/policy/client-policy.ts so `weldall validate` catches typos
// without contacting the server; the server validates again on plan.
const fields = {
  version: z.literal(1),
  approvalMode: z.enum(["auto", "smart_approve", "approve", "chat"]).optional(),
  extensions: z
    .record(z.string().min(1).max(100), z.boolean())
    .refine((value) => Object.keys(value).length <= 100)
    .optional(),
  shell: z.boolean().optional(),
  models: z
    .strictObject({
      provider: z.string().min(1).max(100),
      allowed: z
        .array(
          z.strictObject({
            name: z.string().min(1).max(200),
            context_limit: z.number().int().positive(),
            supports_vision: z.boolean(),
          }),
        )
        .min(1)
        .max(200),
    })
    .optional(),
};

export const defaultClientPolicySchema = z.strictObject(fields);
export const clientPolicySchema = z.strictObject({
  ...fields,
  instructions: z.string().max(100_000).optional(),
});
