import { ConnectorError } from "./errors";
import { googleProvider } from "./providers/google";
import type { ConnectorProvider } from "./provider";

/** Unknown persisted or caller-provided discriminators never fall back to another provider. */
export function getConnectorProvider(type: string): ConnectorProvider {
  if (type === "google") return googleProvider;
  throw new ConnectorError("unsupported_provider", "Unsupported provider.");
}
