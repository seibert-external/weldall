import dynamicIconImports from "lucide-react/dynamicIconImports";
import type { IconNode } from "lucide-react";

export type LucideIconName = keyof typeof dynamicIconImports;

const lucideIconNameSet = new Set<string>(Object.keys(dynamicIconImports));

export const lucideIconNames = [...lucideIconNameSet].sort();

export function isLucideIconName(value: string): value is LucideIconName {
  return lucideIconNameSet.has(value);
}

export async function resolveLucideIconNode(
  value: string | undefined,
): Promise<IconNode | undefined> {
  if (!value || !isLucideIconName(value)) return undefined;
  return (await dynamicIconImports[value]()).__iconNode;
}
