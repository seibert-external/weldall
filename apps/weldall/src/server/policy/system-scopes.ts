export function isProtectedSystemScope(
  scope: { key: string; isSystem: boolean } | null | undefined,
  expectedKey: string,
): boolean {
  return scope?.key === expectedKey && scope.isSystem;
}
