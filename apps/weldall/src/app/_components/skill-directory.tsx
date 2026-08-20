"use client";

import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useEffect, useMemo, useRef, useState, type SVGProps } from "react";
import type { VisibleSkill } from "@/server/skills/service";
import { SkillNoiseBadge } from "./skill-noise-badge";

gsap.registerPlugin(useGSAP);

const SEARCH_DEBOUNCE_MS = 200;

export function SkillDirectory({ skills }: { skills: VisibleSkill[] }) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const tagOptions = useMemo(
    () => Array.from(new Set(skills.flatMap((skill) => skill.meta?.tags ?? []))).sort(),
    [skills],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const filteredSkills = useMemo(() => {
    const normalizedQuery = debouncedQuery.trim().toLocaleLowerCase();
    return skills.filter((skill) => {
      if (tagFilter && !skill.meta?.tags?.includes(tagFilter)) return false;
      if (!normalizedQuery) return true;

      return [
        skill.title,
        skill.slug,
        getSkillSourceLabel(skill),
        skill.meta?.owner ?? "",
        skill.lastUpdatedAt ?? "",
        ...(skill.meta?.tags ?? []),
        ...skill.requiredScopes,
      ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [debouncedQuery, skills, tagFilter]);
  const filteredSkillKey = filteredSkills.map((skill) => skill.slug).join("|");

  useGSAP(
    () => {
      const list = listRef.current;
      if (!list) return;
      const rows = gsap.utils.toArray<HTMLElement>(".skill-card", list);
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduceMotion) {
        gsap.set(rows, { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" });
        return;
      }

      gsap.fromTo(
        rows,
        { opacity: 0, y: 12, scale: 0.99, filter: "blur(4px)" },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          filter: "blur(0px)",
          duration: 0.24,
          ease: "power2.out",
          stagger: { amount: 0.35, from: "start" },
          overwrite: "auto",
        },
      );
    },
    { dependencies: [filteredSkillKey], scope: listRef },
  );

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
      <aside className="skill-directory-sidebar" aria-label="Filter skills">
        <div className="skill-directory-control">
          <TextInput
            hasClear
            label="Search skills"
            onChange={setQuery}
            placeholder="Name, ID, publisher, or scope"
            size="lg"
            value={query}
            width="100%"
          />
        </div>
        <div className="skill-directory-control">
          <Selector
            hasClear
            label="Tag"
            onChange={(value) => setTagFilter(value ?? "")}
            options={tagOptions}
            placeholder="All tags"
            size="lg"
            value={tagFilter || null}
            width="100%"
          />
        </div>
      </aside>

      <div className="skill-directory-results" ref={listRef}>
        {filteredSkills.length ? (
          <div className="skill-directory-list">
            {filteredSkills.map((skill) => (
              <SkillRow skill={skill} key={skill.slug} />
            ))}
          </div>
        ) : (
          <div className="skill-directory-empty">
            <h2>No matching skills</h2>
            <p>Try a different name, ID, publisher, tag, or scope.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function SkillRow({ skill }: { skill: VisibleSkill }) {
  const content = (
    <>
      <div className="skill-card-heading">
        <div>
          <div className="skill-card-title">
            <h2>{skill.title}</h2>
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
                  <Icon icon={LockIcon} color="red" size="sm" />
                </span>
              </Tooltip>
            ) : null}
          </div>
          {skill.meta?.tags?.length ? (
            <div className="skill-card-tags">
              {skill.meta.tags.map((tag, index) => (
                <SkillNoiseBadge key={`${index}:${tag}`}>{tag}</SkillNoiseBadge>
              ))}
            </div>
          ) : null}
          {skill.preview ? <p className="skill-card-preview">{skill.preview}</p> : null}
        </div>
      </div>
    </>
  );

  return (
    <a
      className={`skill-card${skill.available ? "" : " skill-card-locked"}`}
      href={`/skill/${encodeURIComponent(skill.slug)}`}
    >
      {content}
    </a>
  );
}

function LockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" {...props}>
      <rect x="5" y="10" width="14" height="10" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function getSkillSourceLabel(skill: VisibleSkill): string {
  return skill.source.type === "resource" ? skill.source.name : "Weldall";
}

function formatMissingScopeCount(count: number): string {
  return `Missing ${count} ${count === 1 ? "scope" : "scopes"}`;
}

