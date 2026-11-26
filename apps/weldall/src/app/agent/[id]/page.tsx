import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AnimatedSkillHeadline } from "../../_components/animated-skill-headline";
import { DirectoryHeader } from "../../_components/directory-header";
import { DirectoryUserMenu } from "../../_components/directory-user-menu";
import { SkillContent } from "../../_components/skill-content";
import { SkillNoiseBadge } from "../../_components/skill-noise-badge";
import { isAdminEmail } from "@/server/admin/service";
import { agentContent, agentsOffered, getVisibleAgent } from "@/server/agents/service";
import { auth } from "@/server/auth/auth";
import { getEffectiveCliLogoUrls } from "@/server/branding";
import { canViewStatistics } from "@/server/statistics/access";

export const dynamic = "force-dynamic";

/**
 * One agent shared with the signed-in person: what it is told to do, what it asks for and uses,
 * who shared it with whom. An agent the person may not use is a 404, like one that does not exist.
 */
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, requestHeaders, logoUrls] = await Promise.all([
    params,
    headers(),
    getEffectiveCliLogoUrls(),
  ]);
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session?.user.email) redirect("/login");

  const [agent, isAdmin, canSeeStatistics, showAgents] = await Promise.all([
    getVisibleAgent({ id: session.user.id, email: session.user.email }, decodeURIComponent(id)),
    isAdminEmail(session.user.email),
    canViewStatistics(session.user.email),
    agentsOffered(),
  ]);
  if (!agent) notFound();
  const content = agentContent(agent.config);
  const badges = (items: string[], tone: "tag" | "resource" | "granted" = "tag") => (
    <ul className="skill-scope-list">
      {items.map((item) => (
        <li key={item}>
          <SkillNoiseBadge tone={tone}>{item}</SkillNoiseBadge>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="skill-detail-page">
      <DirectoryHeader logoUrls={logoUrls}>
        <DirectoryUserMenu
          email={session.user.email}
          isAdmin={isAdmin}
          canViewStatistics={canSeeStatistics}
          showAgents={showAgents}
        />
      </DirectoryHeader>
      <main className="skill-detail-main">
        <Button href="/agents" label="All agents" size="sm" variant="secondary" />

        <header className="skill-detail-hero">
          <AnimatedSkillHeadline title={agent.name} />
          {agent.description && agent.description !== agent.name ? (
            <p className="skill-detail-muted" style={{ marginTop: 12 }}>
              {agent.description}
            </p>
          ) : null}
        </header>

        <div className="skill-detail-layout">
          {agent.expired ? (
            <div className="skill-detail-warning">
              <Banner
                container="card"
                description="Its owner has not confirmed for a while that this agent is still needed. It can still be used."
                status="warning"
                title="Not confirmed for a while"
              />
            </div>
          ) : null}
          <article className="skill-detail-instructions">
            {content ? (
              <>
                <SkillContent
                  content={content.instructions || "_This agent has no instructions._"}
                />
                {content.prompt || content.starters.length ? (
                  // The same text styles as the instructions above.
                  <div className="skill-markdown">
                    {content.prompt ? (
                      <>
                        <h2>First message</h2>
                        <p>{content.prompt}</p>
                      </>
                    ) : null}
                    {content.starters.length ? (
                      <>
                        <h2>Starter questions</h2>
                        <ul>
                          {content.starters.map((starter, index) => (
                            <li key={`${index}:${starter}`}>{starter}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="skill-detail-muted">
                This agent is in a format ({agent.config.format}, version {agent.config.version})
                that is not shown here. Open it in the client.
              </p>
            )}
          </article>
          <aside className="skill-detail-sidebar" aria-label="Agent information">
            <section>
              <dl>
                <div>
                  <dt>Shared by</dt>
                  <dd>{agent.own ? "You" : (agent.ownerName ?? "Unknown")}</dd>
                </div>
                <div>
                  <dt>Kept at</dt>
                  <dd>{agent.source.name}</dd>
                </div>
                <div>
                  <dt>Last changed</dt>
                  <dd>{agent.updatedAt.slice(0, 10)}</dd>
                </div>
                <div>
                  <dt>Agent ID</dt>
                  <dd>
                    <code>{agent.id}</code>
                  </dd>
                </div>
              </dl>
            </section>
            <section>
              <h2>Shared with holders of any of</h2>
              {agent.scopes.length ? (
                badges(agent.scopes, "granted")
              ) : (
                <p className="skill-detail-muted">Only you.</p>
              )}
            </section>
            {content ? (
              <>
                <section>
                  <h2>Skills</h2>
                  {content.chosen ? (
                    content.chosen.skills.length ? (
                      badges(content.chosen.skills)
                    ) : (
                      <p className="skill-detail-muted">None.</p>
                    )
                  ) : (
                    <p className="skill-detail-muted">All skills of the person using it.</p>
                  )}
                </section>
                <section>
                  <h2>Connections</h2>
                  {content.chosen ? (
                    content.chosen.connections.length ? (
                      badges(content.chosen.connections, "resource")
                    ) : (
                      <p className="skill-detail-muted">None.</p>
                    )
                  ) : (
                    <p className="skill-detail-muted">All connections of the person using it.</p>
                  )}
                </section>
                {content.inputs.length ? (
                  <section>
                    <h2>Asks for</h2>
                    {badges(
                      content.inputs.map((input) =>
                        input.description && input.description !== input.key
                          ? `${input.key}: ${input.description}`
                          : input.key,
                      ),
                    )}
                  </section>
                ) : null}
              </>
            ) : null}
          </aside>
        </div>
      </main>
    </div>
  );
}
