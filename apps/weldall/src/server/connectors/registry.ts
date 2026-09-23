import { ConnectorError } from "./contracts";
import type { Capability } from "./scopes";

// Built-ins only. A future resource-advertised capability registry could make external connectors discoverable.
interface Operation {
  name: string;
  capability: Capability;
  origin: string;
  path: RegExp;
  methods: readonly string[];
}
const operations: Operation[] = [
  {
    name: "gmail.messages.read",
    capability: "gmail.read",
    origin: "https://gmail.googleapis.com",
    path: /^\/gmail\/v1\/users\/me\/messages(?:\/[A-Za-z0-9_-]+(?:\/attachments\/[A-Za-z0-9_-]+)?)?$/,
    methods: ["GET"],
  },
  {
    name: "gmail.threads.read",
    capability: "gmail.read",
    origin: "https://gmail.googleapis.com",
    path: /^\/gmail\/v1\/users\/me\/threads(?:\/[A-Za-z0-9_-]+)?$/,
    methods: ["GET"],
  },
  {
    name: "gmail.labels.read",
    capability: "gmail.read",
    origin: "https://gmail.googleapis.com",
    path: /^\/gmail\/v1\/users\/me\/labels(?:\/[A-Za-z0-9_-]+)?$/,
    methods: ["GET"],
  },
  {
    name: "gmail.profile.read",
    capability: "gmail.read",
    origin: "https://gmail.googleapis.com",
    path: /^\/gmail\/v1\/users\/me\/profile$/,
    methods: ["GET"],
  },
  {
    name: "gmail.messages.send",
    capability: "gmail.send",
    origin: "https://gmail.googleapis.com",
    path: /^\/(?:upload\/)?gmail\/v1\/users\/me\/messages\/send$/,
    methods: ["POST"],
  },
  {
    name: "gmail.messages.modify",
    capability: "gmail.modify",
    origin: "https://gmail.googleapis.com",
    path: /^\/gmail\/v1\/users\/me\/(?:messages|threads)\/[A-Za-z0-9_-]+\/(?:modify|trash|untrash)$/,
    methods: ["POST"],
  },
  {
    name: "calendar.list.read",
    capability: "calendar.read",
    origin: "https://www.googleapis.com",
    path: /^\/calendar\/v3\/users\/me\/calendarList(?:\/[^/]+)?$/,
    methods: ["GET"],
  },
  {
    name: "calendar.read",
    capability: "calendar.read",
    origin: "https://www.googleapis.com",
    path: /^\/calendar\/v3\/calendars\/[^/]+$/,
    methods: ["GET"],
  },
  {
    name: "calendar.events.read",
    capability: "calendar.events.read",
    origin: "https://www.googleapis.com",
    path: /^\/calendar\/v3\/calendars\/[^/]+\/events(?:\/[A-Za-z0-9_-]+(?:\/instances)?)?$/,
    methods: ["GET"],
  },
  {
    name: "calendar.events.create",
    capability: "calendar.events.write",
    origin: "https://www.googleapis.com",
    path: /^\/calendar\/v3\/calendars\/[^/]+\/events$/,
    methods: ["POST"],
  },
  {
    name: "calendar.events.write",
    capability: "calendar.events.write",
    origin: "https://www.googleapis.com",
    path: /^\/calendar\/v3\/calendars\/[^/]+\/events\/[A-Za-z0-9_-]+$/,
    methods: ["PATCH", "PUT", "DELETE"],
  },
];
const queryKeys = new Set([
  "q",
  "maxResults",
  "pageToken",
  "labelIds",
  "includeSpamTrash",
  "format",
  "metadataHeaders",
  "fields",
  "alt",
  "uploadType",
  "timeMin",
  "timeMax",
  "updatedMin",
  "singleEvents",
  "orderBy",
  "showDeleted",
  "showHiddenInvitations",
  "timeZone",
  "syncToken",
  "maxAttendees",
  "sendUpdates",
  "conferenceDataVersion",
  "supportsAttachments",
  "alwaysIncludeEmail",
  "eventTypes",
  "iCalUID",
  "privateExtendedProperty",
  "sharedExtendedProperty",
  "showHidden",
  "minAccessRole",
]);
/** Explicit operations, not a prefix proxy. Reject path ambiguity before constructing the fixed-origin URL. */
export function resolveOperation(path: string, query: URLSearchParams, method: string) {
  if (path.length > 2000 || /[\\\u0000-\u0020\u007f?#]/.test(path))
    throw new ConnectorError("invalid_path", "Unsafe connector path.");
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new ConnectorError("invalid_path", "Invalid path encoding.");
    }
    if ([".", ".."].includes(decoded) || /[/%\\\u0000-\u0020\u007f?#]/.test(decoded))
      throw new ConnectorError("invalid_path", "Ambiguous connector path.");
  }
  const operation = operations.find((op) => op.path.test(path) && op.methods.includes(method));
  if (!operation)
    throw new ConnectorError(
      "unsupported_operation",
      "This Google operation is not supported by Weldall.",
      403,
    );
  if (
    query.toString().length > 8000 ||
    [...query.keys()].some((k) => !queryKeys.has(k)) ||
    query.getAll("alt").some((value) => value !== "json") ||
    query.getAll("uploadType").some((value) => value !== "media")
  )
    throw new ConnectorError("invalid_query", "Unsupported connector query parameter.");
  const target = new URL(path, operation.origin);
  target.search = query.toString();
  if (target.origin !== operation.origin || target.pathname !== path)
    throw new ConnectorError("invalid_path", "Unsafe connector path.");
  return { ...operation, target };
}
