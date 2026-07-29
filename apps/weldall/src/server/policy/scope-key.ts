import { z } from "zod";

declare const scopeKeyBrand: unique symbol;
export type ScopeKey = string & { readonly [scopeKeyBrand]: true };

export const scopeKeySchema = z
  .string()
  .trim()
  .max(160)
  .regex(/^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/)
  .transform((value): ScopeKey => value as ScopeKey);

export function parseScopeKeysFromDatabase(values: string[]): ScopeKey[] {
  return z.array(scopeKeySchema).parse(values);
}
