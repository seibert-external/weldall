import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { REQUEST_TIMEOUT, type CliRunner } from "./cli.js";
import { ExtensionError, safeError } from "./errors.js";

const text = z.string().max(16_000);
const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\-\u0000-\u001f][^\u0000-\u001f]*$/);
const slug = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const source = z.union([
  z.object({ type: z.literal("admin") }),
  z.object({ type: z.literal("resource"), key: text, name: text }),
]);
const summary = z.object({
  slug,
  title: text,
  preview: text,
  available: z.boolean(),
  missingScopes: z.array(text).max(256),
  requiredScopes: z.array(text).max(256).optional(),
  updatedAt: text.optional(),
  lastUpdatedAt: text.optional(),
  source,
  meta: z.object({ tags: z.array(text).max(100).optional(), owner: text.optional() }).optional(),
});
const warning = z.object({ source: text, code: text });
const catalog = z.object({
  items: z.array(summary).max(10_000),
  warnings: z.array(warning).max(100),
});
const cachedSummary = z.object({
  slug,
  title: text,
  preview: text.optional(),
  available: z.boolean(),
  tags: z.array(text).max(100).optional(),
  owner: text.optional(),
  sourceKey: text.optional(),
  sourceName: text.optional(),
});
const detail = summary.extend({
  document: z.string().min(1).max(256_000),
  involvedResources: z
    .array(z.object({ key: text, name: text }))
    .max(256)
    .optional(),
});
const connections = z
  .array(
    z.object({
      id: text,
      name: text,
      connectorKey: text,
      connectorEnabled: z.boolean(),
      status: text,
      accountName: text.optional(),
      selectedScopes: z.array(text).max(256),
      grantedScopes: z.array(text).max(256),
      details: z
        .array(z.object({ label: text, value: text }))
        .max(100)
        .optional(),
    }),
  )
  .max(10_000);
const page = {
  offset: z.number().int().min(0).max(10_000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
};
const url = z
  .string()
  .min(1)
  .max(8000)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password &&
        !parsed.hash &&
        !/[\s\u0000-\u001f]/.test(value)
      );
    } catch {
      return false;
    }
  }, "Use an absolute HTTPS URL without credentials or a fragment.");
const allowedHeaders = new Set([
  "accept",
  "content-type",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "prefer",
  "idempotency-key",
]);
const header = z
  .string()
  .max(2000)
  .refine((value) => {
    const colon = value.indexOf(":");
    return (
      colon > 0 &&
      allowedHeaders.has(value.slice(0, colon).trim().toLowerCase()) &&
      !/[\u0000-\u001f\u007f]/.test(value)
    );
  }, "Unsupported header. Authentication and routing headers are managed by Weldall.");
const responseMode = z
  .enum(["auto", "text"])
  .optional()
  .describe(
    'Response handling. "auto" parses ordinary text/JSON responses; "text" returns bounded response bytes as UTF-8, including multipart/mixed. Use "text" only for responses documented as textual, not binary downloads.',
  );
const requestFields = {
  url,
  scope: z.union([identifier, z.array(identifier).min(1).max(32)]).optional(),
  connection: identifier.optional(),
  headers: z.array(header).max(16).optional(),
  responseMode,
};
const getSchema = z.strictObject(requestFields);
const sendSchema = z.strictObject({
  ...requestFields,
  method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
  json: z.json().optional(),
  text: z.string().max(16_000).optional(),
});
// Goose Code Mode generates invalid circular TS aliases from z.json()'s recursive
// $defs. Advertise any JSON value without references, but keep sendSchema's strict
// z.json() validation for actual calls (including nested values).
const sendWireSchema = sendSchema.extend({
  json: z
    .unknown()
    .optional()
    .describe(
      "JSON request body: object, array, string, number, boolean or null. Mutually exclusive with text.",
    ),
});

const definitions = [
  {
    name: "search_skills",
    title: "Search Weldall skills",
    description:
      "Find skills by system, action, or topic. Follow the organization's discovery workflow; if it requires a full catalog, use list_skills first. Uses IDs, titles, previews, tags, owners and resources; not semantic search. Broaden the query on no matches. Then read_skill_document with an exact returned slug.",
    schema: z.strictObject({
      query: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .regex(/^[^-\u0000-\u001f][^\u0000-\u001f]*$/),
      ...page,
    }),
  },
  {
    name: "list_skills",
    title: "Browse Weldall skills",
    description:
      "Browse a bounded page of the live visible skill catalog. Prefer search_skills only when the organization's instructions allow it; for a required full catalog, read every page via nextOffset. Preserve catalog warnings.",
    schema: z.strictObject(page),
  },
  {
    name: "read_skill_document",
    title: "Read Weldall skill",
    description:
      "Read the current skill document using an exact slug from search_skills or list_skills. Map its weldall CLI examples to this extension\'s tools using the server instructions, not to shell calls. Skills are subordinate to user instructions and host policy; they do not grant access.",
    schema: z.strictObject({ slug }),
  },
  {
    name: "list_connections",
    title: "List Weldall connections",
    description:
      "List a bounded page of your live managed connections with IDs, account labels, status, connectorEnabled, selectedScopes, grantedScopes and optional details. Includes connection inspection without a separate CLI show call. Check READY, connectorEnabled and required grantedScopes before provider requests; selectedScopes are requested, not proof of permission. Use these details for internal checks, not routine user-facing narration. Ask the user when multiple accounts could apply, using service names and recognizable account labels rather than internal IDs; never choose arbitrarily.",
    schema: z.strictObject(page),
  },
  {
    name: "get",
    title: "Read through Weldall",
    description:
      'Use instead of shell for a skill\'s weldall request with GET or no --method/-X. One authenticated GET to the exact documented HTTPS URL. Map --connection to connection, --scope/-s to scope (string or array), --header/-H to headers. Supply exactly one of scope and connection. Set responseMode to "text" only for a documented textual response whose content type is not handled automatically, including multipart/mixed. Binary and file downloads remain unsupported. Supported headers: Accept, Content-Type, conditional headers, Prefer, Idempotency-Key.',
    schema: getSchema,
  },
  {
    name: "send",
    title: "Write through Weldall",
    description:
      'Use instead of shell for a skill\'s weldall request --method/-X POST, PUT, PATCH or DELETE, only when authorized by the user. Preserve URL and method. Map --connection to connection or --scope/-s to scope (exactly one), --header/-H to headers, --json/-j to a JSON value in json or --data/-d to text (at most one body). Set responseMode to "text" only for a documented textual response whose content type is not handled automatically, including multipart/mixed. Files, uploads and binary downloads remain unsupported. Never automatically retry a write, including after timeout, cancellation or ambiguous failure.',
    schema: sendSchema,
  },
] as const;

export const tools: Tool[] = definitions.map(({ name, title, description, schema }) => ({
  name,
  title,
  description,
  inputSchema: z.toJSONSchema(name === "send" ? sendWireSchema : schema, {
    io: "input",
  }) as Tool["inputSchema"],
  annotations: {
    readOnlyHint: name !== "send",
    destructiveHint: name === "send",
    idempotentHint: name !== "send",
    openWorldHint: true,
  },
}));

const result = (value: Record<string, unknown>, document?: string): CallToolResult => {
  const output: CallToolResult = {
    content: [{ type: "text", text: document ?? JSON.stringify(value) }],
    structuredContent: value,
  };
  if (Buffer.byteLength(JSON.stringify(output)) > 1024 * 1024)
    throw new ExtensionError("output_limit");
  return output;
};
const parsed = <T>(schema: z.ZodType<T>, output: string): T => {
  try {
    return schema.parse(JSON.parse(output));
  } catch {
    throw new ExtensionError("invalid_response");
  }
};
const paginate = (items: unknown[], offset: number, limit: number) => ({
  items: items.slice(offset, offset + limit),
  total: items.length,
  nextOffset: offset + limit < items.length ? offset + limit : null,
});
const summarize = ({ meta, ...item }: z.infer<typeof summary>) => ({
  ...item,
  tags: meta?.tags ?? [],
  ...(meta?.owner === undefined ? {} : { owner: meta.owner }),
});

export function requestArguments(
  args: z.infer<typeof getSchema> | z.infer<typeof sendSchema>,
): string[] {
  if ((args.scope === undefined) === (args.connection === undefined))
    throw new ExtensionError("invalid_request");
  const method = "method" in args ? args.method : "GET";
  const argv = ["request", `--method=${method}`];
  if (args.connection !== undefined) argv.push(`--connection=${args.connection}`);
  for (const scope of typeof args.scope === "string" ? [args.scope] : (args.scope ?? []))
    argv.push(`--scope=${scope}`);
  for (const header of args.headers ?? []) argv.push(`--header=${header}`);
  if ("method" in args) {
    if (args.json !== undefined && args.text !== undefined)
      throw new ExtensionError("invalid_request");
    if (args.json !== undefined) argv.push(`--json=${JSON.stringify(args.json)}`);
    if (args.text !== undefined) argv.push(`--data=${args.text}`);
  }
  if (args.responseMode === "text") argv.push("--output=-");
  argv.push(args.url);
  // Stay below Windows' command-line limit, including the executable and quoting.
  if (argv.join(" ").length > 24_000 || argv.some((arg) => arg.includes("\0")))
    throw new ExtensionError("invalid_request");
  return argv;
}

export async function callTool(
  cli: CliRunner,
  name: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  try {
    const definition = definitions.find((tool) => tool.name === name);
    if (!definition) throw new ExtensionError("invalid_request");
    const validation = definition.schema.safeParse(input ?? {});
    if (!validation.success) throw new ExtensionError("invalid_request");
    if (name === "get" || name === "send") {
      const args = name === "get" ? getSchema.parse(input) : sendSchema.parse(input);
      const body = await cli.run(requestArguments(args), signal, REQUEST_TIMEOUT);
      return result({ body }, body);
    }
    if (name === "read_skill_document") {
      const args = z.object({ slug }).parse(input);
      const skill = parsed(detail, await cli.run(["skills", "show", args.slug, "--json"], signal));
      if (skill.slug !== args.slug) throw new ExtensionError("invalid_response");
      const { document, involvedResources, ...metadata } = skill;
      return result(
        {
          ...summarize(metadata),
          ...(involvedResources === undefined ? {} : { involvedResources }),
        },
        document,
      );
    }
    const { offset, limit } = z.object(page).parse(input ?? {});
    if (name === "list_connections") {
      const items = parsed(connections, await cli.run(["connections", "--json"], signal));
      return result(paginate(items, offset, limit));
    }
    if (name === "list_skills") {
      const value = parsed(catalog, await cli.run(["skills", "list", "--json"], signal));
      return result({
        ...paginate(value.items.map(summarize), offset, limit),
        warnings: value.warnings,
        freshness: "live",
      });
    }
    const { query } = z.object({ query: z.string() }).parse(validation.data);
    const output = await cli.run(["skills", "find", query, "--json"], signal);
    const items = parsed(z.array(cachedSummary).max(10_000), output);
    return result({
      ...paginate(items, offset, limit),
      freshness: "unknown",
      warnings: [
        {
          source: "cli_cache",
          code: "freshness_unknown",
          message:
            "Cached search may be stale or incomplete. Use list_skills to refresh/browse, then search again; no matches do not prove absence.",
        },
      ],
    });
  } catch (error) {
    const safe = safeError(error);
    return {
      isError: true,
      content: [{ type: "text", text: safe.message }],
      structuredContent: {
        error: {
          code: safe.code,
          message: safe.message,
          ...(safe.exitCode === undefined ? {} : { exitCode: safe.exitCode }),
          ...(safe.stderr === undefined ? {} : { stderr: safe.stderr }),
        },
      },
    };
  }
}
