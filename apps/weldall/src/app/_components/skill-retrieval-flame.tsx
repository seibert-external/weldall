"use client";

import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { CSSProperties, SVGProps } from "react";

/**
 * Five colorful flame levels. The tier colors the flame, which sits in the flow of the skill
 * title: a small icon and the number of people that pulled the skill.
 */
export const SKILL_RETRIEVAL_TIERS = [
  { key: "spark", minCount: 1, icon: "#6c8ae6" },
  { key: "ember", minCount: 3, icon: "#4fbf9a" },
  { key: "flame", minCount: 10, icon: "#f0a93c" },
  { key: "blaze", minCount: 25, icon: "#f2793c" },
  { key: "inferno", minCount: 60, icon: "#f2557a" },
] as const;

export type SkillRetrievalTier = (typeof SKILL_RETRIEVAL_TIERS)[number];

/** Mirrors DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS on the server, which clients must not import. */
const DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS = 7;

export function resolveSkillRetrievalTier(count: number): SkillRetrievalTier | null {
  if (count <= 0) return null;
  return [...SKILL_RETRIEVAL_TIERS].reverse().find((tier) => count >= tier.minCount) ?? null;
}

export function skillRetrievalLabel(count: number, days: number): string {
  return `${count} unique ${count === 1 ? "retrieval" : "retrievals"} in the last ${days} ${
    days === 1 ? "day" : "days"
  }`;
}

export function skillRetrievalTooltip(count: number, days: number): string {
  return `${count} ${count === 1 ? "user" : "users"} retrieved this skill in the last ${days} ${
    days === 1 ? "day" : "days"
  }`;
}

/**
 * Colored flame plus count, with a glow from the third tier up and a flicker at the top.
 * Renders inside the skill title, so sizes are in `em` and the number inherits the heading color.
 */
export function SkillRetrievalFlame({
  count,
  days = DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS,
}: {
  count: number;
  days?: number;
}) {
  const tier = resolveSkillRetrievalTier(count);
  const style = tier ? ({ "--skill-flame-icon": tier.icon } as CSSProperties) : undefined;
  const tooltip = skillRetrievalTooltip(count, days);

  return (
    <Tooltip content={tooltip} hasHoverIndication={false}>
      <span
        className="skill-retrieval-flame"
        data-tier={tier?.key ?? "none"}
        style={style}
        aria-label={tooltip}
        tabIndex={0}
      >
        <FlameIcon aria-hidden="true" />
        <span>{count}</span>
      </span>
    </Tooltip>
  );
}

function FlameIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" {...props}>
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}
