import { auth } from "@/server/auth/auth";
import {
  DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS,
  MAX_SKILL_RETRIEVAL_WINDOW_DAYS,
  getVisibleSkillRetrievalSummary,
  parseSkillRetrievalWindowDays,
} from "@/server/skills/retrieval-metrics";
import { SkillTemporarilyUnavailableError } from "@/server/skills/service";

function windowDaysError(value: string | null): Response | null {
  if (value === null || value.trim() === "") return null;
  if (parseSkillRetrievalWindowDays(value) !== null) return null;
  return Response.json(
    {
      error: "invalid_request",
      error_description: `days must be an integer between 1 and ${MAX_SKILL_RETRIEVAL_WINDOW_DAYS}`,
    },
    { status: 400 },
  );
}

async function get(request: Request, context: { params: Promise<{ slug: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { slug } = await context.params;
  const queryDays = new URL(request.url).searchParams.get("days");
  const invalid = windowDaysError(queryDays);
  if (invalid) return invalid;
  const windowDays =
    parseSkillRetrievalWindowDays(queryDays) ?? DEFAULT_SKILL_RETRIEVAL_WINDOW_DAYS;

  try {
    const summary = await getVisibleSkillRetrievalSummary(session.user.email, slug, windowDays);
    if (!summary) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json(summary, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof SkillTemporarilyUnavailableError) {
      return Response.json(
        { error: "temporarily_unavailable", error_description: error.message },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    throw error;
  }
}

export { get as GET };
