import { define } from "gunshi";
import { resolveWeldallConfig } from "./config.js";
import { CliError } from "./errors.js";
import { terminalDocument } from "./output.js";
import { requestNativeMcp } from "./services/native-mcp.js";

const selection = {
  resource: {
    type: "positional",
    required: true,
    description: "Registered native resource key, not a URL",
  },
  json: { type: "boolean", description: "Print validated protocol JSON" },
  "expected-subject": { type: "string", description: "Session identity guard" },
  "expected-issuer": { type: "string", description: "Session Weldall origin guard" },
  "expected-revision": { type: "string", description: "Session catalog revision guard" },
  "expected-resource-identifier": {
    type: "string",
    description: "Session resource audience guard",
  },
} as const;
const guards = (values: Record<string, unknown>) => ({
  ...(typeof values["expected-subject"] === "string"
    ? { expectedSubject: values["expected-subject"] }
    : {}),
  ...(typeof values["expected-issuer"] === "string"
    ? { expectedIssuer: values["expected-issuer"] }
    : {}),
  ...(typeof values["expected-revision"] === "string"
    ? { expectedRevision: values["expected-revision"] }
    : {}),
  ...(typeof values["expected-resource-identifier"] === "string"
    ? { expectedResourceIdentifier: values["expected-resource-identifier"] }
    : {}),
});
async function execute(
  operation: Parameters<typeof requestNativeMcp>[1],
  input: Parameters<typeof requestNativeMcp>[2],
  json: boolean | undefined,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const value = await requestNativeMcp(
      await resolveWeldallConfig(),
      operation,
      input,
      controller.signal,
    );
    const output = JSON.stringify(value, null, 2);
    console.log(json ? output : terminalDocument(output));
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
export const nativeMcpCommand = define({
  name: "native",
  description: "Use SDK-native tools via registered resource authentication",
  subCommands: {
    tools: define({
      name: "tools",
      description: "List the complete native tool catalog",
      args: selection,
      run: (c) =>
        execute("tools", { resourceKey: c.values.resource, ...guards(c.values) }, c.values.json),
    }),
    resources: define({
      name: "resources",
      description: "List native MCP resources",
      args: selection,
      run: (c) =>
        execute(
          "resources",
          { resourceKey: c.values.resource, ...guards(c.values) },
          c.values.json,
        ),
    }),
    call: define({
      name: "call",
      description: "Call one native tool without automatic retry",
      args: {
        ...selection,
        tool: { type: "positional", required: true },
        arguments: { type: "string", default: "{}", description: "JSON object of tool arguments" },
      },
      run: (c) => {
        let args: unknown;
        try {
          args = JSON.parse(c.values.arguments);
        } catch {
          throw new CliError("--arguments must be a JSON object");
        }
        return execute(
          "call",
          {
            resourceKey: c.values.resource,
            name: c.values.tool,
            arguments: args,
            ...guards(c.values),
          },
          c.values.json,
        );
      },
    }),
    "read-resource": define({
      name: "read-resource",
      description: "Read protected native resource content",
      args: { ...selection, uri: { type: "string", required: true } },
      run: (c) =>
        execute(
          "read-resource",
          { resourceKey: c.values.resource, uri: c.values.uri, ...guards(c.values) },
          c.values.json,
        ),
    }),
  },
});
