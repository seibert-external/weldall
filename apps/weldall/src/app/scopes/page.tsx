import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAdminEmail } from "@/server/admin/service";
import { auth } from "@/server/auth/auth";
import { getEffectiveCliLogoUrls } from "@/server/branding";
import { listDirectoryScopes } from "@/server/directory/search";
import { DirectoryHeader } from "../_components/directory-header";
import { ScopeDirectoryTable } from "../_components/directory-table";
import { DirectoryUserMenu } from "../_components/directory-user-menu";

export const dynamic = "force-dynamic";

export default async function ScopesPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string | string[] }>;
}) {
  const [logoUrls, session] = await Promise.all([
    getEffectiveCliLogoUrls(),
    auth.api.getSession({ headers: await headers() }),
  ]);
  if (!session?.user.email) redirect("/login");

  const [scopes, isAdmin, params] = await Promise.all([
    listDirectoryScopes(session.user.email),
    isAdminEmail(session.user.email),
    searchParams,
  ]);
  const selectedKey = typeof params.scope === "string" ? params.scope : undefined;

  return (
    <div className="public-page">
      <DirectoryHeader logoUrls={logoUrls}>
        <DirectoryUserMenu email={session.user.email} isAdmin={isAdmin} />
      </DirectoryHeader>
      <main className="public-page-main">
        <ScopeDirectoryTable scopes={scopes} selectedKey={selectedKey} />
      </main>
    </div>
  );
}
