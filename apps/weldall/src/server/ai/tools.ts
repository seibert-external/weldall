import { normalizeRequestTarget } from "@weldall/sdk";
import { tool } from "ai";
import { z } from "zod";
import type { RequestIdentifiers } from "../observability/http";
import { errorForLog, logger } from "../observability/logger";
import { resourceRegistryFor } from "../policy/resources";
import { getVisibleSkill, listVisibleSkills, type VisibleSkill } from "../skills/service";
import { recordSkillRetrievalEvent } from "../skills/retrieval-metrics";
import { delegatedResourceRequest, type ChatPrincipal } from "./delegated-resource";

const MAX_SEARCH_RESULTS = 10;
const MAX_SKILL_DOCUMENT_CHARS = 40_000;

const searchInput = z
  .object({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).default(5),
  })
  .strict();

const skillInput = z
  .object({
    slug: z.string().trim().min(1).max(120),
  })
  .strict();

const requestInput = z
  .object({
    skillSlug: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe("Skill slug returned by searchSkills and loaded with getSkill"),
    url: z.string().url().max(2_000).describe("Absolute HTTPS URL documented by the skill"),
    method: z.enum(["GET", "POST"]),
    scopes: z.array(z.string().trim().min(1).max(160)).min(1).max(10),
    json: z.json().optional().describe("JSON request body for POST requests"),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.method === "GET" && input.json !== undefined) {
      context.addIssue({
        code: "custom",
        message: "GET requests cannot include a JSON body.",
        path: ["json"],
      });
    }
    if (new Set(input.scopes).size !== input.scopes.length) {
      context.addIssue({ code: "custom", message: "Scopes must be unique.", path: ["scopes"] });
    }
  });

export type ChatTools = ReturnType<typeof createChatTools>;

export function createChatTools(input: {
  principal: ChatPrincipal;
  requestIdentifiers: RequestIdentifiers;
}) {
  const { principal, requestIdentifiers } = input;

  return {
    searchSkills: tool({
      description:
        "Search Weldall's scope-filtered skill catalog for organizational capabilities. Use this before answering requests that may require company data or actions.",
      inputSchema: searchInput,
      execute: async ({ query, limit }) => {
        const catalog = await listVisibleSkills(principal.email);
        return {
          skills: rankSkills(catalog.items, query)
            .slice(0, limit)
            .map((skill) => ({
              slug: skill.slug,
              title: skill.title,
              preview: skill.preview,
              available: skill.available,
              missingScopes: skill.missingScopes,
              source:
                skill.source.type === "resource"
                  ? { type: skill.source.type, key: skill.source.key, name: skill.source.name }
                  : { type: skill.source.type, name: "Weldall" },
              tags: skill.meta?.tags ?? [],
            })),
          warnings: catalog.warnings,
        };
      },
    }),
    getSkill: tool({
      description:
        "Load one complete Weldall skill after finding its slug with searchSkills. Follow the skill instructions, but use weldallRequest instead of running CLI commands.",
      inputSchema: skillInput,
      execute: async ({ slug }) => {
        const skill = await getVisibleSkill(principal.email, slug);
        if (!skill) throw new Error(`Skill ${JSON.stringify(slug)} is not available.`);

        await recordSkillRetrievalEvent({
          skillSlug: slug,
          retrieverId: principal.id,
          retrieverName: principal.name.trim() || principal.email,
        }).catch((error) => {
          logger.warn(
            {
              event: "chat.skill_retrieval.record.failed",
              skillSlug: slug,
              retrieverId: principal.id,
              error: errorForLog(error),
            },
            "Failed to record chat skill retrieval",
          );
        });

        const involvedResourceKeys = new Set(
          skill.involvedResources.map((resource) => resource.key),
        );
        const resources = (await resourceRegistryFor(principal.email))
          .filter((resource) => involvedResourceKeys.has(resource.key))
          .map((resource) => ({
            key: resource.key,
            name: resource.name,
            requestPrefixes: resource.requestPrefixes,
            grantedScopes: resource.grantedScopes,
          }));
        const document = skill.document.slice(0, MAX_SKILL_DOCUMENT_CHARS);
        return {
          slug: skill.slug,
          title: skill.title,
          available: skill.available,
          missingScopes: skill.missingScopes,
          requiredScopes: skill.requiredScopes,
          resources,
          document,
          truncated: document.length < skill.document.length,
        };
      },
    }),
    weldallRequest: tool({
      description:
        "Make an authenticated server-side GET or POST request documented by a loaded Weldall skill. Weldall validates the skill, URL, resource, and current user scopes.",
      inputSchema: requestInput,
      execute: async (request, options) => {
        const skill = await getVisibleSkill(principal.email, request.skillSlug);
        if (!skill?.available) {
          throw new Error("The selected skill is not currently available to this account.");
        }
        if (request.scopes.some((scope) => !skill.requiredScopes.includes(scope))) {
          throw new Error(
            "The request asks for a scope that is not declared by the selected skill.",
          );
        }
        const documentedTargets = documentedRequestTargets(skill.document);
        if (!documentedTargets.includes(normalizeRequestTarget(request.url).toString())) {
          throw new Error("The selected skill does not document this exact request URL.");
        }

        return delegatedResourceRequest(principal, {
          url: request.url,
          method: request.method,
          scopes: request.scopes,
          ...(request.json === undefined ? {} : { json: request.json }),
          ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
          toolCallId: options.toolCallId,
          requestIdentifiers,
          allowedResourceKeys: skill.involvedResources.map((resource) => resource.key),
          skillSlug: skill.slug,
        });
      },
    }),
  };
}

function documentedRequestTargets(document: string): string[] {
  const matches = document.match(/https:\/\/[^\s`"'<>]+/gu) ?? [];
  const targets: string[] = [];
  for (const match of matches) {
    try {
      targets.push(normalizeRequestTarget(match.replace(/[),.;]+$/u, "")).toString());
    } catch {
      // Ignore prose fragments that only resemble a safe request URL.
    }
  }
  return [...new Set(targets)];
}

function rankSkills(skills: VisibleSkill[], query: string): VisibleSkill[] {
  const terms = query
    .toLocaleLowerCase()
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter(Boolean);

  return skills
    .map((skill) => ({ skill, score: scoreSkill(skill, terms) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(right.skill.available) - Number(left.skill.available) ||
        left.skill.title.localeCompare(right.skill.title),
    )
    .map(({ skill }) => skill);
}

function scoreSkill(skill: VisibleSkill, terms: string[]): number {
  const title = skill.title.toLocaleLowerCase();
  const slug = skill.slug.toLocaleLowerCase();
  const source =
    skill.source.type === "resource"
      ? `${skill.source.key} ${skill.source.name}`.toLocaleLowerCase()
      : "weldall";
  const keywords = [
    skill.preview,
    ...(skill.meta?.tags ?? []),
    skill.meta?.owner ?? "",
    source,
    ...skill.requiredScopes,
  ]
    .join(" ")
    .toLocaleLowerCase();

  let score = 0;
  for (const term of terms) {
    if (slug === term || title === term) score += 20;
    else if (slug.includes(term)) score += 10;
    else if (title.includes(term)) score += 8;
    else if (keywords.includes(term)) score += 3;
  }
  return score;
}
