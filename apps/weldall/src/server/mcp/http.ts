import { z } from "zod";
import { MCP_LIMITS, McpBoundaryError, assertMcpJson } from "@weldall/sdk/mcp";
import { createConnectorErrorResponse, privateHeaders } from "../connectors/http";
import { readBoundedBody } from "../connectors/core/transport";

export async function parseMcpBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.output<T>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
    throw new z.ZodError([]);
  const bytes = await readBoundedBody({
    response: request,
    maximum: MCP_LIMITS.requestBytes,
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
  });
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new z.ZodError([]);
  }
  assertMcpJson(value, MCP_LIMITS.requestBytes);
  return schema.parse(value);
}
export function mcpErrorResponse(error: unknown) {
  if (error instanceof McpBoundaryError)
    return Response.json(
      { error: error.code, error_description: error.message },
      { status: error.status, headers: privateHeaders },
    );
  if (error instanceof z.ZodError)
    return Response.json(
      { error: "invalid_request", error_description: "Invalid MCP request." },
      { status: 400, headers: privateHeaders },
    );
  return createConnectorErrorResponse(error);
}
