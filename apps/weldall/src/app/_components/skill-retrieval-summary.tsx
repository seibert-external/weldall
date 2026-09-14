"use client";

import { Popover } from "@astryxdesign/core/Popover";
import { useQuery } from "@tanstack/react-query";
import type { SkillRetrievalSummary as SkillRetrievalSummaryDto } from "@/server/skills/retrieval-metrics";
import { SkillRetrieverList } from "./skill-retriever-list";
import { skillRetrievalLabel } from "./skill-retrieval-flame";
import { useTRPC } from "@/trpc/react";

const DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS = 7;
/** The sidebar lists the most recent retrievers; the rest stay behind the popover. */
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
  const visibleRetrievers = retrievers.slice(0, MAX_VISIBLE_RETRIEVERS);
  const remainingRetrievers = retrievers.length - visibleRetrievers.length;

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
          {visibleRetrievers.length ? <SkillRetrieverList retrievers={visibleRetrievers} /> : null}
          {remainingRetrievers > 0 ? (
            <Popover
              content={<SkillRetrieverList isScrollable retrievers={retrievers} />}
              hasCloseButton={false}
              label={`Users who retrieved this skill in the last ${summary.windowDays} days`}
              width="16rem"
            >
              <button className="skill-retriever-more" type="button">
                {`and ${remainingRetrievers} more ${remainingRetrievers === 1 ? "user" : "users"}`}
              </button>
            </Popover>
          ) : null}
        </>
      )}
    </section>
  );
}
