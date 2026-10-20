import type {
  ContentBlock,
  CreateMessageRequest,
  CreateMessageResultWithTools,
  EmbeddedResource,
  ListResourcesResult,
  LoggingMessageNotification,
  ReadResourceResult,
  ResourceLink,
} from "@modelcontextprotocol/sdk/types.js";

/** Host presentation; PiP is host-specific and need not be a separate OS window. */
export type McpAppDisplayMode = "inline" | "fullscreen" | "pip";

/** Standard host capabilities. An absent capability is unsupported, not permission to bypass it. */
export interface McpAppHostCapabilities {
  experimental?: Record<string, Record<string, unknown>>;
  serverTools?: { listChanged?: boolean };
  serverResources?: { listChanged?: boolean };
  message?: {
    text?: object;
    image?: object;
    audio?: object;
    resource?: object;
    resourceLink?: object;
  };
  updateModelContext?: McpAppHostCapabilities["message"];
  openLinks?: object;
  downloadFile?: object;
  logging?: object;
  sampling?: { tools?: object };
  [key: string]: unknown;
}

/** Host-provided presentation context. Hosts may add further standard/experimental fields. */
export interface McpAppHostContext {
  displayMode?: McpAppDisplayMode;
  availableDisplayModes?: McpAppDisplayMode[];
  theme?: "light" | "dark";
  locale?: string;
  [key: string]: unknown;
}

/** Latest initialized host capabilities and presentation context. */
export interface McpAppHost {
  capabilities: McpAppHostCapabilities;
  context: McpAppHostContext;
}

/** A context update replaces this app's previous context without starting a model turn. */
export interface McpAppModelContext {
  content?: ContentBlock[];
  structuredContent?: Record<string, unknown>;
}

/** A host can refuse an action, including when the user cancels a download or link prompt. */
export interface McpAppActionResult {
  isError?: boolean;
  [key: string]: unknown;
}

/** Typed standard requests; all are subject to host capabilities and host-side authorization. */
export interface McpAppRequests {
  "resources/read": { params: { uri: string }; result: ReadResourceResult };
  "resources/list": { params: { cursor?: string }; result: ListResourcesResult };
  "ui/message": { params: { role: "user"; content: ContentBlock[] }; result: McpAppActionResult };
  "ui/update-model-context": { params: McpAppModelContext; result: Record<string, unknown> };
  "ui/open-link": { params: { url: string }; result: McpAppActionResult };
  "ui/download-file": {
    params: { contents: (EmbeddedResource | ResourceLink)[] };
    result: McpAppActionResult;
  };
  "ui/request-display-mode": {
    params: { mode: McpAppDisplayMode };
    result: { mode: McpAppDisplayMode };
  };
  "sampling/createMessage": {
    params: CreateMessageRequest["params"];
    result: CreateMessageResultWithTools;
  };
}

/** Standard notifications; logging does not create chat messages. */
export interface McpAppNotifications {
  "notifications/message": LoggingMessageNotification["params"];
  "ui/notifications/size-changed": { width?: number; height?: number };
  "ui/notifications/request-teardown": Record<string, never>;
}

/** Host events. Initial/latest values are replayed when subscribing after the HTML bootstrap. */
export type McpAppEvent =
  | { method: "ui/notifications/tool-input"; params: { arguments: Record<string, unknown> } }
  | {
      method: "ui/notifications/tool-input-partial";
      params: { arguments: Record<string, unknown> };
    }
  | {
      method: "ui/notifications/tool-result";
      params: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      };
    }
  | { method: "ui/notifications/tool-cancelled"; params: { reason?: string } }
  | { method: "ui/notifications/host-context-changed"; params: McpAppHostContext }
  | { method: "ui/resource-teardown"; params: Record<string, unknown> };
