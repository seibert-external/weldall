import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { isAdminEmail } from "@/server/admin/service";
import { agentsOffered } from "@/server/agents/service";
import { appsOffered, listVisibleApps, ownerLabel } from "@/server/apps/service";
import { auth } from "@/server/auth/auth";
import { getEffectiveCliLogoUrls } from "@/server/branding";
import { refreshDueCatalogs } from "@/server/skills/catalogs";
import { canViewStatistics } from "@/server/statistics/access";
import { AppDirectory } from "../_components/app-directory";
import { DirectoryHeader } from "../_components/directory-header";
import { DirectoryUserMenu } from "../_components/directory-user-menu";

export const dynamic = "force-dynamic";

/**
 * The apps the signed-in person may see: their own, and those shared with a permission they hold
 * (`listVisibleApps`, the list a client gets from `GET /api/me/apps`). Read-only.
 */
export default async function AppsPage() {
  const [logoUrls, session] = await Promise.all([
    getEffectiveCliLogoUrls(),
    auth.api.getSession({ headers: await headers() }),
  ]);
  if (!session?.user.email) redirect("/login");

  after(() => refreshDueCatalogs());
  const [{ items }, isAdmin, canSeeStatistics, showAgents, showApps] = await Promise.all([
    listVisibleApps({ id: session.user.id, email: session.user.email }),
    isAdminEmail(session.user.email),
    canViewStatistics(session.user.email),
    agentsOffered(),
    appsOffered(),
  ]);

  return (
    <div className="public-page">
      <DirectoryHeader logoUrls={logoUrls}>
        <DirectoryUserMenu
          email={session.user.email}
          isAdmin={isAdmin}
          canViewStatistics={canSeeStatistics}
          showAgents={showAgents}
          showApps={showApps}
        />
      </DirectoryHeader>
      <main className="public-page-main">
        <AppDirectory
          apps={items.map((app) => ({
            id: app.id,
            name: app.name,
            description: app.description,
            own: app.own,
            hasOwner: app.hasOwner,
            owner: ownerLabel(app),
            scopes: app.scopes,
            resource: { key: app.source.key, name: app.source.name },
            repository: app.repository?.name ?? null,
            running: app.url !== null,
            updatedAt: app.updatedAt,
            expired: app.expired,
          }))}
        />
      </main>
    </div>
  );
}
