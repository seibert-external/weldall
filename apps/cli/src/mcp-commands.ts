import { define } from "gunshi";
import { resolveWeldallConfig } from "./config.js";
import { CliError } from "./errors.js";
import { terminalText } from "./output.js";
import { requestMcp, type McpOperation } from "./services/mcp.js";

const json = { type: "boolean", description: "Print complete validated protocol JSON" } as const;
const selection = {
  connector: { type: "positional", required: true, description: "Configured MCP connector key" },
  connection: { type: "string", required: true, description: "Your connection name or ID" },
  json,
} as const;

async function execute(
  operation: McpOperation,
  input: Parameters<typeof requestMcp>[2],
  asJson: boolean | undefined,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const value = await requestMcp(
      await resolveWeldallConfig(),
      operation,
      input,
      controller.signal,
    );
    if (asJson) {
      console.log(JSON.stringify(value, null, 2));
      return;
    }
    if (Array.isArray(value))
      for (const connector of value)
        console.log(terminalText(`${connector.key}\t${connector.name}`));
    else if ("tools" in value)
      for (const tool of value.tools)
        console.log(terminalText(`${tool.name}\t${tool.title ?? tool.description ?? ""}`));
    else if ("resources" in value)
      for (const resource of value.resources)
        console.log(terminalText(`${resource.uri}\t${resource.name}`));
    else console.log(terminalText(JSON.stringify(value, null, 2)));
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
const list = define({
  name: "list",
  description: "List accessible configured MCP connectors",
  args: { json },
  run: (context) => execute("list", {}, context.values.json),
});
const tools = define({
  name: "tools",
  description: "Discover all live tools for a selected connection",
  args: selection,
  run: (context) =>
    execute(
      "tools",
      { connectorKey: context.values.connector, connection: context.values.connection },
      context.values.json,
    ),
});
const resources = define({
  name: "resources",
  description: "Discover standard MCP resources",
  args: selection,
  run: (context) =>
    execute(
      "resources",
      { connectorKey: context.values.connector, connection: context.values.connection },
      context.values.json,
    ),
});
const call = define({
  name: "call",
  description: "Invoke one upstream tool exactly once; never automatically retries",
  args: {
    ...selection,
    tool: { type: "positional", required: true },
    arguments: { type: "string", default: "{}", description: "JSON object of tool arguments" },
  },
  run: (context) => {
    let args: unknown;
    try {
      args = JSON.parse(context.values.arguments);
    } catch {
      throw new CliError("--arguments must be a JSON object");
    }
    return execute(
      "call",
      {
        connectorKey: context.values.connector,
        connection: context.values.connection,
        name: context.values.tool,
        arguments: args,
      },
      context.values.json,
    );
  },
});
const readResource = define({
  name: "read-resource",
  description: "Read bounded text/blob resource content without saving files",
  args: { ...selection, uri: { type: "string", required: true } },
  run: (context) =>
    execute(
      "read-resource",
      {
        connectorKey: context.values.connector,
        connection: context.values.connection,
        uri: context.values.uri,
      },
      context.values.json,
    ),
});
export const mcpCommand = define({
  name: "mcp",
  description: "Discover and invoke governed remote MCP tools and resources",
  subCommands: { list, tools, resources, call, "read-resource": readResource },
  run: () => {
    console.log("Use weldall mcp list, tools, resources, call or read-resource.");
  },
});
