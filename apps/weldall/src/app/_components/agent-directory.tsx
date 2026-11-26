"use client";

import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { parseAsString, parseAsStringEnum, useQueryStates } from "nuqs";
import { useMemo, type CSSProperties, type SVGProps } from "react";
import { resolveSkillAppearance } from "./skill-appearance";
import { SkillAppearanceIcon } from "./skill-appearance-icon";

/** A shared agent as the directory shows it on a card. */
export interface DirectoryAgent {
  id: string;
  name: string;
  description: string;
  own: boolean;
  /** "You" for the person's own. */
  sharedBy: string;
  scopes: string[];
  resource: { key: string; name: string };
  updatedAt: string;
  expired: boolean;
  /** The skills the agent chose; empty when it uses all of them or its content is not shown. */
  skills: string[];
}

const SHARES = ["all", "mine", "others"] as const;
type Share = (typeof SHARES)[number];
const shareLabels: Record<Share, string> = {
  all: "All",
  mine: "Shared by me",
  others: "Shared with me",
};
const SORTS = ["name", "changed"] as const;
type Sort = (typeof SORTS)[number];
const sortOptions = [
  { value: "name", label: "Name" },
  { value: "changed", label: "Last changed" },
];

/**
 * The agents shared with the signed-in person, as cards like the skills: filtered by who shared,
 * by resource and by permission, searched and sorted. A card opens the agent's page.
 */
export function AgentDirectory({ agents }: { agents: DirectoryAgent[] }) {
  const [state, setState] = useQueryStates(
    {
      q: parseAsString.withDefault(""),
      resource: parseAsString.withDefault(""),
      scope: parseAsString.withDefault(""),
      share: parseAsStringEnum<Share>([...SHARES]).withDefault("all"),
      sort: parseAsStringEnum<Sort>([...SORTS]).withDefault("name"),
    },
    { history: "replace", shallow: true },
  );
  const options = (pairs: Array<[string, string]>) =>
    Array.from(new Map(pairs))
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label));
  const resourceOptions = useMemo(
    () => options(agents.map((agent) => [agent.resource.key, agent.resource.name])),
    [agents],
  );
  const scopeOptions = useMemo(
    () =>
      options(
        agents.flatMap((agent) => agent.scopes.map((scope): [string, string] => [scope, scope])),
      ),
    [agents],
  );
  const resource = resourceOptions.some(({ value }) => value === state.resource)
    ? state.resource
    : "";
  const scope = scopeOptions.some(({ value }) => value === state.scope) ? state.scope : "";
  const terms = useMemo(
    () => state.q.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean),
    [state.q],
  );
  const shown = useMemo(
    () =>
      agents
        .filter(
          (agent) =>
            (state.share === "all" || (state.share === "mine") === agent.own) &&
            (!resource || agent.resource.key === resource) &&
            (!scope || agent.scopes.includes(scope)) &&
            matches(agent, terms),
        )
        .sort((left, right) =>
          state.sort === "changed"
            ? right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name)
            : left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
        ),
    [agents, resource, scope, state.share, state.sort, terms],
  );

  return (
    <section className="skill-directory-layout" aria-label="Agents">
      <div className="skill-directory-tags">
        <div className="skill-directory-tag-viewport">
          <div className="skill-directory-tag-list">
            <div aria-label="Who shared" role="group">
              {SHARES.map((share) => (
                <Button
                  aria-pressed={state.share === share}
                  icon={
                    share === "all" ? (
                      <Icon color="inherit" icon={GridIcon} size="sm" />
                    ) : (
                      <SkillAppearanceIcon height={16} seed={`agents-${share}`} width={16} />
                    )
                  }
                  key={share}
                  label={shareLabels[share]}
                  onClick={() => void setState({ share: share === "all" ? null : share })}
                  size="lg"
                  style={tagStyle(`agents-${share}`)}
                  variant="ghost"
                >
                  {shareLabels[share]}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="skill-directory-results">
        <div className="skill-directory-results-heading">
          <h1>{state.share === "all" ? "All agents" : shareLabels[state.share]}</h1>
          <div className="directory-heading-actions">
            <Selector
              changeAction={async (value) => {
                await setState({ sort: value === "changed" ? "changed" : null });
              }}
              isLabelHidden
              label="Sort agents"
              options={sortOptions}
              startIcon="arrowsUpDown"
              value={state.sort}
              width={168}
            />
            <Selector
              hasClear
              isLabelHidden
              changeAction={async (value) => {
                await setState({ resource: value });
              }}
              label="Filter by resource"
              options={resourceOptions}
              placeholder="All resources"
              value={resource || null}
              width={190}
            />
            <Selector
              hasClear
              isLabelHidden
              changeAction={async (value) => {
                await setState({ scope: value });
              }}
              label="Filter by permission"
              options={scopeOptions}
              placeholder="All permissions"
              value={scope || null}
              width={220}
            />
            <div className="directory-inline-search">
              <TextInput
                hasClear
                isLabelHidden
                label="Search agents"
                onChange={(value) => void setState({ q: value || null })}
                placeholder="Search agents"
                startIcon="search"
                value={state.q}
                width="100%"
              />
            </div>
          </div>
        </div>
        {shown.length ? (
          <div className="skill-directory-list">
            {shown.map((agent, index) => (
              <AgentCard agent={agent} animationOrder={Math.min(index, 8)} key={agent.id} />
            ))}
          </div>
        ) : (
          <div className="skill-directory-empty">
            <h2>{agents.length ? "No matching agents" : "No agents are shared with you"}</h2>
            <p>
              {agents.length
                ? "Try another search or another filter."
                : "An agent is made and shared in the client. Agents shared with a permission you hold appear here."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function AgentCard({ agent, animationOrder }: { agent: DirectoryAgent; animationOrder: number }) {
  const gradient = resolveSkillAppearance(agent.id);
  const style = {
    "--skill-card-light-from": gradient.light[0],
    "--skill-card-light-to": gradient.light[1],
    "--skill-card-dark-from": gradient.dark[0],
    "--skill-card-dark-to": gradient.dark[1],
    "--skill-card-animation-order": animationOrder,
  } as CSSProperties;
  return (
    <article className="skill-card" style={style}>
      <a
        aria-label={`View ${agent.name}`}
        className="skill-card-link"
        href={`/agent/${encodeURIComponent(agent.id)}`}
      />
      <div className="skill-card-icon" aria-hidden="true">
        <SkillAppearanceIcon seed={agent.id} />
      </div>
      <div className="skill-card-heading">
        <div className="skill-card-title">
          <h2>{agent.name}</h2>
        </div>
        {agent.description && agent.description !== agent.name ? (
          <p className="skill-card-preview">{agent.description}</p>
        ) : null}
        <div className="skill-card-tags">
          <span className="skill-card-resource-tag">
            {agent.own ? "shared by you" : `by ${agent.sharedBy}`}
          </span>
          {agent.expired ? <span>not confirmed for a while</span> : null}
          {agent.skills.map((skill) => (
            <span key={skill}>{skill}</span>
          ))}
        </div>
      </div>
    </article>
  );
}

function matches(agent: DirectoryAgent, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const text = [
    agent.name,
    agent.description,
    agent.sharedBy,
    agent.resource.name,
    ...agent.scopes,
    ...agent.skills,
  ]
    .join(" ")
    .toLocaleLowerCase();
  return terms.every((term) => text.includes(term));
}

function tagStyle(seed: string): CSSProperties {
  const gradient = resolveSkillAppearance(seed);
  return {
    "--skill-tag-light-from": gradient.light[0],
    "--skill-tag-light-to": gradient.light[1],
    "--skill-tag-dark-from": gradient.dark[0],
    "--skill-tag-dark-to": gradient.dark[1],
  } as CSSProperties;
}

function GridIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" {...props}>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  );
}
