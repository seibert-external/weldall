const scopeToken = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

export function parseScope(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const scopes = value.split(" ");
  if (scopes.some((scope) => !scopeToken.test(scope)) || new Set(scopes).size !== scopes.length)
    return undefined;
  return scopes;
}
