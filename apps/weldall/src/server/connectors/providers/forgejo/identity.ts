import { z } from "zod";
import { ConnectorError } from "../../errors";
import type { GitCommitIdentity } from "../../git-host";
import { forgejoApi, unexpected } from "./api";
import type { ForgejoConfig } from "./config";

const userResponse = z.object({
  login: z.string(),
  email: z.string().max(320),
});

const unavailable = (message: string) =>
  new ConnectorError("commit_identity_unavailable", message, 503);

/**
 * The bot user's identity for the commits a publish pushes: its login and its primary email
 * address, read from Forgejo. Forgejo attributes a commit to the user whose (verified) address it
 * carries, so the address is never invented; a different login means the token belongs to
 * someone else, and nothing is returned.
 */
export async function readForgejoCommitIdentity({
  config,
  token,
  signal,
}: {
  config: ForgejoConfig;
  token: string;
  signal: AbortSignal;
}): Promise<GitCommitIdentity> {
  const response = await forgejoApi({
    baseUrl: config.baseUrl,
    path: "/user",
    method: "GET",
    token,
    signal,
  });
  if (response.status === 403)
    throw unavailable("Forgejo did not name the bot user: its token lacks the scope read:user.");
  if (response.status !== 200) throw unexpected(response);
  const parsed = userResponse.safeParse(response.json);
  if (!parsed.success) throw unavailable("Forgejo did not return the bot user.");
  if (parsed.data.login.toLowerCase() !== config.botUser.toLowerCase())
    throw unavailable(
      `The token belongs to the Forgejo user ${parsed.data.login}, not to the bot user ${config.botUser}.`,
    );
  const email = parsed.data.email.trim();
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(email))
    throw unavailable(`The bot user ${config.botUser} has no usable email address in Forgejo.`);
  return { name: parsed.data.login, email };
}
