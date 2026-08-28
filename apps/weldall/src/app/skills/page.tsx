import { after } from "next/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAdminEmail } from "@/server/admin/service";
import { auth } from "@/server/auth/auth";
import { getEffectiveCliLogoUrls } from "@/server/branding";
import { resolveLucideIconNode } from "@/server/skills/appearance-icons";
import { refreshDueCatalogs } from "@/server/skills/catalogs";
import { listVisibleSkills } from "@/server/skills/service";
import { getSkillRetrievalCountsBySlugs } from "@/server/skills/retrieval-metrics";
import { DirectoryHeader } from "../_components/directory-header";
import { DirectoryUserMenu } from "../_components/directory-user-menu";
import { SkillDirectory } from "../_components/skill-directory";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const [logoUrls, session] = await Promise.all([
    getEffectiveCliLogoUrls(),
    auth.api.getSession({ headers: await headers() }),
  ]);
  if (!session?.user.email) redirect("/login");

  after(() => refreshDueCatalogs());
  const [{ items: skills }, isAdmin] = await Promise.all([
    listVisibleSkills(session.user.email),
    isAdminEmail(session.user.email),
  ]);
  const retrievalCounts = await getSkillRetrievalCountsBySlugs(skills.map(({ slug }) => slug));

  const directorySkills = await Promise.all(
    skills.map(async (skill) => {
      const iconNode = await resolveLucideIconNode(skill.meta?.appearance?.icon);
      return iconNode ? { ...skill, appearanceIconNode: iconNode } : skill;
    }),
  );

  return (
    <div className="skill-directory-page">
      <DirectoryHeader logoUrls={logoUrls}>
        <DirectoryUserMenu email={session.user.email} isAdmin={isAdmin} />
      </DirectoryHeader>
      <main className="skill-directory-main">
        <SkillDirectory retrievalCounts={retrievalCounts} skills={directorySkills} />
      </main>
    </div>
  );
}
