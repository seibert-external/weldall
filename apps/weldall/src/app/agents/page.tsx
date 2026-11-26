import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAdminEmail } from "@/server/admin/service";
import { agentsOffered, listVisibleAgents } from "@/server/agents/service";
import { auth } from "@/server/auth/auth";
import { getEffectiveCliLogoUrls } from "@/server/branding";
import { canViewStatistics } from "@/server/statistics/access";
import { DirectoryHeader } from "../_components/directory-header";
import { AgentDirectoryTable } from "../_components/directory-table";
import { DirectoryUserMenu } from "../_components/directory-user-menu";

export const dynamic = "force-dynamic";

/**
 * The agents shared with the signed-in person: their own, and those shared with a permission they
 * hold (`listVisibleAgents`, the list a client gets from `GET /api/me/agents`). Read-only: an
 * agent is made, changed and started in the client.
 */
export default async function AgentsPage() {
  const [logoUrls, session] = await Promise.all([
    getEffectiveCliLogoUrls(),
    auth.api.getSession({ headers: await headers() }),
  ]);
  if (!session?.user.email) redirect("/login");

  const [{ items }, isAdmin, canSeeStatistics, showAgents] = await Promise.all([
    listVisibleAgents({ id: session.user.id, email: session.user.email }),
    isAdminEmail(session.user.email),
    canViewStatistics(session.user.email),
    agentsOffered(),
  ]);

  return (
    <div className="public-page">
      <DirectoryHeader logoUrls={logoUrls}>
        <DirectoryUserMenu
          email={session.user.email}
          isAdmin={isAdmin}
          canViewStatistics={canSeeStatistics}
          showAgents={showAgents}
        />
      </DirectoryHeader>
      <main className="public-page-main">
        <AgentDirectoryTable
          agents={items.map((agent) => ({
            key: agent.id,
            name: agent.name,
            description: agent.description,
            sharedBy: agent.own ? "You" : (agent.ownerName ?? "Unknown"),
            scopes: agent.scopes,
            resource: agent.source.name,
            expired: agent.expired,
          }))}
        />
      </main>
    </div>
  );
}
