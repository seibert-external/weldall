import dynamicIconImports from "lucide-react/dynamicIconImports";
import type { IconNode } from "lucide-react";
import lucideTags from "lucide-static/tags.json";

export type LucideIconName = keyof typeof dynamicIconImports;

const lucideIconNameSet = new Set<string>(Object.keys(dynamicIconImports));

export const lucideIconNames = [...lucideIconNameSet].sort();

/**
 * Search keywords per icon name from lucide-static, which must stay on the same version as
 * lucide-react. Aliases without their own tags are left out.
 */
export const lucideIconTags: Record<string, string> = Object.fromEntries(
  Object.entries(lucideTags as Record<string, string[]>)
    .filter(([name]) => lucideIconNameSet.has(name))
    .map(([name, tags]) => [name, tags.join(" ")]),
);

export function isLucideIconName(value: string): value is LucideIconName {
  return lucideIconNameSet.has(value);
}

export async function resolveLucideIconNode(
  value: string | undefined,
): Promise<IconNode | undefined> {
  if (!value || !isLucideIconName(value)) return undefined;
  return (await dynamicIconImports[value]()).__iconNode;
}
