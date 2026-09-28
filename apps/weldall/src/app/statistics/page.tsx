import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAdminEmail } from "@/server/admin/service";
import { auth } from "@/server/auth/auth";
import { getEffectiveCliLogoUrls } from "@/server/branding";
import { canViewStatistics } from "@/server/statistics/access";
import {
  STATISTICS_INTERVAL_COOKIE,
  resolveStatisticsInterval,
} from "@/server/statistics/interval";
import { getUsageStatistics } from "@/server/statistics/service";
import { DirectoryHeader } from "../_components/directory-header";
import { DirectoryUserMenu } from "../_components/directory-user-menu";
import { StatisticsAccessDenied, StatisticsDashboard } from "../_components/statistics-dashboard";

export const dynamic = "force-dynamic";

export default async function StatisticsPage({
  searchParams,
}: {
  searchParams: Promise<{ interval?: string | string[] }>;
}) {
  const [logoUrls, session] = await Promise.all([
    getEffectiveCliLogoUrls(),
    auth.api.getSession({ headers: await headers() }),
  ]);
  if (!session?.user.email) redirect("/login");

  const [isAdmin, canSeeStatistics, params, cookieStore] = await Promise.all([
    isAdminEmail(session.user.email),
    canViewStatistics(session.user.email),
    searchParams,
    cookies(),
  ]);
  const interval = resolveStatisticsInterval(
    params.interval,
    cookieStore.get(STATISTICS_INTERVAL_COOKIE)?.value,
  );
  // A failed server render leaves the first load to the client query instead of failing the page.
  const statistics = canSeeStatistics ? await getUsageStatistics(interval).catch(() => null) : null;

  return (
    <div className="public-page">
      <DirectoryHeader logoUrls={logoUrls}>
        <DirectoryUserMenu
          email={session.user.email}
          isAdmin={isAdmin}
          canViewStatistics={canSeeStatistics}
        />
      </DirectoryHeader>
      <main className="public-page-main">
        {canSeeStatistics ? (
          <StatisticsDashboard initialInterval={interval} initialStatistics={statistics} />
        ) : (
          <StatisticsAccessDenied />
        )}
      </main>
    </div>
  );
}
