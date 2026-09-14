"use client";

import { Avatar } from "@astryxdesign/core/Avatar";
import { useQuery } from "@tanstack/react-query";
import type { SkillRetrievalSummary as SkillRetrievalSummaryDto } from "@/server/skills/retrieval-metrics";
import { skillRetrievalLabel } from "./skill-retrieval-flame";
import { useTRPC } from "@/trpc/react";

const DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS = 7;
/** The sidebar lists the most recent retrievers and summarizes the rest. */
const MAX_VISIBLE_RETRIEVERS = 10;

export function SkillRetrievalSummarySection({
  slug,
  days = DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS,
  initialSummary = null,
}: {
  slug: string;
  days?: number;
  initialSummary?: SkillRetrievalSummaryDto | null;
}) {
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.skillRetrievalMetrics.summary.queryOptions({ slug, days }),
    ...(initialSummary ? { initialData: initialSummary } : {}),
  });
  const summary = query.data ?? initialSummary;
  const retrievers = summary?.uniqueRetrievers ?? [];
  const remainingRetrievers = retrievers.length - MAX_VISIBLE_RETRIEVERS;

  return (
    <section>
      <h2>Retrievals</h2>
      {!summary ? (
        <p className="skill-detail-muted">
          {query.error ? "Retrievals unavailable." : "Loading retrievals…"}
        </p>
      ) : (
        <>
          <p className="skill-detail-muted">
            {skillRetrievalLabel(summary.uniqueRetrievalCount, summary.windowDays)}
          </p>
          {retrievers.length ? (
            <ul className="skill-retriever-list">
              {retrievers.slice(0, MAX_VISIBLE_RETRIEVERS).map((retriever) => (
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
          ) : null}
          {remainingRetrievers > 0 ? (
            <p className="skill-detail-muted">
              {`and ${remainingRetrievers} more ${remainingRetrievers === 1 ? "user" : "users"}`}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
