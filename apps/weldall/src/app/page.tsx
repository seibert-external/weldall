import { Button } from "@astryxdesign/core/Button";
import { after } from "next/server";
import { headers } from "next/headers";
import { isAdminEmail } from "../server/admin/service";
import { auth } from "../server/auth/auth";
import { getEffectiveCliLogoUrl } from "../server/branding";
import { refreshDueCatalogs } from "../server/skills/catalogs";
import { listVisibleSkills } from "../server/skills/service";
import { DirectoryHeader } from "./_components/directory-header";
import { DirectoryUserMenu } from "./_components/directory-user-menu";
import { SkillDirectory } from "./_components/skill-directory";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [logoUrl, session] = await Promise.all([
    getEffectiveCliLogoUrl(),
    auth.api.getSession({ headers: await headers() }),
  ]);

  if (!session?.user.email) return <LoggedOutHome logoUrl={logoUrl} />;

  after(() => refreshDueCatalogs());
  const [{ items: skills }, isAdmin] = await Promise.all([
    listVisibleSkills(session.user.email),
    isAdminEmail(session.user.email),
  ]);

  return (
    <div className="skill-directory-page" data-theme="light">
      <DirectoryHeader logoUrl={logoUrl}>
        <DirectoryUserMenu email={session.user.email} isAdmin={isAdmin} />
      </DirectoryHeader>
      <main className="skill-directory-main">
        <div className="skill-directory-intro">
          <div>
            <h1>Skills available to you</h1>
            <p>Browse skills available to your agent.</p>
          </div>
        </div>
        <SkillDirectory skills={skills} />
      </main>
    </div>
  );
}

function LoggedOutHome({ logoUrl }: { logoUrl: string }) {
  return (
    <div className="public-home" data-theme="light">
      <DirectoryHeader logoUrl="">
        <Button href="/login" label="Log in" size="sm" variant="primary" />
      </DirectoryHeader>
      <main className="public-home-main">
        <div
          className="public-brand-lockup"
          aria-label={logoUrl ? "Weldall with custom branding" : "Weldall"}
        >
          <img
            src="/assets/images/weldall.png"
            alt="Weldall"
            width={364}
            height={101}
            className="public-brand-logo public-brand-weldall"
          />
          {logoUrl ? (
            <>
              <span className="public-brand-x" aria-hidden="true">
                ×
              </span>
              <img
                src={logoUrl}
                alt="Configured company logo"
                width={958}
                height={245}
                className="public-brand-logo public-brand-company"
              />
            </>
          ) : null}
        </div>
        <p>Sign in to browse the skills available to your agent.</p>
        <Button href="/login" label="Log in to Weldall" variant="primary" />
      </main>
    </div>
  );
}
