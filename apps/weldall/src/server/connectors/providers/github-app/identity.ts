import { z } from "zod";
import { ConnectorError } from "../../errors";
import type { GitCommitIdentity } from "../../git-host";
import { githubApi, segment } from "./api";
import { createAppJwt } from "./jwt";

/** The App's slug and bot user change only when the App is renamed or recreated. */
const IDENTITY_TTL_MS = 60 * 60_000;
const MAX_CACHE_ENTRIES = 100;

const appResponse = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/) });
const userResponse = z.object({
  id: z.number().int().positive(),
  login: z.string(),
  type: z.string(),
});

/** Noreply domain per web host; only github.com is confirmed, so other hosts get no identity. */
const NOREPLY_DOMAINS: Record<string, string> = {
  "https://github.com": "users.noreply.github.com",
};

/** Caches the resolved identity per App; failures are not cached. */
export function createCommitIdentityCache({ now = Date.now }: { now?: () => number } = {}) {
  const entries = new Map<string, { identity: GitCommitIdentity; until: number }>();
  return {
    async resolve(key: string, load: () => Promise<GitCommitIdentity>) {
      const cached = entries.get(key);
      if (cached && cached.until > now()) return cached.identity;
      const identity = await load();
      if (entries.size >= MAX_CACHE_ENTRIES) entries.delete(entries.keys().next().value!);
      entries.set(key, { identity, until: now() + IDENTITY_TTL_MS });
      return identity;
    },
  };
}
export type CommitIdentityCache = ReturnType<typeof createCommitIdentityCache>;
export const commitIdentities = createCommitIdentityCache();

const unavailable = (message: string) =>
  new ConnectorError("commit_identity_unavailable", message, 503);

/**
 * The App's bot identity, which GitHub uses to attribute the commits a publish pushes:
 * `<slug>[bot]` and `<bot user id>+<slug>[bot]@users.noreply.github.com`. The number is the bot
 * user's id, read from GitHub, never derived from the App id: a wrong number would attribute the
 * commit to an unrelated account.
 */
export async function readGitHubCommitIdentity({
  apiBaseUrl,
  webBaseUrl,
  appId,
  loadPrivateKey,
  mintToken,
  signal,
}: {
  apiBaseUrl: string;
  webBaseUrl: string;
  appId: string;
  loadPrivateKey: () => Promise<string>;
  /** Any installation token; the user lookup needs no permission beyond metadata. */
  mintToken: (signal: AbortSignal) => Promise<string>;
  signal: AbortSignal;
}): Promise<GitCommitIdentity> {
  const domain = NOREPLY_DOMAINS[webBaseUrl];
  if (!domain)
    throw unavailable(`Commit attribution is only known for github.com, not ${webBaseUrl}.`);
  const app = await githubApi({
    apiBaseUrl,
    path: "/app",
    method: "GET",
    token: createAppJwt({ appId, privateKey: await loadPrivateKey() }),
    signal,
  });
  const parsedApp = app.status === 200 ? appResponse.safeParse(app.json) : null;
  if (!parsedApp?.success)
    throw unavailable(`GitHub did not return the App's name (HTTP ${app.status}).`);
  const login = `${parsedApp.data.slug}[bot]`;
  const user = await githubApi({
    apiBaseUrl,
    path: `/users/${segment(login)}`,
    method: "GET",
    token: await mintToken(signal),
    signal,
  });
  const parsedUser = user.status === 200 ? userResponse.safeParse(user.json) : null;
  if (
    !parsedUser?.success ||
    parsedUser.data.type !== "Bot" ||
    parsedUser.data.login.toLowerCase() !== login
  )
    throw unavailable(`GitHub did not return the App's bot account (HTTP ${user.status}).`);
  return { name: login, email: `${parsedUser.data.id}+${login}@${domain}` };
}
