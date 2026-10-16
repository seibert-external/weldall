import { z } from "zod";

/** Provider capabilities describe transports, not permissions or available upstream tools. */
export const connectorCapabilitiesSchema = z
  .array(z.enum(["http", "mcp"]))
  .max(2)
  .refine((values) => new Set(values).size === values.length, "Duplicate connector capability");
export type ConnectorCapability = z.infer<typeof connectorCapabilitiesSchema>[number];
