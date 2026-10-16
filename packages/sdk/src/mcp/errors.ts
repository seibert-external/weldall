/** Only fixed local messages cross an MCP boundary; never retain SDK errors as causes. */
const errors = {
  upstream_authentication_failed: [502, "The MCP server rejected this connection."],
  upstream_protocol_error: [502, "The MCP server returned an unsupported or invalid response."],
  upstream_unavailable: [502, "The MCP server is unavailable."],
  request_too_large: [413, "The MCP request exceeds the allowed limit."],
  response_too_large: [502, "The MCP response exceeds the allowed limit."],
  timeout: [504, "The MCP operation timed out."],
  cancelled: [499, "The MCP operation was cancelled."],
} as const;

export type McpErrorCode = keyof typeof errors;
export class McpBoundaryError extends Error {
  readonly status: number;
  constructor(readonly code: McpErrorCode) {
    super(errors[code][1]);
    this.name = "McpBoundaryError";
    this.status = errors[code][0];
  }
}
