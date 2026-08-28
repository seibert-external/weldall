import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { after } from "next/server";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AnimatedSkillHeadline } from "../../_components/animated-skill-headline";
import { CopySkillPrompt } from "../../_components/copy-skill-prompt";
import { DirectoryHeader } from "../../_components/directory-header";
import { DirectoryUserMenu } from "../../_components/directory-user-menu";
import { SkillRetrievalSummarySection } from "../../_components/skill-retrieval-summary";
import { SkillRetrievalFlame } from "../../_components/skill-retrieval-flame";
import { SkillContent } from "../../_components/skill-content";
import { SkillNoiseBadge } from "../../_components/skill-noise-badge";
import { isAdminEmail } from "@/server/admin/service";
import { auth } from "@/server/auth/auth";
import { getEffectiveCliLogoUrls } from "@/server/branding";
import { refreshDueCatalogs } from "@/server/skills/catalogs";
import { getSkillRetrievalSummaryBySlug } from "@/server/skills/retrieval-metrics";
import { getVisibleSkill } from "@/server/skills/service";

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
  const [skill, isAdmin, retrievalSummary] = await Promise.all([
    getVisibleSkill(session.user.email, slug),
    isAdminEmail(session.user.email),
    retrievalSummaryPromise,
  ]);
  if (!skill) notFound();

  return (
    <div className="skill-detail-page">
      <DirectoryHeader logoUrls={logoUrls}>
        <DirectoryUserMenu email={session.user.email} isAdmin={isAdmin} />
      </DirectoryHeader>
      <main className="skill-detail-main">
        <Button href="/skills" label="All skills" size="sm" variant="secondary" />

        <header className="skill-detail-hero">
          <AnimatedSkillHeadline title={skill.title}>
            {retrievalSummary ? (
              <SkillRetrievalFlame
                count={retrievalSummary.uniqueRetrievalCount}
                days={retrievalSummary.windowDays}
              />
            ) : null}
          </AnimatedSkillHeadline>
          <CopySkillPrompt slug={skill.slug} title={skill.title} />
        </header>

        <div className="skill-detail-layout">
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
          <article className="skill-detail-instructions">
            <SkillContent content={skill.content} />
          </article>
          <aside className="skill-detail-sidebar" aria-label="Skill information">
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
                        <SkillNoiseBadge>{tag}</SkillNoiseBadge>
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
          </aside>
        </div>
      </main>
    </div>
  );
}
