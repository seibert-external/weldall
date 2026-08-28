"use client";

import { useQuery } from "@tanstack/react-query";
import type { SkillRetrievalSummary as SkillRetrievalSummaryDto } from "@/server/skills/retrieval-metrics";
import { useTRPC } from "@/trpc/react";

const DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS = 7;

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

  return (
    <section>
      <h2>Retrievals</h2>
      {!summary ? (
        <p className="skill-detail-muted">
          {query.error ? "Retrievals unavailable." : "Loading retrievals…"}
        </p>
      ) : (
        <p className="skill-detail-muted">
          {formatUniqueRetrievalSummary(summary.uniqueRetrievalCount, summary.windowDays)}
        </p>
      )}
    </section>
  );
}

function formatUniqueRetrievalSummary(count: number, days: number): string {
  const retrievalLabel = count === 1 ? "retrieval" : "retrievals";
  const dayLabel = days === 1 ? "day" : "days";
  return `${count} unique ${retrievalLabel} in the last ${days} ${dayLabel}`;
}
