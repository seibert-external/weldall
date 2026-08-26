import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAdminEmail } from "@/server/admin/service";
import { auth } from "@/server/auth/auth";
import { getEffectiveCliLogoUrls } from "@/server/branding";
import { listDirectoryResources } from "@/server/directory/search";
import { DirectoryHeader } from "../_components/directory-header";
import { ResourceDirectoryTable } from "../_components/directory-table";
import { DirectoryUserMenu } from "../_components/directory-user-menu";

export const dynamic = "force-dynamic";

export default async function ResourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ resource?: string | string[] }>;
}) {
  const [logoUrls, session] = await Promise.all([
    getEffectiveCliLogoUrls(),
    auth.api.getSession({ headers: await headers() }),
  ]);
  if (!session?.user.email) redirect("/login");

  const [resources, isAdmin, params] = await Promise.all([
    listDirectoryResources(),
    isAdminEmail(session.user.email),
    searchParams,
  ]);
  const selectedKey = typeof params.resource === "string" ? params.resource : undefined;

  return (
    <div className="public-page">
      <DirectoryHeader logoUrls={logoUrls}>
        <DirectoryUserMenu email={session.user.email} isAdmin={isAdmin} />
      </DirectoryHeader>
      <main className="public-page-main">
        <ResourceDirectoryTable resources={resources} selectedKey={selectedKey} />
      </main>
    </div>
  );
}
