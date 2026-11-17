import { z } from "zod";
import { CliError } from "../errors.js";

const GITHUB_API_BASE_URL = "https://api.github.com";
const login = z
  .string()
  .max(39)
  .regex(/^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/);
const repositoryName = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/)
  .refine((value) => value !== "." && value !== "..");
const numericId = z
  .union([
    z.string().regex(/^[1-9][0-9]{0,15}$/),
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform(String);
const apiBaseUrl = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash &&
        value === (url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`) &&
        (value === GITHUB_API_BASE_URL ||
          (url.pathname === "/" && /^api\.[a-z0-9-]+\.ghe\.com$/.test(url.hostname)))
      );
    } catch {
      return false;
    }
  });

/**
 * Public GitHub App connector policy; mirrors the server schema. The server decides which
 * setup modes are available, so a newer server needs no CLI update to enable one.
 */
export const githubAppConfigSchema = z.strictObject({
  appId: numericId,
  organization: login,
  installationId: numericId.optional(),
  apiBaseUrl: apiBaseUrl.default(GITHUB_API_BASE_URL),
  templates: z
    .array(
      z.strictObject({
        name: z
          .string()
          .max(100)
          .regex(/^[a-z0-9][a-z0-9._-]*$/),
        repository: z
          .string()
          .max(140)
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
    .max(100)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  setupMode: z.enum(["customer-managed", "weldall-managed"]),
  /** Deployment environments whose link is the live link; others are previews. */
  liveEnvironments: z
    .array(
      z
        .string()
        .min(1)
        .max(255)
        .regex(/^[^\u0000-\u001f\u007f]+$/),
    )
    .min(1)
    .max(5)
    .default(["production"]),
});

/** Public policy only: the App's private key is provisioned in the admin UI, never in a manifest. */
export function validateGitHubAppConfiguration(value: unknown) {
  const parsed = githubAppConfigSchema.safeParse(value);
  if (!parsed.success)
    throw new CliError(
      `Invalid GitHub App provider configuration: ${parsed.error.issues
        .map((issue) => issue.path.join(".") || "provider")
        .join(", ")}`,
    );
  return parsed.data;
}
