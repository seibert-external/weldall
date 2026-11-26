"use client";

import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { parseAsString, parseAsStringEnum, useQueryStates } from "nuqs";
import { useEffect, useMemo, type CSSProperties, type SVGProps } from "react";
import type { VisibleSkill } from "@/server/skills/service";
import type { SkillAppearanceIconNode } from "./skill-appearance";
import { SkillIconTile, type SkillTileBrand } from "./skill-icon-tile";
import { formatTagLabel } from "./format-tag";
import {
  DEFAULT_SKILL_DIRECTORY_SORT,
  isSkillDirectorySort,
  SKILL_DIRECTORY_SORT_OPTIONS,
  SKILL_DIRECTORY_SORTS,
  sortSkillsForDirectory,
  type SkillDirectorySort,
} from "./skill-directory-sorting";
import { SkillRetrievalFlame } from "./skill-retrieval-flame";

type DirectorySkill = VisibleSkill & {
  appearanceIconNode?: SkillAppearanceIconNode;
  appearanceBrand?: SkillTileBrand;
};

const skillSortOptions = [...SKILL_DIRECTORY_SORT_OPTIONS];

export function SkillDirectory({
  retrievalCounts,
  skills,
}: {
  retrievalCounts: Record<string, number>;
  skills: DirectorySkill[];
}) {
  const [{ q: query, resource: resourceFilter, sort, tag: tagFilter }, setDirectoryQuery] =
    useQueryStates(
      {
        q: parseAsString.withDefault(""),
        resource: parseAsString.withDefault(""),
        sort: parseAsStringEnum<SkillDirectorySort>([...SKILL_DIRECTORY_SORTS]).withDefault(
          DEFAULT_SKILL_DIRECTORY_SORT,
        ),
        tag: parseAsString.withDefault(""),
      },
      { history: "replace", shallow: true },
    );
  const searchTerms = useMemo(
    () => query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean),
    [query],
  );
  const resourceOptions = useMemo(
    () =>
      Array.from(
        new Map(
          skills.flatMap((skill) =>
            skill.source.type === "resource" ? [[skill.source.key, skill.source.name]] : [],
          ),
        ),
      )
        .map(([value, label]) => ({ value, label }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [skills],
  );
  const activeResourceFilter = resourceOptions.some(({ value }) => value === resourceFilter)
    ? resourceFilter
    : "";
  const resourceMatchedSkills = useMemo(
    () =>
      activeResourceFilter
        ? skills.filter(
            (skill) =>
              skill.source.type === "resource" && skill.source.key === activeResourceFilter,
          )
        : skills,
    [activeResourceFilter, skills],
  );
  const searchMatchedSkills = useMemo(
    () => resourceMatchedSkills.filter((skill) => skillMatchesSearch(skill, searchTerms)),
    [resourceMatchedSkills, searchTerms],
  );
  const searchTagOptions = useMemo(
    () =>
      Array.from(new Set(searchMatchedSkills.flatMap((skill) => skill.meta?.tags ?? []))).sort(),
    [searchMatchedSkills],
  );
  const activeTagFilter = searchTagOptions.includes(tagFilter) ? tagFilter : "";
  const filteredSkills = useMemo(
    () =>
      activeTagFilter
        ? searchMatchedSkills.filter((skill) => skill.meta?.tags?.includes(activeTagFilter))
        : searchMatchedSkills,
    [activeTagFilter, searchMatchedSkills],
  );
  const sortedSkills = useMemo(
    () => sortSkillsForDirectory(filteredSkills, sort, retrievalCounts),
    [filteredSkills, retrievalCounts, sort],
  );
  const tagOptions = useMemo(() => {
    const tagSourceSkills = searchTerms.length > 0 ? filteredSkills : resourceMatchedSkills;
    return Array.from(new Set(tagSourceSkills.flatMap((skill) => skill.meta?.tags ?? [])))
      .sort()
      .map((tag) => ({ value: tag, label: formatTagLabel(tag) }));
  }, [filteredSkills, resourceMatchedSkills, searchTerms.length]);
  useEffect(() => {
    if (resourceFilter && !activeResourceFilter) {
      void setDirectoryQuery({ resource: null });
    }
  }, [activeResourceFilter, resourceFilter, setDirectoryQuery]);

  useEffect(() => {
    if (tagFilter && !searchTagOptions.includes(tagFilter)) {
      void setDirectoryQuery({ tag: null });
    }
  }, [searchTagOptions, setDirectoryQuery, tagFilter]);

  if (skills.length === 0) {
    return (
      <div className="skill-directory-empty">
        <h2>No skills available yet</h2>
        <p>Your Weldall administrator can give you access to organization skills.</p>
      </div>
    );
  }

  return (
    <section className="skill-directory-layout" aria-label="Available skills">
      <div className="skill-directory-results">
        <div className="skill-directory-results-heading">
          <h1>{activeTagFilter ? formatTagLabel(activeTagFilter) : "All skills"}</h1>
          <div className="directory-heading-actions">
            <Selector
              changeAction={async (value) => {
                await setDirectoryQuery({ sort: isSkillDirectorySort(value) ? value : sort });
              }}
              isLabelHidden
              label="Sort skills"
              options={skillSortOptions}
              size="lg"
              startIcon="arrowsUpDown"
              value={sort}
              width={168}
            />
            <Selector
              hasClear
              isLabelHidden
              changeAction={async (value) => {
                await setDirectoryQuery({ tag: value });
              }}
              label="Filter by tag"
              options={tagOptions}
              placeholder="All tags"
              size="lg"
              value={activeTagFilter || null}
              width={190}
            />
            <Selector
              hasClear
              isLabelHidden
              changeAction={async (value) => {
                await setDirectoryQuery({ resource: value });
              }}
              label="Filter by resource"
              options={resourceOptions}
              placeholder="All resources"
              size="lg"
              value={activeResourceFilter || null}
              width={190}
            />
            <div className="directory-inline-search">
              <TextInput
                hasClear
                isLabelHidden
                label="Search skills"
                onChange={(value) => void setDirectoryQuery({ q: value || null })}
                placeholder="Search skills"
                size="lg"
                startIcon="search"
                value={query}
                width="100%"
              />
            </div>
          </div>
        </div>
        {sortedSkills.length ? (
          <div className="skill-directory-list">
            {sortedSkills.map((skill, index) => (
              <SkillCard
                animationOrder={Math.min(index, 8)}
                key={skill.slug}
                retrievalCount={retrievalCounts[skill.slug] ?? 0}
                skill={skill}
              />
            ))}
          </div>
        ) : (
          <div className="skill-directory-empty">
            <h2>No matching skills</h2>
            <p>Try another search or choose a different tag.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function SkillCard({
  animationOrder,
  retrievalCount,
  skill,
}: {
  animationOrder: number;
  retrievalCount: number;
  skill: DirectorySkill;
}) {
  const resourceTag = getSkillResourceTag(skill);
  const style = {
    "--skill-card-animation-order": animationOrder,
  } as CSSProperties;

  return (
    <article className={`skill-card${skill.available ? "" : " skill-card-locked"}`} style={style}>
      <a
        aria-label={`View ${skill.title}`}
        className="skill-card-link"
        href={`/skill/${encodeURIComponent(skill.slug)}`}
      />
      <div className="skill-card-heading">
        <div className="skill-card-title">
          <SkillIconTile
            appearance={skill.meta?.appearance}
            brand={skill.appearanceBrand}
            iconNode={skill.appearanceIconNode}
            seed={skill.slug}
          />
          <div className="skill-card-name">
            <h2>{skill.title}</h2>
          </div>
          <div className="skill-card-status">
            {!skill.available ? (
              <Tooltip
                content={formatMissingScopeCount(skill.missingScopes.length)}
                hasHoverIndication={false}
              >
                <span
                  className="skill-card-lock"
                  aria-label={formatMissingScopeCount(skill.missingScopes.length)}
                  tabIndex={0}
                >
                  <Icon icon={LockIcon} color="inherit" size="sm" />
                </span>
              </Tooltip>
            ) : null}
            <SkillRetrievalFlame count={retrievalCount} />
          </div>
        </div>
        {skill.preview ? <p className="skill-card-preview">{skill.preview}</p> : null}
        {resourceTag || skill.meta?.tags?.length ? (
          <div className="skill-card-tags">
            {resourceTag ? (
              <span className="skill-card-resource-tag">{formatTagLabel(resourceTag)}</span>
            ) : null}
            {skill.meta?.tags?.map((tag, index) => (
              <span key={`${index}:${tag}`}>{formatTagLabel(tag)}</span>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function skillMatchesSearch(skill: VisibleSkill, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;

  const searchableText = [
    skill.title,
    skill.slug,
    skill.preview,
    getSkillSourceLabel(skill),
    getSkillResourceTag(skill) ?? "",
    skill.meta?.owner ?? "",
    ...(skill.meta?.tags ?? []),
    ...skill.requiredScopes,
  ]
    .join(" ")
    .toLocaleLowerCase();
  return terms.every((term) => searchableText.includes(term));
}

function getSkillSourceLabel(skill: VisibleSkill): string {
  return skill.source.type === "resource" ? skill.source.name : "Weldall";
}

function getSkillResourceTag(skill: VisibleSkill): string | undefined {
  if (skill.source.type !== "resource") return undefined;
  return skill.source.name
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function LockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" {...props}>
      <rect x="5" y="10" width="14" height="10" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function formatMissingScopeCount(count: number): string {
  return `Missing ${count} ${count === 1 ? "scope" : "scopes"}`;
}
