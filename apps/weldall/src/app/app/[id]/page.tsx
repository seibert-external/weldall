import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AnimatedSkillHeadline } from "../../_components/animated-skill-headline";
import { DirectoryHeader } from "../../_components/directory-header";
import { DirectoryUserMenu } from "../../_components/directory-user-menu";
import { SkillNoiseBadge } from "../../_components/skill-noise-badge";
import { isAdminEmail } from "@/server/admin/service";
import { agentsOffered } from "@/server/agents/service";
import { httpsHref } from "@/server/apps/href";
import { appsOffered, getVisibleApp, ownerLabel } from "@/server/apps/service";
import { auth } from "@/server/auth/auth";
import { getEffectiveCliLogoUrls } from "@/server/branding";
import { canViewStatistics } from "@/server/statistics/access";

export const dynamic = "force-dynamic";

/**
 * One app the signed-in person may see: what it is for, where it runs, where its code is, who owns
 * it and whom it is shared with. An app the person may not see is a 404, like one that does not
 * exist. Links are rendered only for https URLs (`httpsHref`).
 */
export default async function AppPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, requestHeaders, logoUrls] = await Promise.all([
    params,
    headers(),
    getEffectiveCliLogoUrls(),
  ]);
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user.email) redirect("/login");

  const [app, isAdmin, canSeeStatistics, showAgents, showApps] = await Promise.all([
    getVisibleApp({ id: session.user.id, email: session.user.email }, decodeURIComponent(id)),
    isAdminEmail(session.user.email),
    canViewStatistics(session.user.email),
    agentsOffered(),
    appsOffered(),
  ]);
  if (!app) notFound();
  const appHref = httpsHref(app.url);
  const repositoryHref = httpsHref(app.repository?.url);

  return (
    <div className="skill-detail-page">
      <DirectoryHeader logoUrls={logoUrls}>
        <DirectoryUserMenu
          email={session.user.email}
          isAdmin={isAdmin}
          canViewStatistics={canSeeStatistics}
          showAgents={showAgents}
          showApps={showApps}
        />
      </DirectoryHeader>
      <main className="skill-detail-main">
        <Button href="/apps" label="All apps" size="sm" variant="secondary" />

        <header className="skill-detail-hero">
          <AnimatedSkillHeadline title={app.name} />
          {appHref ? (
            <div className="mt-4">
              <Button
                href={appHref}
                label="Open app"
                rel="noopener noreferrer"
                target="_blank"
                variant="primary"
              />
            </div>
          ) : null}
        </header>

        <div className="skill-detail-layout">
          {app.expired ? (
            <div className="skill-detail-warning">
              <Banner
                container="card"
                description={`The resource that found this app set ${app.expiresAt.slice(0, 10)} as its review date. Weldall only flags this; nothing about the app changes.`}
                status="warning"
                title="Review due"
              />
            </div>
          ) : null}
          <article className="skill-detail-instructions">
            <div className="skill-markdown">
              <h2>Purpose</h2>
              <p>{app.description}</p>
            </div>
          </article>
          <aside className="skill-detail-sidebar" aria-label="App information">
            <section>
              <dl>
                <div>
                  <dt>Owner</dt>
                  <dd>{ownerLabel(app)}</dd>
                </div>
                <div>
                  <dt>Link</dt>
                  <dd>
                    {appHref ? (
                      <a href={appHref} rel="noopener noreferrer" target="_blank">
                        {appHref}
                      </a>
                    ) : (
                      <span className="skill-detail-muted">None</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Repository</dt>
                  <dd>
                    {app.repository && repositoryHref ? (
                      <a href={repositoryHref} rel="noopener noreferrer" target="_blank">
                        {app.repository.name}
                      </a>
                    ) : (
                      <span className="skill-detail-muted">None</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Found by</dt>
                  <dd>{app.source.name}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{app.createdAt.slice(0, 10)}</dd>
                </div>
                <div>
                  <dt>Last changed</dt>
                  <dd>{app.updatedAt.slice(0, 10)}</dd>
                </div>
                <div>
                  <dt>{app.expired ? "Review due since" : "Review by"}</dt>
                  <dd>{app.expiresAt.slice(0, 10)}</dd>
                </div>
                <div>
                  <dt>App ID</dt>
                  <dd>
                    <code>{app.id}</code>
                  </dd>
                </div>
              </dl>
            </section>
            <section>
              <h2>Shared with holders of any of</h2>
              {app.scopes.length ? (
                <ul className="skill-scope-list">
                  {app.scopes.map((scope) => (
                    <li key={scope}>
                      <SkillNoiseBadge tone="granted">{scope}</SkillNoiseBadge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="skill-detail-muted">
                  {app.own ? "Only you." : "Nobody besides its owner."}
                </p>
              )}
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
