import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { isAdminEmail } from "@/server/admin/service";
import { auth } from "@/server/auth/auth";
import { getEffectiveCliLogoUrls } from "@/server/branding";
import { DirectoryHeader } from "./directory-header";
import { DirectoryUserMenu } from "./directory-user-menu";

/**
 * Shared shell for public (non-admin) pages: the directory header with
 * browse nav + account menu, plus a main slot for page content.
 */
export async function PublicPage({ children }: { children?: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user.email) redirect("/login");
  const [logoUrls, isAdmin] = await Promise.all([
    getEffectiveCliLogoUrls(),
    isAdminEmail(session.user.email),
  ]);

  return (
    <div className="public-page">
      <DirectoryHeader logoUrls={logoUrls}>
        <DirectoryUserMenu email={session.user.email} isAdmin={isAdmin} />
      </DirectoryHeader>
      <main className="public-page-main">{children}</main>
    </div>
  );
}
