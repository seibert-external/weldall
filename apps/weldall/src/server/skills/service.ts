import { ADMIN_SCOPE_KEY, db } from "@weldall/db";
import { logger } from "../observability/logger";
import { effectiveScopesFor } from "../policy/resources";

export type SkillVisibility = "DEFAULT" | "HIDDEN_IF_UNALLOWED";
export type SkillSource = { type: "admin" } | { type: "resource"; key: string; name: string };
export interface SkillMeta {
  tags?: string[];
  owner?: string;
  appearance?: Record<string, string>;
}

export interface VisibleSkill {
  slug: string;
  title: string;
  preview: string;
  requiredScopes: string[];
  visibility: SkillVisibility;
  available: boolean;
  missingScopes: string[];
  updatedAt: string;
  meta?: SkillMeta;
  lastUpdatedAt?: string;
  source: SkillSource;
}

export interface VisibleSkillResource {
  key: string;
  name: string;
}

export interface VisibleSkillDetail extends VisibleSkill {
  content: string;
  document: string;
  involvedResources: VisibleSkillResource[];
}

export interface SkillWarning {
  source: string;
  code: "catalog_pending" | "catalog_temporarily_unavailable" | "catalog_expired";
}

export interface VisibleSkillsEnvelope {
  items: VisibleSkill[];
  warnings: SkillWarning[];
}

export class SkillTemporarilyUnavailableError extends Error {
  constructor() {
    super("Skill catalog is temporarily unavailable");
    this.name = "SkillTemporarilyUnavailableError";
  }
}

const sortedUnique = (values: string[]): string[] => [...new Set(values)].sort();

function createSkillPreview(content: string): string {
  const plainText = content
    .replace(/^---\s*\n[\s\S]*?\n---\s*/u, "")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+\.)\s+/gmu, "")
    .replace(/[*_~`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

  if (plainText.length <= 320) return plainText;
  return `${plainText.slice(0, 319).trimEnd()}…`;
}

export async function listVisibleSkills(email: string): Promise<VisibleSkillsEnvelope> {
  return listVisibleSkillsForScopes(await effectiveScopesFor(email));
}

export async function listVisibleSkillsForScopes(
  grants: readonly string[],
): Promise<VisibleSkillsEnvelope> {
  const now = new Date();
  const [manualSkills, resources, scopeRows] = await Promise.all([
    db.skill.findMany({
      select: {
        slug: true,
        title: true,
        content: true,
        requiredScopes: true,
        visibility: true,
        meta: true,
        lastUpdatedAt: true,
        updatedAt: true,
      },
    }),
    db.downstreamResource.findMany({
      where: { enabled: true, skillDiscoveryEnabled: true },
      select: {
        id: true,
        key: true,
        name: true,
        version: true,
        discoveredCatalog: {
          select: {
            lastSuccessfulRefreshAt: true,
            staleAfter: true,
            sourceResourceVersion: true,
            lastFailureCategory: true,
            skills: {
              select: {
                canonicalId: true,
                title: true,
                content: true,
                requiredScopes: true,
                visibility: true,
                meta: true,
                lastUpdatedAt: true,
                updatedAt: true,
              },
            },
          },
        },
      },
    }),
    db.scope.findMany({ select: { key: true } }),
  ]);
  const grantedScopes = new Set<string>(grants);
  const canViewCatalogIssues = grantedScopes.has(ADMIN_SCOPE_KEY);
  const scopes = new Set(scopeRows.map((scope) => scope.key));
  const warnings: SkillWarning[] = [];
  const discovered: VisibleSkill[] = [];

  for (const resource of resources) {
    const catalog = resource.discoveredCatalog;
    if (!catalog?.lastSuccessfulRefreshAt) {
      if (canViewCatalogIssues) {
        warnings.push({
          source: resource.key,
          code: catalog?.lastFailureCategory
            ? "catalog_temporarily_unavailable"
            : "catalog_pending",
        });
      }
      continue;
    }
    if (
      !catalog.staleAfter ||
      catalog.staleAfter <= now ||
      catalog.sourceResourceVersion !== resource.version
    ) {
      if (canViewCatalogIssues) {
        warnings.push({ source: resource.key, code: "catalog_expired" });
      }
      continue;
    }
    if (canViewCatalogIssues && catalog.lastFailureCategory) {
      warnings.push({
        source: resource.key,
        code: "catalog_temporarily_unavailable",
      });
    }
    for (const skill of catalog.skills) {
      const invalidScopes = ineligibleScopes(skill.requiredScopes, scopes);
      if (invalidScopes.length) {
        logger.warn(
          {
            event: "skill_catalog.skill.filtered",
            publisherId: resource.id,
            publisherKey: resource.key,
            scopeKeys: invalidScopes,
          },
          "Discovered skill filtered by scope registry",
        );
        continue;
      }
      const visible = skillVisibility(
        {
          slug: skill.canonicalId,
          title: skill.title,
          content: skill.content,
          requiredScopes: skill.requiredScopes,
          visibility: skill.visibility,
          meta: skill.meta,
          lastUpdatedAt: skill.lastUpdatedAt,
          updatedAt: skill.updatedAt,
          source: { type: "resource", key: resource.key, name: resource.name },
        },
        grantedScopes,
      );
      if (visible.visibility === "HIDDEN_IF_UNALLOWED" && !visible.available) continue;
      discovered.push(visible);
    }
  }

  const bySlug = new Map(discovered.map((skill) => [skill.slug, skill]));
  for (const skill of manualSkills) {
    const visible = skillVisibility(
      { ...skill, source: { type: "admin" } as const },
      grantedScopes,
    );
    if (visible.visibility === "HIDDEN_IF_UNALLOWED" && !visible.available) {
      bySlug.delete(skill.slug);
    } else {
      bySlug.set(skill.slug, visible);
    }
  }
  return {
    items: [...bySlug.values()].sort(
      (left, right) => left.title.localeCompare(right.title) || left.slug.localeCompare(right.slug),
    ),
    warnings,
  };
}

export async function getVisibleSkill(
  email: string,
  slug: string,
): Promise<VisibleSkillDetail | null> {
  const [manual, grants] = await Promise.all([
    db.skill.findUnique({ where: { slug } }),
    effectiveScopesFor(email),
  ]);
  const grantedScopes = new Set<string>(grants);
  const canViewCatalogIssues = grantedScopes.has(ADMIN_SCOPE_KEY);
  if (manual) {
    const metadata = skillVisibility(
      { ...manual, source: { type: "admin" } as const },
      grantedScopes,
    );
    if (metadata.visibility === "HIDDEN_IF_UNALLOWED" && !metadata.available) return null;
    return skillDetail(
      metadata,
      manual.content,
      await involvedResourcesForScopes(metadata.requiredScopes),
    );
  }

  const resourceKey = slug.split(".", 1)[0];
  if (!resourceKey) return null;
  const [resource, scopeRows] = await Promise.all([
    db.downstreamResource.findUnique({
      where: { key: resourceKey },
      include: {
        discoveredCatalog: {
          include: { skills: { where: { canonicalId: slug } } },
        },
      },
    }),
    db.scope.findMany({ select: { key: true } }),
  ]);
  if (!resource?.enabled || !resource.skillDiscoveryEnabled) return null;
  const catalog = resource.discoveredCatalog;
  const now = new Date();
  if (
    !catalog?.lastSuccessfulRefreshAt ||
    !catalog.staleAfter ||
    catalog.staleAfter <= now ||
    catalog.sourceResourceVersion !== resource.version
  ) {
    if (canViewCatalogIssues) throw new SkillTemporarilyUnavailableError();
    return null;
  }
  const skill = catalog.skills[0];
  if (!skill) return null;
  const scopes = new Set(scopeRows.map((scope) => scope.key));
  const invalidScopes = ineligibleScopes(skill.requiredScopes, scopes);
  if (invalidScopes.length) {
    logger.warn(
      {
        event: "skill_catalog.skill.filtered",
        publisherId: resource.id,
        publisherKey: resource.key,
        scopeKeys: invalidScopes,
      },
      "Discovered skill filtered by scope registry",
    );
    return null;
  }
  const metadata = skillVisibility(
    {
      slug: skill.canonicalId,
      title: skill.title,
      content: skill.content,
      requiredScopes: skill.requiredScopes,
      visibility: skill.visibility,
      meta: skill.meta,
      lastUpdatedAt: skill.lastUpdatedAt,
      updatedAt: skill.updatedAt,
      source: { type: "resource", key: resource.key, name: resource.name },
    },
    grantedScopes,
  );
  if (metadata.visibility === "HIDDEN_IF_UNALLOWED" && !metadata.available) return null;
  return skillDetail(
    metadata,
    skill.content,
    await involvedResourcesForScopes(metadata.requiredScopes),
  );
}

function ineligibleScopes(requiredScopes: string[], scopes: ReadonlySet<string>): string[] {
  return requiredScopes.filter((scope) => !scopes.has(scope));
}

function skillVisibility(
  skill: {
    slug: string;
    title: string;
    content: string;
    requiredScopes: string[];
    visibility: SkillVisibility;
    updatedAt: Date;
    meta: unknown;
    lastUpdatedAt: string | null;
    source: SkillSource;
  },
  grantedScopes: ReadonlySet<string>,
): VisibleSkill {
  const requiredScopes = sortedUnique(skill.requiredScopes);
  const missingScopes = requiredScopes.filter((scope) => !grantedScopes.has(scope));
  const meta = parseSkillMeta(skill.meta);
  return {
    slug: skill.slug,
    title: skill.title,
    preview: createSkillPreview(skill.content),
    requiredScopes,
    visibility: skill.visibility,
    available: missingScopes.length === 0,
    missingScopes,
    updatedAt: skill.updatedAt.toISOString(),
    ...(meta ? { meta } : {}),
    ...(skill.lastUpdatedAt !== null ? { lastUpdatedAt: skill.lastUpdatedAt } : {}),
    source: skill.source,
  };
}

function parseSkillMeta(value: unknown): SkillMeta | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.tags !== undefined &&
      (!Array.isArray(candidate.tags) ||
        !candidate.tags.every((tag) => typeof tag === "string"))) ||
    (candidate.owner !== undefined && typeof candidate.owner !== "string") ||
    (candidate.appearance !== undefined &&
      (!candidate.appearance ||
        typeof candidate.appearance !== "object" ||
        Array.isArray(candidate.appearance) ||
        !Object.values(candidate.appearance).every((entry) => typeof entry === "string")))
  )
    return undefined;
  return {
    ...(candidate.tags !== undefined ? { tags: candidate.tags as string[] } : {}),
    ...(candidate.owner !== undefined ? { owner: candidate.owner } : {}),
    ...(candidate.appearance !== undefined
      ? { appearance: candidate.appearance as Record<string, string> }
      : {}),
  };
}

async function involvedResourcesForScopes(
  requiredScopes: string[],
): Promise<VisibleSkillResource[]> {
  if (requiredScopes.length === 0) return [];
  return db.downstreamResource.findMany({
    where: {
      scopes: { some: { scope: { key: { in: requiredScopes } } } },
    },
    select: { key: true, name: true },
    orderBy: [{ name: "asc" }, { key: "asc" }],
  });
}

function skillDetail(
  metadata: VisibleSkill,
  content: string,
  involvedResources: VisibleSkillResource[],
): VisibleSkillDetail {
  return {
    ...metadata,
    content,
    involvedResources,
    document: renderSkillDocument({
      title: metadata.title,
      requiredScopes: metadata.requiredScopes,
      visibility: metadata.visibility,
      content,
      ...(metadata.meta ? { meta: metadata.meta } : {}),
      ...(metadata.lastUpdatedAt !== undefined ? { lastUpdatedAt: metadata.lastUpdatedAt } : {}),
    }),
  };
}

export function renderSkillDocument(input: {
  title: string;
  requiredScopes: string[];
  visibility: SkillVisibility;
  content: string;
  meta?: SkillMeta;
  lastUpdatedAt?: string;
}): string {
  const scopeLines = input.requiredScopes.length
    ? ["requiredScopes:", ...input.requiredScopes.map((scope) => `  - ${JSON.stringify(scope)}`)]
    : ["requiredScopes: []"];
  const metaValues = input.meta
    ? [
        ...(input.meta.tags !== undefined
          ? input.meta.tags.length
            ? ["  tags:", ...input.meta.tags.map((tag) => `    - ${JSON.stringify(tag)}`)]
            : ["  tags: []"]
          : []),
        ...(input.meta.owner !== undefined ? [`  owner: ${JSON.stringify(input.meta.owner)}`] : []),
        ...(input.meta.appearance !== undefined
          ? Object.keys(input.meta.appearance).length
            ? [
                "  appearance:",
                ...Object.entries(input.meta.appearance)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([key, value]) => `    ${yamlMappingKey(key)}: ${JSON.stringify(value)}`),
              ]
            : ["  appearance: {}"]
          : []),
      ]
    : [];
  const metaLines = input.meta ? (metaValues.length ? ["meta:", ...metaValues] : ["meta: {}"]) : [];
  return [
    "---",
    `title: ${JSON.stringify(input.title)}`,
    ...scopeLines,
    `visibility: ${input.visibility}`,
    ...metaLines,
    ...(input.lastUpdatedAt !== undefined
      ? [`lastUpdatedAt: ${JSON.stringify(input.lastUpdatedAt)}`]
      : []),
    "---",
    "",
    input.content.trim(),
    "",
  ].join("\n");
}

function yamlMappingKey(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(value) ? value : JSON.stringify(value);
}
