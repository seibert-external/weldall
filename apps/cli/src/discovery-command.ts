import { define } from "gunshi";
import { resolveWeldallConfig } from "./config.js";
import { terminalDocument } from "./output.js";
import { discoverNativeResources } from "./services/discovery.js";

export const discoveryCommand = define({
  name: "discover",
  description: "Resolve authorized resources, connector types and skills for session activation",
  args: {
    resource: {
      type: "string",
      multiple: true,
      description: "Registered resource key; repeat for more than one",
    },
    "connector-type": {
      type: "string",
      multiple: true,
      description: "Provider family; resolve one authorized account context",
    },
    skill: {
      type: "string",
      multiple: true,
      description: "Skill ID; expand its declared dependencies",
    },
    query: {
      type: "string",
      description: "Search authorized descriptions; do not combine with explicit selectors",
    },
    cursor: { type: "string", description: "Continue the returned search cursor" },
    bindings: { type: "string", description: "Session-local routing bindings as JSON" },
    selection: { type: "string", description: "Explicit account continuation as JSON" },
    dependencies: { type: "string", description: "Skill dependency selections as JSON" },
    "expected-issuer": { type: "string", description: "Require the activation session issuer" },
    "expected-subject": { type: "string", description: "Require the activation session subject" },
    "catalog-only": {
      type: "boolean",
      description: "Descriptions only; no schemas, token exchange or activation",
    },
    json: { type: "boolean", description: "Print the versioned discovery response" },
  },
  run: async (context) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const value = await discoverNativeResources(
        await resolveWeldallConfig(),
        {
          resources: context.values.resource ?? [],
          connectorTypes: context.values["connector-type"] ?? [],
          skills: context.values.skill ?? [],
          query: context.values.query,
          cursor: context.values.cursor,
          ...(context.values.bindings ? { bindings: JSON.parse(context.values.bindings) } : {}),
          ...(context.values.selection ? { selection: JSON.parse(context.values.selection) } : {}),
          ...(context.values.dependencies
            ? { dependencies: JSON.parse(context.values.dependencies) }
            : {}),
          expectedIssuer: context.values["expected-issuer"],
          expectedSubject: context.values["expected-subject"],
          catalogOnly: context.values["catalog-only"] ?? false,
        },
        controller.signal,
      );
      const output = JSON.stringify(value, null, 2);
      console.log(context.values.json ? output : terminalDocument(output));
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  },
});
