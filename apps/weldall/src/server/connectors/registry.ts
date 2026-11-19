import { ConnectorError } from "./errors";
import { googleProvider } from "./providers/google";
import { atlassianProvider } from "./providers/atlassian";
import { atlassianMcpProvider } from "./providers/atlassian-mcp";
import type { ConnectorProvider } from "./provider";

export const connectorProviders: readonly ConnectorProvider[] = [
  googleProvider,
  atlassianProvider,
  atlassianMcpProvider,
];

/** Unknown persisted or caller-provided discriminators never fall back to another provider. */
export function getConnectorProvider(type: string): ConnectorProvider {
  const provider = connectorProviders.find((provider) => provider.type === type);
  if (!provider) throw new ConnectorError("unsupported_provider", "Unsupported provider.");
  return provider;
}
