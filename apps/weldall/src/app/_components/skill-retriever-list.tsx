"use client";

import { Avatar } from "@astryxdesign/core/Avatar";
import type { SkillRetrievalSummaryEntry } from "@/server/skills/retrieval-metrics";

/**
 * Avatars and names of the users that recently retrieved a skill. The same list renders in the
 * sidebar (capped) and in the popover that shows every retriever, so it lives in one component.
 * Avatars come from the same-origin proxy path in the summary; users without one show initials.
 */
export function SkillRetrieverList({
  retrievers,
  isScrollable = false,
}: {
  retrievers: readonly SkillRetrievalSummaryEntry[];
  isScrollable?: boolean;
}) {
  return (
    <ul
      className={
        isScrollable ? "skill-retriever-list skill-retriever-list-scroll" : "skill-retriever-list"
      }
    >
      {retrievers.map((retriever) => (
        <li key={retriever.id}>
          <Avatar
            name={retriever.displayName}
            size="xsmall"
            {...(retriever.avatarUrl ? { src: retriever.avatarUrl } : {})}
          />
          <span className="skill-retriever-name">{retriever.displayName}</span>
        </li>
      ))}
    </ul>
  );
}
