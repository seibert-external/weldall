export function sortScopeKeys(scopes: readonly string[]): string[] {
  return [...scopes].sort((a, b) => a.localeCompare(b));
}
