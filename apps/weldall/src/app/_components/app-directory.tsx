"use client";

import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { parseAsString, parseAsStringEnum, useQueryStates } from "nuqs";
import { useMemo, type CSSProperties, type SVGProps } from "react";
import { resolveSkillAppearance } from "./skill-appearance";
import { SkillAppearanceIcon } from "./skill-appearance-icon";

/** An app as the directory shows it on a card. */
export interface DirectoryApp {
  id: string;
  name: string;
  description: string;
  own: boolean;
  /** False when the resource reports no owner. */
  hasOwner: boolean;
  /** "You" for the person's own, "No owner" when the resource reports none. */
  owner: string;
  scopes: string[];
  resource: { key: string; name: string };
  /** The repository's name (`org/repo`); null for an app without one. */
  repository: string | null;
  /** Whether the app has a link to where it runs. */
  running: boolean;
  updatedAt: string;
  expired: boolean;
}

const SHARES = ["all", "mine", "others"] as const;
type Share = (typeof SHARES)[number];
const shareLabels: Record<Share, string> = {
  all: "All",
  // Owners can be missing; an app without one is never the person's own.
  mine: "Owned by me",
  others: "Shared with me",
};
const SORTS = ["name", "changed"] as const;
type Sort = (typeof SORTS)[number];
const sortOptions = [
  { value: "name", label: "Name" },
  { value: "changed", label: "Last changed" },
];

/**
 * The apps the signed-in person may see, as cards like the agents: filtered by whether they own
 * them, by resource and by permission, searched and sorted. A card opens the app's page.
 */
export function AppDirectory({ apps }: { apps: DirectoryApp[] }) {
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
    () => options(apps.map((app) => [app.resource.key, app.resource.name])),
    [apps],
  );
  const scopeOptions = useMemo(
    () =>
      options(apps.flatMap((app) => app.scopes.map((scope): [string, string] => [scope, scope]))),
    [apps],
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
      apps
        .filter(
          (app) =>
            (state.share === "all" || (state.share === "mine") === app.own) &&
            (!resource || app.resource.key === resource) &&
            (!scope || app.scopes.includes(scope)) &&
            matches(app, terms),
        )
        .sort((left, right) =>
          state.sort === "changed"
            ? right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name)
            : left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
        ),
    [apps, resource, scope, state.share, state.sort, terms],
  );

  return (
    <section className="skill-directory-layout" aria-label="Apps">
      <div className="skill-directory-tags">
        <div className="skill-directory-tag-viewport">
          <div className="skill-directory-tag-list">
            <div aria-label="Whose apps" role="group">
              {SHARES.map((share) => (
                <Button
                  aria-pressed={state.share === share}
                  icon={
                    share === "all" ? (
                      <Icon color="inherit" icon={GridIcon} size="sm" />
                    ) : (
                      <SkillAppearanceIcon height={16} seed={`apps-${share}`} width={16} />
                    )
                  }
                  key={share}
                  label={shareLabels[share]}
                  onClick={() => void setState({ share: share === "all" ? null : share })}
                  size="lg"
                  style={tagStyle(`apps-${share}`)}
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
          <h1>{state.share === "all" ? "All apps" : shareLabels[state.share]}</h1>
          <div className="directory-heading-actions">
            <Selector
              changeAction={async (value) => {
                await setState({ sort: value === "changed" ? "changed" : null });
              }}
              isLabelHidden
              label="Sort apps"
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
                label="Search apps"
                onChange={(value) => void setState({ q: value || null })}
                placeholder="Search apps"
                startIcon="search"
                value={state.q}
                width="100%"
              />
            </div>
          </div>
        </div>
        {shown.length ? (
          <div className="skill-directory-list">
            {shown.map((app, index) => (
              <AppCard app={app} animationOrder={Math.min(index, 8)} key={app.id} />
            ))}
          </div>
        ) : (
          <div className="skill-directory-empty">
            <h2>{apps.length ? "No matching apps" : "No apps are shared with you"}</h2>
            <p>
              {apps.length
                ? "Try another search or another filter."
                : "Apps you own, and apps shared with a permission you hold, appear here."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function AppCard({ app, animationOrder }: { app: DirectoryApp; animationOrder: number }) {
  const gradient = resolveSkillAppearance(app.id);
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
        aria-label={`View ${app.name}`}
        className="skill-card-link"
        href={`/app/${encodeURIComponent(app.id)}`}
      />
      <div className="skill-card-icon" aria-hidden="true">
        <SkillAppearanceIcon seed={app.id} />
      </div>
      <div className="skill-card-heading">
        <div className="skill-card-title">
          <h2>{app.name}</h2>
        </div>
        {app.description && app.description !== app.name ? (
          <p className="skill-card-preview">{app.description}</p>
        ) : null}
        <div className="skill-card-tags">
          <span className="skill-card-resource-tag">
            {app.own ? "owned by you" : app.hasOwner ? `by ${app.owner}` : "no owner"}
          </span>
          {app.repository ? <span>{app.repository}</span> : null}
          {app.running ? null : <span>no link</span>}
          {app.expired ? <span>review due</span> : null}
        </div>
      </div>
    </article>
  );
}

function matches(app: DirectoryApp, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const text = [
    app.name,
    app.description,
    app.owner,
    app.resource.name,
    app.repository ?? "",
    ...app.scopes,
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
