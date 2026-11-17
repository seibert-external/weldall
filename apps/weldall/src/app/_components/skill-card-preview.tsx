"use client";

import { HoverCard } from "@astryxdesign/core/HoverCard";
import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";

/**
 * Skill description. With `isTruncatable`, a clamped description shows its full
 * text in a hover card.
 */
export function SkillCardPreview({
  isTruncatable,
  text,
}: {
  isTruncatable: boolean;
  text: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  useLayoutEffect(() => {
    const preview = ref.current;
    if (!isTruncatable || !preview) {
      setIsTruncated(false);
      return;
    }

    const update = () => setIsTruncated(isClamped(preview));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [isTruncatable, text]);

  return (
    <HoverCard
      alignment="start"
      content={<span className="skill-card-hovercard skill-card-hovercard-text">{text}</span>}
      hasHoverIndication={false}
      isEnabled={isTruncated}
      placement="below"
    >
      <p
        className="skill-card-preview"
        data-truncated={isTruncated || undefined}
        onClick={isTruncated ? forwardClickToCardLink : undefined}
        ref={ref}
        tabIndex={isTruncated ? 0 : undefined}
      >
        {text}
      </p>
    </HoverCard>
  );
}

function isClamped(element: HTMLElement): boolean {
  return (
    element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth
  );
}

// A truncated preview sits above the card link so it can be hovered; clicks
// still open the skill. Passing the event keeps modifier keys (new tab).
function forwardClickToCardLink(event: MouseEvent<HTMLElement>) {
  const link = event.currentTarget.closest("article")?.querySelector(".skill-card-link");
  link?.dispatchEvent(new globalThis.MouseEvent("click", event.nativeEvent));
}
