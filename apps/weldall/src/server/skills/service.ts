import { db } from "@weldall/db";
import { effectiveScopesFor } from "../policy/resources";

export type SkillVisibility = "DEFAULT" | "HIDDEN_IF_UNALLOWED";
export type SkillSource = { type: "admin" } | { type: "resource"; key: string; name: string };

export interface VisibleSkill {
  slug: string;
  title: string;
  requiredScopes: string[];
  visibility: SkillVisibility;
  available: boolean;
  missingScopes: string[];
  updatedAt: string;
  source: SkillSource;
}

export interface VisibleSkillDetail extends VisibleSkill {
  content: string;
  document: string;
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

export async function listVisibleSkills(email: string): Promise<VisibleSkillsEnvelope> {
  const now = new Date();
  const [manualSkills, resources, scopeRows, grants] = await Promise.all([
    db.skill.findMany(),
    db.downstreamResource.findMany({
      where: { enabled: true, skillDiscoveryEnabled: true },
      include: { discoveredCatalog: { include: { skills: true } } },
    }),
    db.scope.findMany({ select: { key: true, isSystem: true } }),
    effectiveScopesFor(email),
  ]);
  const grantedScopes = new Set<string>(grants);
  const scopes = new Map(scopeRows.map((scope) => [scope.key, scope.isSystem]));
  const warnings: SkillWarning[] = [];
  const discovered: VisibleSkill[] = [];

  for (const resource of resources) {
    const catalog = resource.discoveredCatalog;
    if (!catalog?.lastSuccessfulRefreshAt) {
      warnings.push({
        source: resource.key,
        code: catalog?.lastFailureCategory ? "catalog_temporarily_unavailable" : "catalog_pending",
      });
      continue;
    }
    if (
      !catalog.staleAfter ||
      catalog.staleAfter <= now ||
      catalog.sourceResourceVersion !== resource.version
    ) {
      warnings.push({ source: resource.key, code: "catalog_expired" });
      continue;
    }
    if (catalog.lastFailureCategory) {
      warnings.push({
        source: resource.key,
        code: "catalog_temporarily_unavailable",
      });
    }
    for (const skill of catalog.skills) {
      const invalidScopes = ineligibleScopes(skill.requiredScopes, scopes);
      if (invalidScopes.length) {
        console.warn("Discovered skill filtered by scope registry", {
          publisherId: resource.id,
          publisherKey: resource.key,
          scopeKeys: invalidScopes,
        });
        continue;
      }
      const visible = skillVisibility(
        {
          slug: skill.canonicalId,
          title: skill.title,
          requiredScopes: skill.requiredScopes,
          visibility: skill.visibility,
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
  if (manual) {
    const metadata = skillVisibility(
      { ...manual, source: { type: "admin" } as const },
      grantedScopes,
    );
    if (metadata.visibility === "HIDDEN_IF_UNALLOWED" && !metadata.available) return null;
    return skillDetail(metadata, manual.content);
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
    db.scope.findMany({ select: { key: true, isSystem: true } }),
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
    throw new SkillTemporarilyUnavailableError();
  }
  const skill = catalog.skills[0];
  if (!skill) return null;
  const scopes = new Map(scopeRows.map((scope) => [scope.key, scope.isSystem]));
  const invalidScopes = ineligibleScopes(skill.requiredScopes, scopes);
  if (invalidScopes.length) {
    console.warn("Discovered skill filtered by scope registry", {
      publisherId: resource.id,
      publisherKey: resource.key,
      scopeKeys: invalidScopes,
    });
    return null;
  }
  const metadata = skillVisibility(
    {
      slug: skill.canonicalId,
      title: skill.title,
      requiredScopes: skill.requiredScopes,
      visibility: skill.visibility,
      updatedAt: skill.updatedAt,
      source: { type: "resource", key: resource.key, name: resource.name },
    },
    grantedScopes,
  );
  if (metadata.visibility === "HIDDEN_IF_UNALLOWED" && !metadata.available) return null;
  return skillDetail(metadata, skill.content);
}

function ineligibleScopes(
  requiredScopes: string[],
  scopes: ReadonlyMap<string, boolean>,
): string[] {
  return requiredScopes.filter((scope) => !scopes.has(scope) || scopes.get(scope) === true);
}

function skillVisibility(
  skill: {
    slug: string;
    title: string;
    requiredScopes: string[];
    visibility: SkillVisibility;
    updatedAt: Date;
    source: SkillSource;
  },
  grantedScopes: ReadonlySet<string>,
): VisibleSkill {
  const requiredScopes = sortedUnique(skill.requiredScopes);
  const missingScopes = requiredScopes.filter((scope) => !grantedScopes.has(scope));
  return {
    slug: skill.slug,
    title: skill.title,
    requiredScopes,
    visibility: skill.visibility,
    available: missingScopes.length === 0,
    missingScopes,
    updatedAt: skill.updatedAt.toISOString(),
    source: skill.source,
  };
}

function skillDetail(metadata: VisibleSkill, content: string): VisibleSkillDetail {
  return {
    ...metadata,
    content,
    document: renderSkillDocument({
      title: metadata.title,
      requiredScopes: metadata.requiredScopes,
      visibility: metadata.visibility,
      content,
    }),
  };
}

export function renderSkillDocument(input: {
  title: string;
  requiredScopes: string[];
  visibility: SkillVisibility;
  content: string;
}): string {
  const scopeLines = input.requiredScopes.length
    ? ["requiredScopes:", ...input.requiredScopes.map((scope) => `  - ${JSON.stringify(scope)}`)]
    : ["requiredScopes: []"];
  return [
    "---",
    `title: ${JSON.stringify(input.title)}`,
    ...scopeLines,
    `visibility: ${input.visibility}`,
    "---",
    "",
    input.content.trim(),
    "",
  ].join("\n");
}
