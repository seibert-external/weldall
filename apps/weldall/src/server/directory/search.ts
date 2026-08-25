import { db } from "@weldall/db";
import type { SearchablePrimitiveDto } from "@/lib/searchable-primitives";
import { effectiveScopesFor } from "../policy/resources";
import { listVisibleSkillsForScopes } from "../skills/service";

export async function listSearchablePrimitives(email: string): Promise<SearchablePrimitiveDto[]> {
  const grantedScopes = await effectiveScopesFor(email);
  const [{ items: skills }, resources, scopes] = await Promise.all([
    listVisibleSkillsForScopes(grantedScopes),
    db.downstreamResource.findMany({
      where: { enabled: true },
      orderBy: [{ name: "asc" }, { key: "asc" }],
      select: {
        key: true,
        name: true,
        resourceIdentifier: true,
      },
    }),
    grantedScopes.length
      ? db.scope.findMany({
          where: { key: { in: grantedScopes } },
          orderBy: { key: "asc" },
          select: { key: true, description: true },
        })
      : Promise.resolve([]),
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
