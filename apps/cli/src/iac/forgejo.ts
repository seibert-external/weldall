import { isIP } from "node:net";
import { z } from "zod";
import { CliError } from "../errors.js";

const login = z
  .string()
  .max(40)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|[-._](?=[A-Za-z0-9]))*$/);
const repositoryName = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/)
  .refine((value) => value !== "." && value !== "..");
const statusContext = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\u0000-\u001f\u007f]+$/);

/**
 * https origin of the Forgejo instance (optionally with its sub-path), named by a DNS name; the
 * same rules as the server, which decides in the end.
 */
const baseUrl = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash &&
        !value.includes("?") &&
        !value.includes("#") &&
        value === (url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`) &&
        (url.pathname === "/" || !url.pathname.endsWith("/")) &&
        !/%|\/\.{1,2}(?:\/|$)/.test(url.pathname) &&
        !isIP(host) &&
        !host.startsWith("[") &&
        host.includes(".") &&
        !host.endsWith(".") &&
        host !== "metadata.google.internal" &&
        !host.endsWith(".localhost") &&
        !host.endsWith(".local")
      );
    } catch {
      return false;
    }
  });

/**
 * Public Forgejo connector policy; mirrors the server schema. The server decides which setup
 * modes are available, so a newer server needs no CLI update to enable one.
 */
export const forgejoConfigSchema = z.strictObject({
  baseUrl,
  organization: login,
  botUser: login,
  templates: z
    .array(
      z.strictObject({
        name: z
          .string()
          .max(100)
          .regex(/^[a-z0-9][a-z0-9._-]*$/),
        repository: z
          .string()
          .max(141)
          .refine((value) => {
            const [owner, name, ...rest] = value.split("/");
            return (
              !rest.length &&
              login.safeParse(owner).success &&
              repositoryName.safeParse(name ?? "").success
            );
          }),
      }),
    )
    .min(1)
    .max(50)
    .refine((values) => new Set(values.map(({ name }) => name)).size === values.length),
  repositoryNamePrefix: z
    .string()
    .max(40)
    .regex(/^[A-Za-z0-9._-]*$/),
  reviewerTeam: z
    .string()
    .max(255)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  setupMode: z.enum(["customer-managed", "weldall-managed"]),
  /** Commit status contexts whose target URL is the preview and the live link. */
  previewStatusContext: statusContext.default("weldall/preview"),
  liveStatusContext: statusContext.default("weldall/live"),
});

/** Public policy only: the bot user's token is provisioned in the admin UI, never in a manifest. */
export function validateForgejoConfiguration(value: unknown) {
  const parsed = forgejoConfigSchema.safeParse(value);
  if (!parsed.success)
    throw new CliError(
      `Invalid Forgejo provider configuration: ${parsed.error.issues
        .map((issue) => issue.path.join(".") || "provider")
        .join(", ")}`,
    );
  return parsed.data;
}
