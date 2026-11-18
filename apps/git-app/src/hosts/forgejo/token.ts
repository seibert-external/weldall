import { z } from "zod";
import { GitAppError } from "../../errors.js";

/** Forgejo issues 40 hexadecimal characters; other shapes are accepted within these bounds. */
export const FORGEJO_TOKEN_INPUT_LIMIT = 512;
const token = z
  .string()
  .trim()
  .min(20)
  .max(FORGEJO_TOKEN_INPUT_LIMIT)
  .regex(/^[A-Za-z0-9._~+/=-]+$/);

/**
 * Validates the bot user's access token (carried over from the server's Forgejo provider). The
 * message is fixed: the input is never echoed.
 */
export function parseForgejoToken(value: unknown): string {
  const parsed = token.safeParse(value);
  if (!parsed.success)
    throw new GitAppError(
      "invalid_token",
      "Give the bot user's access token exactly as Forgejo showed it when it was created.",
    );
  return parsed.data;
}
