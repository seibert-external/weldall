import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import type { SVGProps } from "react";
import { after } from "next/server";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { CopySkillPromptButton, SkillPromptTerminal } from "../../_components/copy-skill-prompt";
import { DirectoryHeader } from "../../_components/directory-header";
import { DirectoryUserMenu } from "../../_components/directory-user-menu";
import { SkillRetrievalSummarySection } from "../../_components/skill-retrieval-summary";
import { SkillRetrievalFlame } from "../../_components/skill-retrieval-flame";
import { SkillContent } from "../../_components/skill-content";
import { formatTagLabel } from "../../_components/format-tag";
import { SkillNoiseBadge } from "../../_components/skill-noise-badge";
import { SkillIconTile } from "../../_components/skill-icon-tile";
import { isAdminEmail } from "@/server/admin/service";
import { auth } from "@/server/auth/auth";
import { getEffectiveCliLogoUrls } from "@/server/branding";
import { resolveLucideIconNode } from "@/server/skills/appearance-icons";
import { resolveBrandIcon } from "@/server/skills/brand-icons";
import { refreshDueCatalogs } from "@/server/skills/catalogs";
import { getSkillRetrievalSummaryBySlug } from "@/server/skills/retrieval-metrics";
import { getVisibleSkill } from "@/server/skills/service";
import { canViewStatistics } from "@/server/statistics/access";

export const dynamic = "force-dynamic";

export default async function SkillPage({ params }: { params: Promise<{ slug: string }> }) {
  const [{ slug }, requestHeaders, logoUrls] = await Promise.all([
    params,
    headers(),
    getEffectiveCliLogoUrls(),
  ]);
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user.email) redirect("/login");

  after(() => refreshDueCatalogs());
  const retrievalSummaryPromise = getSkillRetrievalSummaryBySlug(slug).catch(() => null);
  const [skill, isAdmin, canSeeStatistics, retrievalSummary] = await Promise.all([
    getVisibleSkill(session.user.email, slug),
    isAdminEmail(session.user.email),
    canViewStatistics(session.user.email),
    retrievalSummaryPromise,
  ]);
  if (!skill) notFound();
  const iconNode = await resolveLucideIconNode(skill.meta?.appearance?.icon);
  const brand = resolveBrandIcon(skill.meta?.appearance?.brandIcon);

  return (
    <div className="skill-detail-page">
      <DirectoryHeader logoUrls={logoUrls}>
        <DirectoryUserMenu
          email={session.user.email}
          isAdmin={isAdmin}
          canViewStatistics={canSeeStatistics}
        />
      </DirectoryHeader>
      <main className="skill-detail-main">
        <div className="skill-detail-layout">
          <div className="skill-detail-primary">
            {skill.missingScopes.length ? (
              <div className="skill-detail-warning">
                <Banner
                  container="card"
                  description={`Your account is missing the following required scopes: ${skill.missingScopes.join(", ")}.`}
                  status="warning"
                  title="Missing required scopes"
                />
              </div>
            ) : null}

            <div className="skill-detail-intro">
              <Card padding={8}>
                <div className="skill-detail-toolbar">
                  <a className="skill-detail-back" href="/skills">
                    <ArrowLeftIcon aria-hidden="true" />
                    Back to skills overview
                  </a>
                  <CopySkillPromptButton slug={skill.slug} title={skill.title} />
                </div>

                <header className="skill-detail-hero">
                  <div className="skill-detail-title-row">
                    <SkillIconTile
                      appearance={skill.meta?.appearance}
                      brand={brand ? { hex: brand.hex, path: brand.path } : undefined}
                      iconNode={iconNode}
                      seed={skill.slug}
                      size={44}
                    />
                    <h1 aria-label={skill.title}>
                      {skill.title}
                      {retrievalSummary ? (
                        <SkillRetrievalFlame
                          count={retrievalSummary.uniqueRetrievalCount}
                          days={retrievalSummary.windowDays}
                        />
                      ) : null}
                    </h1>
                  </div>
                  <SkillPromptTerminal slug={skill.slug} title={skill.title} />
                </header>

                <div className="skill-detail-instructions">
                  <SkillContent content={skill.content} />
                </div>
              </Card>
            </div>
          </div>
          <aside className="skill-detail-sidebar" aria-label="Skill information">
            <Card padding={6}>
              <div className="skill-detail-sidebar-sections">
                <section>
                  <dl>
                    {skill.meta?.owner !== undefined ? (
                      <div>
                        <dt>Owner</dt>
                        <dd>
                          <code>{skill.meta.owner}</code>
                        </dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>Skill ID</dt>
                      <dd>
                        <code>{skill.slug}</code>
                      </dd>
                    </div>
                    {skill.lastUpdatedAt !== undefined ? (
                      <div>
                        <dt>Last updated at</dt>
                        <dd>{skill.lastUpdatedAt}</dd>
                      </div>
                    ) : null}
                  </dl>
                </section>
                <SkillRetrievalSummarySection initialSummary={retrievalSummary} slug={skill.slug} />
                {skill.meta?.tags !== undefined ? (
                  <section>
                    <h2>Tags</h2>
                    {skill.meta.tags.length ? (
                      <ul className="skill-scope-list">
                        {skill.meta.tags.map((tag, index) => (
                          <li key={`${index}:${tag}`}>
                            <SkillNoiseBadge>{formatTagLabel(tag)}</SkillNoiseBadge>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="skill-detail-muted">No tags.</p>
                    )}
                  </section>
                ) : null}
                <section>
                  <h2>Resources</h2>
                  {skill.involvedResources.length ? (
                    <ul className="skill-scope-list">
                      {skill.involvedResources.map((resource) => (
                        <li key={resource.key}>
                          <SkillNoiseBadge tone="resource">{resource.name}</SkillNoiseBadge>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="skill-detail-muted">No involved resources.</p>
                  )}
                </section>
                <section>
                  <h2>Required scopes</h2>
                  {skill.requiredScopes.length ? (
                    <ul className="skill-scope-list">
                      {skill.requiredScopes.map((scope) => (
                        <li key={scope}>
                          <SkillNoiseBadge
                            tone={skill.missingScopes.includes(scope) ? "missing" : "granted"}
                          >
                            {scope}
                          </SkillNoiseBadge>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="skill-detail-muted">No additional scopes required.</p>
                  )}
                </section>
              </div>
            </Card>
          </aside>
        </div>
      </main>
    </div>
  );
}

function ArrowLeftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}
