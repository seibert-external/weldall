import { ManagementApiV1Adapter } from "./management-api-v1";
import type {
  GroupProviderAdapter,
  GroupProviderAdapterConfig,
  GroupProviderAdapterType,
} from "./types";

export const GROUP_PROVIDER_ADAPTER_TYPES = [
  "management-api-v1",
] as const satisfies readonly GroupProviderAdapterType[];

/**
 * Extension contract: add a stable adapter type to GROUP_PROVIDER_ADAPTER_TYPES and an
 * exhaustive factory branch here. Adapter implementations must return only generic DTOs;
 * assignment and policy code must never import an adapter implementation directly.
 */
export function createGroupProviderAdapter(
  config: GroupProviderAdapterConfig,
): GroupProviderAdapter {
  switch (config.adapterType) {
    case "management-api-v1":
      return new ManagementApiV1Adapter(config);
  }
}
