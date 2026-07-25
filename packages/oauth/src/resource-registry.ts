export type ResourceRegistryEntry = {
  key: string;
  name: string;
  resourceIdentifier: string;
  authorizationServer: string;
  downstreamClientId: string;
  requestPrefixes: string[];
  supportedScopes: string[];
  grantedScopes: string[];
};

const parseHttpsUrl = (value: string, label: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError(`${label} must be an absolute HTTPS URL`, { cause: error });
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new TypeError(`${label} must be HTTPS and must not contain credentials`);
  }
  return url;
};

export const normalizeResourceIdentifier = (value: string): string => {
  const url = parseHttpsUrl(value.trim(), "Resource identifier");
  if (url.hash) throw new TypeError("Resource identifier must not contain a fragment");
  return url.toString();
};

export const normalizeAuthorizationServer = (value: string): string => {
  const url = parseHttpsUrl(value.trim(), "Authorization server");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError(
      "Authorization server must be an HTTPS origin without path, query, or fragment",
    );
  }
  return url.origin;
};

export const normalizeRequestPrefix = (value: string): string => {
  const url = parseHttpsUrl(value.trim(), "Request prefix");
  if (url.search || url.hash) {
    throw new TypeError("Request prefix must not contain a query or fragment");
  }
  if (url.pathname.includes("%")) {
    throw new TypeError("Request prefix paths must not contain percent encoding");
  }
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  }
  return url.toString();
};

export const normalizeRequestTarget = (value: string): URL => {
  const url = parseHttpsUrl(value, "Request URL");
  if (url.hash) throw new TypeError("Request URL must not contain a fragment");
  return url;
};

export const requestPrefixAccepts = (prefixValue: string, targetValue: string | URL): boolean => {
  const prefix = new URL(normalizeRequestPrefix(prefixValue));
  const target =
    typeof targetValue === "string" ? normalizeRequestTarget(targetValue) : targetValue;
  if (prefix.origin !== target.origin) return false;
  return (
    prefix.pathname === "/" ||
    target.pathname === prefix.pathname ||
    target.pathname.startsWith(`${prefix.pathname}/`)
  );
};

export const requestPrefixesOverlap = (leftValue: string, rightValue: string): boolean => {
  const left = normalizeRequestPrefix(leftValue);
  const right = normalizeRequestPrefix(rightValue);
  return requestPrefixAccepts(left, new URL(right)) || requestPrefixAccepts(right, new URL(left));
};

export const resolveResourceForTarget = <T extends Pick<ResourceRegistryEntry, "requestPrefixes">>(
  resources: T[],
  target: URL,
): T[] =>
  resources.filter((resource) =>
    resource.requestPrefixes.some((prefix) => requestPrefixAccepts(prefix, target)),
  );
