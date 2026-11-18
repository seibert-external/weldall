import { isIP } from "node:net";
import { z } from "zod";
import { ConnectorError } from "../../errors";

export const FORGEJO_CREDENTIAL_KIND = "forgejo-bot-token";

/**
 * Forgejo user and organisation names: letters, digits and single inner `-`, `_` or `.`, at most
 * 40 characters (Forgejo's own rule).
 */
export const forgejoLogin = z
  .string()
  .max(40)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|[-._](?=[A-Za-z0-9]))*$/);
const repositoryName = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/)
  .refine((value) => value !== "." && value !== "..");
/** Commit status contexts; printable, without control characters. */
const statusContext = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\u0000-\u001f\u007f]+$/);

/**
 * Hostnames that always point at the Weldall server itself or at cloud metadata services. A
 * self-hosted Forgejo is usually on a private network, so private addresses are not refused:
 * the base URL is an administrator's trust decision (see `forgejoBaseUrlProblem`).
 */
const LOCAL_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

/**
 * Why `value` is not an acceptable Forgejo base URL, or null when it is. Weldall sends the bot
 * user's token to this origin, so it must be an https origin (optionally with the sub-path
 * Forgejo is served under) without credentials, port, query or fragment, named by a DNS name:
 * no IP literal, no single-label or `.localhost`/`.local` name and no metadata service. Private
 * addresses behind a DNS name stay possible on purpose, because a self-hosted Forgejo usually
 * lives in the organisation's network; the administrator who configures the connector decides
 * which instance receives the token. Requests never follow redirects.
 */
export function forgejoBaseUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Use the https URL of the Forgejo instance, e.g. https://forgejo.example.com";
  }
  if (url.protocol !== "https:") return "Use https.";
  if (url.username || url.password) return "Do not put credentials into the URL.";
  if (url.port) return "Use the default https port (no port in the URL).";
  if (url.search || url.hash || value.includes("?") || value.includes("#"))
    return "Remove the query and fragment.";
  const host = url.hostname.toLowerCase();
  if (isIP(host) || host.startsWith("["))
    return "Use the DNS name of the Forgejo instance, not an IP address.";
  if (
    !host.includes(".") ||
    host.endsWith(".") ||
    LOCAL_HOSTNAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  )
    return "Use the fully qualified DNS name of the Forgejo instance, not a local name.";
  const canonical = url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
  if (
    value !== canonical ||
    (url.pathname !== "/" && url.pathname.endsWith("/")) ||
    /%|\/\.{1,2}(?:\/|$)/.test(url.pathname)
  )
    return `Use the canonical form without a trailing slash, e.g. ${url.origin}`;
  return null;
}

const baseUrl = z
  .string()
  .max(2000)
  .superRefine((value, context) => {
    const problem = forgejoBaseUrlProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

const template = z.strictObject({
  /** Stable name that publish requests and the app registry refer to. */
  name: z
    .string()
    .max(100)
    .regex(/^[a-z0-9][a-z0-9._-]*$/),
  /** Template repository as `owner/name`. */
  repository: z
    .string()
    .max(141)
    .refine((value) => {
      const [owner, name, ...rest] = value.split("/");
      return (
        !rest.length &&
        forgejoLogin.safeParse(owner).success &&
        repositoryName.safeParse(name ?? "").success
      );
    }, "Use owner/name"),
});

export const forgejoConfigSchema = z.strictObject({
  /** https URL of the Forgejo instance, e.g. https://forgejo.example.com (no `/api/v1`). */
  baseUrl,
  /** Organisation that owns published repositories. */
  organization: forgejoLogin,
  /** The bot user whose access token the shared connection holds; checked on every check run. */
  botUser: forgejoLogin,
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
  /** Name of the organisation team that reviews pull requests; it needs write access to new repositories. */
  reviewerTeam: z
    .string()
    .max(255)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  setupMode: z.enum(["customer-managed", "weldall-managed"]),
  /**
   * Commit status contexts that carry the CI's links in their target URL: the preview link on the
   * pull request's head commit, the live link on the default branch. Forgejo has no deployments,
   * so the template's CI reports its links as commit statuses (INV-185 settles the names).
   */
  previewStatusContext: statusContext.default("weldall/preview"),
  liveStatusContext: statusContext.default("weldall/live"),
});
export type ForgejoConfig = z.output<typeof forgejoConfigSchema>;

/** Parses stored or administrator-supplied configuration before any provider use. */
export function parseForgejoConfiguration(value: unknown): ForgejoConfig {
  const config = forgejoConfigSchema.parse(value);
  if (config.setupMode !== "customer-managed")
    throw new ConnectorError(
      "unsupported_setup_mode",
      'Setup mode "weldall-managed" is not available for Forgejo. Use "customer-managed": the template repository carries the default-branch protection, and the reviewer team has access to all repositories of the organisation.',
    );
  return config;
}

/** Browser URL of a repository, from configuration only. */
export function forgejoRepositoryWebUrl(
  config: { baseUrl: string },
  repository: { owner: string; name: string },
): string {
  return `${config.baseUrl}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}
