import { createDpopProof } from "@weldall/sdk";
import type { WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { isRecord, successfulResponse } from "../http.js";
import { withLock } from "../storage/lock.js";
import { withAccess } from "./auth.js";

export type SkillVisibility = "DEFAULT" | "HIDDEN_IF_UNALLOWED";
export type SkillSource = { type: "admin" } | { type: "resource"; key: string; name: string };
export interface SkillMeta {
  tags?: string[];
  owner?: string;
  appearance?: Record<string, string>;
}

export interface SkillSummary {
  slug: string;
  title: string;
  requiredScopes: string[];
  visibility: SkillVisibility;
  available: boolean;
  missingScopes: string[];
  updatedAt: string;
  meta?: SkillMeta;
  lastUpdatedAt?: string;
  source: SkillSource;
}

export interface SkillWarning {
  source: string;
  code: string;
}

export interface SkillList {
  items: SkillSummary[];
  warnings: SkillWarning[];
}

export interface SkillDetail extends SkillSummary {
  content: string;
  document: string;
}

const isMeta = (value: unknown): value is SkillMeta =>
  isRecord(value) &&
  (value.tags === undefined ||
    (Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string"))) &&
  (value.owner === undefined || typeof value.owner === "string") &&
  (value.appearance === undefined ||
    (isRecord(value.appearance) &&
      Object.values(value.appearance).every((entry) => typeof entry === "string")));

const isSource = (value: unknown): value is SkillSource =>
  isRecord(value) &&
  (value.type === "admin" ||
    (value.type === "resource" && typeof value.key === "string" && typeof value.name === "string"));

const isSkillSummary = (value: unknown): value is SkillSummary =>
  isRecord(value) &&
  typeof value.slug === "string" &&
  typeof value.title === "string" &&
  Array.isArray(value.requiredScopes) &&
  value.requiredScopes.every((scope) => typeof scope === "string") &&
  (value.visibility === "DEFAULT" || value.visibility === "HIDDEN_IF_UNALLOWED") &&
  typeof value.available === "boolean" &&
  Array.isArray(value.missingScopes) &&
  value.missingScopes.every((scope) => typeof scope === "string") &&
  typeof value.updatedAt === "string" &&
  (value.meta === undefined || isMeta(value.meta)) &&
  (value.lastUpdatedAt === undefined || typeof value.lastUpdatedAt === "string") &&
  isSource(value.source);

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

export async function listSkills(config: WeldallConfig): Promise<SkillList> {
  const value = await authenticatedGet(config, config.skills);
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.some((skill) => !isSkillSummary(skill)) ||
    !Array.isArray(value.warnings) ||
    value.warnings.some(
      (warning) =>
        !isRecord(warning) ||
        typeof warning.source !== "string" ||
        typeof warning.code !== "string",
    )
  ) {
    throw new CliError("Weldall returned an invalid skill registry");
  }
  return value as unknown as SkillList;
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
