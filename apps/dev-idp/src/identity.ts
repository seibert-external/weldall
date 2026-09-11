import { createHash } from "node:crypto";
import { z } from "zod";
import type { DevIdpUser } from "./env.js";

const emailSchema = z.string().trim().toLowerCase().email().max(320);

/** Builds a readable, address-derived subject so repeated logins resolve to the same account. */
const subjectFor = (email: string) => {
  const localPart = email.slice(0, email.lastIndexOf("@"));
  const slug = localPart
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const digest = createHash("sha256").update(email).digest("hex").slice(0, 12);
  return `dev-${slug ? `${slug}-` : ""}${digest}`;
};

/** Turns `bob.roe+test@example.com` into `Bob Roe Test`. */
const displayNameFor = (email: string) => {
  const localPart = email.slice(0, email.lastIndexOf("@"));
  const words = localPart
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .slice(0, 8);
  const name = words.map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`).join(" ");
  return (name || email).slice(0, 200);
};

/**
 * Resolves the identity behind a submitted email address. Configured users keep their subject,
 * name and verification flag; every other valid address becomes a verified development identity
 * whose subject is derived from the address.
 */
export function resolveIdentity(submitted: string, users: DevIdpUser[]): DevIdpUser | undefined {
  const email = emailSchema.safeParse(submitted);
  if (!email.success) return undefined;
  const configured = users.find((user) => user.email.toLowerCase() === email.data);
  return (
    configured ?? {
      sub: subjectFor(email.data),
      email: email.data,
      name: displayNameFor(email.data),
      emailVerified: true,
    }
  );
}
