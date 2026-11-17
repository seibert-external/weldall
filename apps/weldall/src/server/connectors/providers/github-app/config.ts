import { z } from "zod";
import { ConnectorError } from "../../errors";

export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_APP_CREDENTIAL_KIND = "github-app-private-key";

/** GitHub logins: alphanumerics and single inner hyphens, at most 39 characters. */
const login = z
  .string()
  .max(39)
  .regex(/^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/);
const repositoryName = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/)
  .refine((value) => value !== "." && value !== "..");
/** Accepts YAML numbers and strings; stored as a decimal string. */
const numericId = z
  .union([
    z.string().regex(/^[1-9][0-9]{0,15}$/),
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform(String);

/** Maps the API origin to the host serving git and browser URLs; null for unsupported layouts. */
export function deriveWebBaseUrl(apiBaseUrl: string): string | null {
  const url = new URL(apiBaseUrl);
  if (url.href === `${GITHUB_API_BASE_URL}/`) return "https://github.com";
  // GitHub Enterprise Cloud with data residency: api.<subdomain>.ghe.com.
  if (url.pathname === "/" && /^api\.[a-z0-9-]+\.ghe\.com$/.test(url.hostname))
    return `https://${url.hostname.slice(4)}`;
  return null;
}

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
        deriveWebBaseUrl(value) !== null
      );
    } catch {
      return false;
    }
  }, "Use https://api.github.com or https://api.<subdomain>.ghe.com (GitHub Enterprise Server is not supported yet)");

const template = z.strictObject({
  /** Stable name that publish requests and the app registry refer to. */
  name: z
    .string()
    .max(100)
    .regex(/^[a-z0-9][a-z0-9._-]*$/),
  /** Template repository as `owner/name`. */
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
    }, "Use owner/name"),
});

export const githubAppConfigSchema = z.strictObject({
  appId: numericId,
  /** Organisation that owns published repositories and has the App installed. */
  organization: login,
  /** Resolved from the organisation when omitted. */
  installationId: numericId.optional(),
  apiBaseUrl: apiBaseUrl.default(GITHUB_API_BASE_URL),
  templates: z
    .array(template)
    .min(1)
    .max(50)
    .refine(
      (values) => new Set(values.map(({ name }) => name)).size === values.length,
      "Template names must be unique",
    ),
  /** Prepended to every new repository name; may be empty when the organisation is dedicated. */
  repositoryNamePrefix: z
    .string()
    .max(40)
    .regex(/^[A-Za-z0-9._-]*$/),
  /** Team slug that reviews pull requests and needs write access to new repositories. */
  reviewerTeam: z
    .string()
    .max(100)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  setupMode: z.enum(["customer-managed", "weldall-managed"]),
  /**
   * GitHub deployment environments whose link is the app's live link, spelled as the CI names
   * them (GitHub is asked for each name as given); the link of any other environment is a preview
   * link. How the template's CI reports its link is not settled yet (INV-185).
   */
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
export type GitHubAppConfig = z.output<typeof githubAppConfigSchema>;

/** Parses stored or administrator-supplied configuration before any provider use. */
export function parseGitHubAppConfiguration(value: unknown): GitHubAppConfig {
  const config = githubAppConfigSchema.parse(value);
  if (config.setupMode !== "customer-managed")
    throw new ConnectorError(
      "unsupported_setup_mode",
      'Setup mode "weldall-managed" is not available yet. Use "customer-managed": the organisation provides the branch rule, reviewer team access and CI secrets.',
    );
  return config;
}
