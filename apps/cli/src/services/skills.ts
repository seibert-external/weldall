import { createDpopProof } from "@weldall/oauth";
import type { WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { isRecord, successfulResponse } from "../http.js";
import { withLock } from "../storage/lock.js";
import { withAccess } from "./auth.js";

export interface SkillSummary {
  slug: string;
  title: string;
  requiredScopes: string[];
  hidden: boolean;
  available: boolean;
  missingScopes: string[];
  updatedAt: string;
}

export interface SkillDetail extends SkillSummary {
  content: string;
  document: string;
}

const isSkillSummary = (value: unknown): value is SkillSummary =>
  isRecord(value) &&
  typeof value.slug === "string" &&
  typeof value.title === "string" &&
  Array.isArray(value.requiredScopes) &&
  value.requiredScopes.every((scope) => typeof scope === "string") &&
  typeof value.hidden === "boolean" &&
  typeof value.available === "boolean" &&
  Array.isArray(value.missingScopes) &&
  value.missingScopes.every((scope) => typeof scope === "string") &&
  typeof value.updatedAt === "string";

async function authenticatedGet(config: WeldallConfig, url: string) {
  return withLock(() =>
    withAccess(config, async (session) => {
      const proof = await createDpopProof({
        ...session.credentials,
        method: "GET",
        url,
        accessToken: session.accessToken,
      });
      return successfulResponse(
        await fetch(url, {
          headers: {
            accept: "application/json",
            authorization: `DPoP ${session.accessToken}`,
            dpop: proof,
          },
          redirect: "error",
        }),
        "Weldall skill registry request",
      );
    }),
  );
}

export async function listSkills(config: WeldallConfig): Promise<SkillSummary[]> {
  const value = await authenticatedGet(config, config.skills);
  if (!Array.isArray(value) || value.some((skill) => !isSkillSummary(skill))) {
    throw new CliError("Weldall returned an invalid skill registry");
  }
  return value;
}

export async function showSkill(config: WeldallConfig, slug: string): Promise<SkillDetail> {
  const value = await authenticatedGet(
    config,
    `${config.skills}/${encodeURIComponent(slug.trim())}`,
  );
  if (
    !isSkillSummary(value) ||
    !("content" in value) ||
    typeof value.content !== "string" ||
    !("document" in value) ||
    typeof value.document !== "string"
  ) {
    throw new CliError("Weldall returned an invalid skill document");
  }
  return value as SkillDetail;
}
