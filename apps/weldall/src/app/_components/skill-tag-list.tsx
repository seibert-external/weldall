"use client";

import { HoverCard } from "@astryxdesign/core/HoverCard";
import { useLayoutEffect, useRef, useState } from "react";

export interface SkillTagItem {
  key: string;
  label: string;
  isResource?: boolean;
}

/**
 * Skill tags as chips. With `isSingleLine`, tags that do not fit on one line
 * collapse into a "+N" chip whose hover card shows them.
 */
export function SkillTagList({
  isSingleLine,
  tags,
}: {
  isSingleLine: boolean;
  tags: readonly SkillTagItem[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(tags.length);
  const tagSignature = tags.map(({ key }) => key).join("\n");

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!isSingleLine || !container || !measure) {
      setVisibleCount(tags.length);
      return;
    }

    const update = () => setVisibleCount(countFittingTags(container, measure));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
    // tagSignature stands in for `tags`, which is a new array on every render.
  }, [isSingleLine, tagSignature, tags.length]);

  const shownTags = isSingleLine ? tags.slice(0, visibleCount) : tags;
  const hiddenTags = isSingleLine ? tags.slice(visibleCount) : [];
  const hiddenLabels = hiddenTags.map(({ label }) => label).join(", ");

  return (
    <div
      className="skill-card-tags"
      data-single-line={isSingleLine || undefined}
      ref={containerRef}
    >
      {shownTags.map(renderTag)}
      {hiddenTags.length ? (
        <HoverCard
          alignment="end"
          content={
            <span className="skill-card-hovercard skill-card-hovercard-tags">
              {hiddenTags.map(renderTag)}
            </span>
          }
          hasHoverIndication={false}
          placement="below"
        >
          <span
            aria-label={`${hiddenTags.length} more tags: ${hiddenLabels}`}
            className="skill-card-tag-more"
            tabIndex={0}
          >
            +{hiddenTags.length}
          </span>
        </HoverCard>
      ) : null}
      {isSingleLine ? (
        // Invisible copy of every chip, used only to measure their widths.
        <div aria-hidden="true" className="skill-card-tags-measure" ref={measureRef}>
          {tags.map(renderTag)}
          <span className="skill-card-tag-more">+{tags.length}</span>
        </div>
      ) : null}
    </div>
  );
}

function renderTag({ isResource, key, label }: SkillTagItem) {
  return (
    <span className={isResource ? "skill-card-resource-tag" : undefined} key={key}>
      {label}
    </span>
  );
}

function countFittingTags(container: HTMLElement, measure: HTMLElement): number {
  const chips = Array.from(measure.children) as HTMLElement[];
  const moreChip = chips.pop();
  const gap = Number.parseFloat(getComputedStyle(container).columnGap) || 0;
  const available = container.clientWidth;
  const widths = chips.map((chip) => chip.offsetWidth);
  const totalWidth = widths.reduce((sum, width, index) => sum + width + (index ? gap : 0), 0);
  if (totalWidth <= available) return widths.length;

  const reserved = (moreChip?.offsetWidth ?? 0) + gap;
  let used = 0;
  for (const [index, width] of widths.entries()) {
    const next = used + (index ? gap : 0) + width;
    if (next + reserved > available) return index;
    used = next;
  }
  return widths.length;
}
