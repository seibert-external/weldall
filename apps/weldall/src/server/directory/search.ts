import { db } from "@weldall/db";
import type { SearchablePrimitiveDto } from "@/lib/searchable-primitives";
import { effectiveScopesFor } from "../policy/resources";
import { listVisibleSkillsForScopes } from "../skills/service";

export interface DirectoryResource {
  key: string;
  name: string;
  resourceIdentifier: string;
}

export interface DirectoryScope {
  key: string;
  description: string;
}

export function listDirectoryResources(): Promise<DirectoryResource[]> {
  return db.downstreamResource.findMany({
    where: { enabled: true },
    orderBy: [{ name: "asc" }, { key: "asc" }],
    select: {
      key: true,
      name: true,
      resourceIdentifier: true,
    },
  });
}

export async function listDirectoryScopes(email: string): Promise<DirectoryScope[]> {
  return listDirectoryScopesForKeys(await effectiveScopesFor(email));
}

export async function listSearchablePrimitives(email: string): Promise<SearchablePrimitiveDto[]> {
  const grantedScopes = await effectiveScopesFor(email);
  const [{ items: skills }, resources, scopes] = await Promise.all([
    listVisibleSkillsForScopes(grantedScopes),
    listDirectoryResources(),
    listDirectoryScopesForKeys(grantedScopes),
  ]);

  return [
    ...skills.map((skill): SearchablePrimitiveDto => ({
      type: "skill",
      id: skill.slug,
      label: skill.title,
      ...(skill.preview ? { description: skill.preview } : {}),
      keywords: [
        skill.source.type === "resource" ? skill.source.name : "Weldall",
        ...(skill.meta?.tags ?? []),
        ...(skill.meta?.owner ? [skill.meta.owner] : []),
        ...skill.requiredScopes,
      ],
      available: skill.available,
    })),
    ...resources.map((resource): SearchablePrimitiveDto => ({
      type: "resource",
      id: resource.key,
      label: resource.name,
      description: resource.resourceIdentifier,
    })),
    ...scopes.map((scope): SearchablePrimitiveDto => ({
      type: "scope",
      id: scope.key,
      label: scope.key,
      ...(scope.description ? { description: scope.description } : {}),
    })),
  ];
}

function listDirectoryScopesForKeys(scopeKeys: readonly string[]): Promise<DirectoryScope[]> {
  if (scopeKeys.length === 0) return Promise.resolve([]);
  return db.scope.findMany({
    where: { key: { in: [...scopeKeys] } },
    orderBy: { key: "asc" },
    select: { key: true, description: true },
  });
}
