import { define } from "gunshi";
import { Box, Text } from "ink";
import {
  encodeConnectionAttemptToon,
  encodeConnectionDetailToon,
  encodeConnectionsToon,
  encodeConnectorsToon,
  encodeDisconnectToon,
} from "./connections-toon.js";
import { discoverIssuer, resolveWeldallConfig, selectIssuer } from "./config.js";
import { CliError } from "./errors.js";
import { responseValue } from "./http.js";
import {
  MAX_PAGE_CONCURRENCY,
  MAX_PAGE_COUNT,
  MAX_PAGE_SIZE,
  paginateOffset,
} from "./pagination.js";
import {
  Card,
  IdentityCard,
  PermissionsCard,
  SkillsCard,
  TableCard,
  info,
  palette,
  printFields,
  printUi,
  printWarning,
  printWideUi,
  success,
  terminalDocument,
  terminalText,
  warning,
  type TableColumn,
} from "./output.js";
import { login, logout, whoAmI } from "./services/auth.js";
import {
  connectAccount,
  requestConnection,
  requestConnectionApi,
  disconnectConnection,
  listConnections,
  listConnectors,
  showConnection,
  showConnectionAttempt,
  type ConnectionAttempt,
  type ConnectionSummary,
  type ConnectorSummary,
} from "./services/connections.js";
import { getCliAppendix } from "./services/settings.js";
import {
  listScopes,
  listScopesWithSubject,
  resourceRequest,
  type ResourceGrant,
} from "./services/resources.js";
import {
  listSkills,
  listSkillsWithSubject,
  showSkillWithSubject,
  type SkillWarning,
} from "./services/skills.js";
import { scopesToon } from "./scopes-toon.js";
import { skillDetailToon, skillMatchesToon, skillsToon } from "./skills-toon.js";
import {
  appendixCache,
  type CachedConnectionPreview,
  type CachedConnectorPreview,
  type CachedSkillPreview,
} from "./storage/appendix.js";
import { weldallConfigCache } from "./storage/config-cache.js";
import { keychain } from "./storage/keychain.js";
import { issuerPreferences } from "./storage/preferences.js";
import { buildRequestPayload, isTextResponse, writeResponseBody } from "./transfers.js";

const jsonOutput = (value: unknown) => console.log(JSON.stringify(value, null, 2));
type Identity = Awaited<ReturnType<typeof whoAmI>>;
type ScopeOverview = Awaited<ReturnType<typeof listScopes>>;
type Skill = Awaited<ReturnType<typeof listSkills>>["items"][number];

const skillPreview = (skill: Skill): CachedSkillPreview => ({
  slug: skill.slug,
  title: skill.title,
  available: skill.available,
  preview: skill.preview,
  ...(skill.meta?.tags === undefined ? {} : { tags: skill.meta.tags }),
  ...(skill.meta?.owner === undefined ? {} : { owner: skill.meta.owner }),
  ...(skill.source.type === "resource"
    ? { sourceKey: skill.source.key, sourceName: skill.source.name }
    : { sourceName: "Weldall" }),
});

const normalizedSearchTerms = (value: string): string[] => {
  const terms = [
    ...new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(Boolean)),
  ];
  return terms.length > 1 ? terms.filter((term) => term.length >= 3) : terms;
};

/**
 * Searches cached skill metadata without a network request. Exact phrase
 * matches rank first; otherwise multi-word queries match and rank by the
 * number of individual terms found across identifiers, metadata, and preview.
 */
export const findCachedSkills = (
  skills: readonly CachedSkillPreview[],
  query: string,
): CachedSkillPreview[] => {
  const phrase = query.trim().toLocaleLowerCase();
  if (!phrase) return [];
  const terms = normalizedSearchTerms(phrase);
  return skills
    .map((skill, index) => {
      const values = [
        skill.slug,
        skill.title,
        skill.preview ?? "",
        ...(skill.tags ?? []),
        skill.owner ?? "",
        skill.sourceKey ?? "",
        skill.sourceName ?? "",
      ].map((value) => value.toLocaleLowerCase());
      const phraseMatch = values.some((value) => value.includes(phrase));
      const termMatches = terms.filter((term) =>
        values.some((value) => value.includes(term)),
      ).length;
      return { skill, index, score: phraseMatch ? terms.length + 1 : termMatches };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ skill }) => skill);
};

const cachedSubject = async (issuer: string) => {
  const credentials = await keychain.get(issuer).catch(() => null);
  return credentials?.version === 2
    ? (credentials.accessSession?.subject ?? credentials.identity?.subject ?? null)
    : (credentials?.identity?.subject ?? null);
};

const connectorPreview = (connector: ConnectorSummary): CachedConnectorPreview => ({
  key: connector.key,
  name: connector.name,
  groups: [...new Set(connector.scopes.map((scope) => scope.group))],
});

const connectionPreview = (connection: ConnectionSummary): CachedConnectionPreview => ({
  name: connection.name,
  connectorKey: connection.connectorKey,
  status: connection.status,
});

const cacheConnectorState = (
  issuer: string,
  {
    connectors,
    connections,
    subject,
  }: {
    connectors?: readonly ConnectorSummary[];
    connections?: readonly ConnectionSummary[];
    subject?: string;
  },
) =>
  updateSnapshotBestEffort(issuer, {
    ...(connectors === undefined ? {} : { connectors: connectors.map(connectorPreview) }),
    ...(connections === undefined ? {} : { connections: connections.map(connectionPreview) }),
    ...(subject === undefined ? {} : { subject }),
  });

const cacheSkills = async (issuer: string, skills: Skill[], subject: string) => {
  const previews = skills.map(skillPreview);
  const patch = {
    skills: previews,
    skillsInitialized: true,
    subject,
  };
  return appendixCache.updateSnapshot(issuer, patch).catch(() => ({
    appendix: "",
    scopes: [],
    connectors: [],
    connections: [],
    ...patch,
  }));
};

const updateSnapshotBestEffort = (
  issuer: string,
  patch: Parameters<typeof appendixCache.updateSnapshot>[1],
) => appendixCache.updateSnapshot(issuer, patch).catch(() => undefined);

const identityCard = (identity: Identity) => (
  <IdentityCard
    name={identity.name}
    email={identity.email}
    issuer={identity.issuer}
    subject={identity.subject}
  />
);

const printIdentity = (identity: Identity) => printUi(identityCard(identity));

const permissionsCard = (
  grants: ResourceGrant[],
  assignedScopes = [...new Set(grants.flatMap((grant) => grant.grantedScopes))].sort(),
) => (
  <PermissionsCard
    scopes={assignedScopes}
    availableApis={grants
      .filter((grant) => grant.grantedScopes.length > 0)
      .map((grant) => ({ id: grant.key, name: grant.name }))}
  />
);

export const printPermissions = (
  grants: ResourceGrant[],
  assignedScopes = [...new Set(grants.flatMap((grant) => grant.grantedScopes))].sort(),
) => printUi(permissionsCard(grants, assignedScopes));

const printStatus = (identity: Identity, permissions: ScopeOverview) =>
  printUi(
    <Box flexDirection="column" gap={1}>
      {identityCard(identity)}
      {permissionsCard(permissions.resources, permissions.assignedScopes)}
    </Box>,
  );

export const loginCommand = define({
  name: "login",
  description: "Sign in securely through your browser",
  examples: "weldall login",
  run: async () => {
    const config = await resolveWeldallConfig({ refresh: true });
    info(`Opening ${config.issuer} in your browser…`);
    const subject = await login(config);
    await updateSnapshotBestEffort(config.issuer, { subject });
    const connectorsPromise = listConnectors(config).catch(() => undefined);
    const connectionsPromise = listConnections(config).catch(() => undefined);
    if (!process.stdout.isTTY) {
      const [connectors, connections] = await Promise.all([connectorsPromise, connectionsPromise]);
      await cacheConnectorState(config.issuer, {
        ...(connectors === undefined ? {} : { connectors }),
        ...(connections === undefined ? {} : { connections }),
        subject,
      });
      success(`Logged in as ${terminalText(subject)}.`);
      return;
    }
    success("You're signed in.");
    try {
      const [identity, scopedPermissions, appendix, connectors, connections] = await Promise.all([
        whoAmI(config),
        listScopesWithSubject(config),
        getCliAppendix(config).catch(() => undefined),
        connectorsPromise,
        connectionsPromise,
      ]);
      if (identity.subject !== scopedPermissions.subject)
        throw new CliError("The active Weldall account changed while loading login details", {
          hint: "Run `weldall status` to load one consistent account snapshot.",
        });
      const permissions = scopedPermissions.result;
      await updateSnapshotBestEffort(config.issuer, {
        subject: scopedPermissions.subject,
        scopes: permissions.assignedScopes,
        ...(appendix === undefined ? {} : { appendix }),
        ...(connectors === undefined ? {} : { connectors: connectors.map(connectorPreview) }),
        ...(connections === undefined ? {} : { connections: connections.map(connectionPreview) }),
      });
      console.log();
      printStatus(identity, permissions);
    } catch {
      warning({
        message: "Signed in, but your account details could not be loaded.",
        hint: "Run `weldall status` to try again.",
      });
    }
  },
});

export const logoutCommand = define({
  name: "logout",
  description: "Sign out and remove this device's saved session",
  examples: "weldall logout",
  run: async () => {
    const config = await resolveWeldallConfig();
    const hadSession = await logout(config);
    if (hadSession) success("Logged out.");
    else info("You were not signed in to this Weldall host.");
  },
});

const jsonArgument = {
  type: "boolean",
  description: "Print machine-readable JSON instead of explanatory text",
} as const;

// Deliberately unstable, unlike --json. The shape exists to be read by a model, so it is expected
// to be retuned as models change, and nothing should be written against it that must keep working.
const agenticArgument = {
  type: "boolean",
  description: "Print output shaped for an agent (TOON; unstable, may change without notice)",
} as const;

/** Rejects conflicting structured-output modes before any CLI command reaches the network. */
const assertExclusiveOutputFlags = ({
  json,
  agentic,
}: {
  json: boolean | undefined;
  agentic: boolean | undefined;
}) => {
  if (json && agentic) throw new CliError("--json cannot be combined with --agentic");
};

export const statusCommand = define({
  name: "status",
  description: "Show who you are signed in as and what you can do",
  args: { json: jsonArgument },
  examples: "weldall status\nweldall status --json",
  run: async (context) => {
    const config = await resolveWeldallConfig();
    const [identity, scopedPermissions, appendix, connectors, connections] = await Promise.all([
      whoAmI(config),
      listScopesWithSubject(config),
      getCliAppendix(config).catch(() => undefined),
      listConnectors(config).catch(() => undefined),
      listConnections(config).catch(() => undefined),
    ]);
    if (identity.subject !== scopedPermissions.subject)
      throw new CliError("The active Weldall account changed while loading status", {
        hint: "Run `weldall status` again.",
      });
    const permissions = scopedPermissions.result;
    await updateSnapshotBestEffort(config.issuer, {
      subject: scopedPermissions.subject,
      scopes: permissions.assignedScopes,
      ...(appendix === undefined ? {} : { appendix }),
      ...(connectors === undefined ? {} : { connectors: connectors.map(connectorPreview) }),
      ...(connections === undefined ? {} : { connections: connections.map(connectionPreview) }),
    });
    if (context.values.json)
      jsonOutput({
        identity,
        assignedScopes: permissions.assignedScopes,
        grants: permissions.resources,
      });
    else printStatus(identity, permissions);
  },
});

export const whoamiCommand = define({
  name: "whoami",
  description: "Show which account is signed in",
  args: { json: jsonArgument },
  examples: "weldall whoami\nweldall whoami --json",
  run: async (context) => {
    const config = await resolveWeldallConfig();
    const identity = await whoAmI(config);
    await updateSnapshotBestEffort(config.issuer, { subject: identity.subject });
    if (context.values.json) jsonOutput(identity);
    else printIdentity(identity);
  },
});

export const scopesCommand = define({
  name: "scopes",
  description: "Explain what the signed-in account is allowed to do",
  args: { json: jsonArgument, agentic: agenticArgument },
  examples: "weldall scopes\nweldall scopes --json\nweldall scopes --agentic",
  run: async (context) => {
    assertExclusiveOutputFlags({ json: context.values.json, agentic: context.values.agentic });
    const config = await resolveWeldallConfig();
    const { result: permissions, subject } = await listScopesWithSubject(config);
    await updateSnapshotBestEffort(config.issuer, {
      scopes: permissions.assignedScopes,
      subject,
    });
    if (context.values.agentic) {
      process.stdout.write(scopesToon(permissions));
      return;
    }
    if (context.values.json) {
      jsonOutput(permissions);
      return;
    }
    if (!process.stdout.isTTY) {
      for (const scope of permissions.assignedScopes) console.log(terminalText(scope));
      return;
    }
    printPermissions(permissions.resources, permissions.assignedScopes);
  },
});

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

const parseMethod = (value: string) => {
  const method = value.toUpperCase();
  if (!HTTP_METHODS.has(method)) {
    throw new TypeError("Method must be GET, HEAD, POST, PUT, PATCH, DELETE, or OPTIONS");
  }
  return method;
};

const parseRequestUrl = (value: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError("URL must be an absolute HTTPS URL", { cause: error });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError("URL must be HTTPS and must not contain credentials or a fragment");
  }
  return url.toString();
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError("--json must contain valid JSON", { cause: error });
  }
};

const boundedInteger = (name: string, maximum: number) => (value: string) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  return parsed;
};

const parsePagination = (value: string) => {
  if (value !== "offset") throw new TypeError("--paginate currently supports only offset");
  return value;
};

const parsePageOutput = (value: string) => {
  if (value !== "jsonl") throw new TypeError("--page-output currently supports only jsonl");
  return value;
};

const parseHeaders = (values: string[] | undefined): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const value of values ?? []) {
    const separator = value.indexOf(":");
    const name = value.slice(0, separator).trim().toLowerCase();
    const headerValue = value.slice(separator + 1).trim();
    if (separator < 1 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
      throw new CliError(`Invalid header ${JSON.stringify(value)}`);
    }
    if (["authorization", "dpop", "host", "content-length", "cookie"].includes(name)) {
      throw new CliError(`Header ${JSON.stringify(name)} is managed by Weldall`);
    }
    headers[name] = headerValue;
  }
  return headers;
};

export const requestCommand = define({
  name: "request",
  description: "Send a DPoP-authenticated HTTP request",
  args: {
    url: {
      type: "positional",
      required: true,
      description: "Absolute HTTPS URL",
    },
    method: {
      type: "custom",
      short: "X",
      default: "GET",
      parse: parseMethod,
      description: "HTTP method; defaults to GET",
    },
    scope: {
      type: "string",
      short: "s",
      multiple: true,
      description: "Permission to request; required for normal resources, not managed connections",
    },
    connection: {
      type: "string",
      description: "Owner-managed connection name or ID; pass a full provider HTTPS URL",
    },
    header: {
      type: "string",
      short: "H",
      multiple: true,
      description: "Additional `Name: value` header; repeat for more than one",
    },
    data: {
      type: "string",
      short: "d",
      description: "Raw text request body",
    },
    json: {
      type: "custom",
      short: "j",
      parse: parseJson,
      description: "JSON request body",
    },
    uploadFile: {
      type: "string",
      short: "T",
      toKebab: true,
      description: "Upload a file as the raw request body",
    },
    form: {
      type: "string",
      short: "F",
      multiple: true,
      description: "Multipart field as `name=value` or `name=@path[;type=MIME]`; repeatable",
    },
    output: {
      type: "string",
      short: "o",
      description: "Write the response body to a file, or `-` for stdout",
    },
    paginate: {
      type: "custom",
      parse: parsePagination,
      description: "Paginate GET requests; currently only `offset`",
    },
    pageSize: {
      type: "custom",
      toKebab: true,
      parse: boundedInteger("--page-size", MAX_PAGE_SIZE),
      description: `Items per page (1-${MAX_PAGE_SIZE}); defaults to 100`,
    },
    totalPagesPointer: {
      type: "string",
      toKebab: true,
      description: "RFC 6901 JSON Pointer to the total page count",
    },
    maxPages: {
      type: "custom",
      toKebab: true,
      parse: boundedInteger("--max-pages", MAX_PAGE_COUNT),
      description: `Hard page limit (1-${MAX_PAGE_COUNT}); defaults to 20`,
    },
    concurrency: {
      type: "custom",
      parse: boundedInteger("--concurrency", MAX_PAGE_CONCURRENCY),
      description: `Concurrent page requests (1-${MAX_PAGE_CONCURRENCY}); defaults to 3`,
    },
    pageOutput: {
      type: "custom",
      toKebab: true,
      parse: parsePageOutput,
      description: "Paginated output format; currently only `jsonl`",
    },
    limitParameter: {
      type: "string",
      toKebab: true,
      description: "Offset pagination limit parameter; defaults to `limit`",
    },
    offsetParameter: {
      type: "string",
      toKebab: true,
      description: "Offset pagination offset parameter; defaults to `offset`",
    },
  },
  examples:
    "weldall request --connection my-google https://gmail.googleapis.com/gmail/v1/users/me/messages\n" +
    "weldall request --scope expenses:read https://expenses.example/api/expenses\n" +
    "weldall request -X POST --scope expenses:create --json '{\"amount\":24}' https://expenses.example/api/expenses\n" +
    "weldall request -X PUT --scope files:write -T ./report.pdf -H 'Content-Type: application/pdf' https://files.example/api/report.pdf\n" +
    "weldall request --scope files:read -o ./report.pdf https://files.example/api/report.pdf\n" +
    "weldall request --scope personio:read --paginate offset --page-size 100 --total-pages-pointer /metadata/total_pages --max-pages 20 --concurrency 3 --page-output jsonl https://gateway.example/personio/employees",
  run: async (context) => {
    const headers = parseHeaders(context.values.header);
    const scopes = context.values.scope ?? [];
    if (!context.values.connection && !scopes.length)
      throw new CliError("--scope is required for normal resource requests");
    if (context.values.connection && scopes.length)
      throw new CliError("Managed connection permissions come from setup; do not pass --scope");
    if (context.values.connection && context.values.paginate)
      throw new CliError(
        "Managed connections do not support --paginate; follow the provider's pagination instructions and request each page explicitly.",
      );
    if (context.values.paginate !== undefined) {
      if (context.values.method !== "GET")
        throw new CliError("Offset pagination is allowed only for GET requests");
      if (context.values.totalPagesPointer === undefined)
        throw new CliError("--total-pages-pointer is required with --paginate offset");
      if (context.values.pageOutput !== "jsonl")
        throw new CliError("--page-output jsonl is required with --paginate offset");
      if (
        context.values.data !== undefined ||
        context.values.json !== undefined ||
        context.values.uploadFile !== undefined ||
        context.values.form !== undefined ||
        context.values.output !== undefined
      )
        throw new CliError("Pagination cannot be combined with request bodies or --output");
      const config = await resolveWeldallConfig();
      const pages = await paginateOffset(config, {
        url: parseRequestUrl(context.values.url),
        scopes,
        headers,
        pageSize: context.values.pageSize ?? 100,
        totalPagesPointer: context.values.totalPagesPointer,
        maxPages: context.values.maxPages ?? 20,
        concurrency: context.values.concurrency ?? 3,
        ...(context.values.limitParameter === undefined
          ? {}
          : { limitParameter: context.values.limitParameter }),
        ...(context.values.offsetParameter === undefined
          ? {}
          : { offsetParameter: context.values.offsetParameter }),
      });
      for (const page of pages) console.log(JSON.stringify(page));
      return;
    }
    if (
      context.values.pageOutput !== undefined ||
      context.values.totalPagesPointer !== undefined ||
      context.values.pageSize !== undefined ||
      context.values.maxPages !== undefined ||
      context.values.concurrency !== undefined ||
      context.values.limitParameter !== undefined ||
      context.values.offsetParameter !== undefined
    )
      throw new CliError("Pagination options require --paginate offset");

    const payload = await buildRequestPayload({
      method: context.values.method,
      data: context.values.data,
      json: context.values.json,
      uploadFile: context.values.uploadFile,
      form: context.values.form,
    });
    if (payload.kind === "form" && headers["content-type"] !== undefined) {
      throw new CliError(
        "Do not set Content-Type with --form; Weldall adds the multipart boundary",
      );
    }
    if (payload.kind === "file" && headers["content-type"] === undefined) {
      headers["content-type"] = "application/octet-stream";
    }

    const config = await resolveWeldallConfig();
    const input = {
      // Preserve raw provider metadata so server validation sees ambiguous encodings and dot segments.
      url: context.values.connection ? context.values.url : parseRequestUrl(context.values.url),
      method: context.values.method,
      scopes,
      headers,
      ...(payload.kind === "json"
        ? { json: payload.value }
        : payload.kind === "text" || payload.kind === "file" || payload.kind === "form"
          ? { body: payload.body }
          : {}),
    };
    const response = context.values.connection
      ? await requestConnection({ config, selector: context.values.connection, input })
      : await resourceRequest(config, input);
    if (context.values.output !== undefined) {
      await writeResponseBody(response, context.values.output);
      return;
    }
    if (!isTextResponse(response)) {
      throw new CliError("The response is binary", {
        hint: "Use --output <path> to save it or --output - to write it to stdout.",
      });
    }
    const value = await responseValue(response);
    if (typeof value === "string") console.log(terminalDocument(value));
    else jsonOutput(value);
  },
});

export const formatSkillWarning = (warning: SkillWarning): string => {
  const source = terminalText(warning.source);
  const messages: Record<string, string> = {
    catalog_pending: `Skills from ${source} are not available yet because the catalog has not been fetched.`,
    catalog_temporarily_unavailable: `Skills from ${source} may be outdated because the catalog could not be refreshed.`,
    catalog_expired: `Skills from ${source} are unavailable because the catalog could not be refreshed in time.`,
  };
  return (
    messages[warning.code] ?? `The ${source} skill catalog reported ${terminalText(warning.code)}.`
  );
};

/** Loads skills and prints the selected human, JSON, or agent-oriented CLI representation. */
export const printSkills = async ({
  asJson,
  asAgentic,
}: {
  asJson: boolean | undefined;
  asAgentic?: boolean | undefined;
}) => {
  assertExclusiveOutputFlags({ json: asJson, agentic: asAgentic });
  const config = await resolveWeldallConfig();
  const { result, subject } = await listSkillsWithSubject(config);
  await cacheSkills(config.issuer, result.items, subject);
  if (asAgentic) {
    process.stdout.write(skillsToon(result));
    return;
  }
  if (asJson) {
    jsonOutput(result);
    return;
  }
  for (const item of result.warnings) printWarning({ message: formatSkillWarning(item) });
  if (result.items.length === 0) {
    info("No skills are visible to this account.");
    return;
  }
  printUi(
    <SkillsCard
      skills={result.items.map((skill) => ({
        id: skill.slug,
        title: skill.title,
        available: skill.available,
        missingScopes: skill.missingScopes,
      }))}
    />,
  );
};

const skillsListCommand = define({
  name: "list",
  description: "List skills visible to the signed-in account",
  args: { json: jsonArgument, agentic: agenticArgument },
  examples:
    "weldall skills\nweldall skills list\nweldall skills list --json\nweldall skills list --agentic",
  run: (context) => printSkills({ asJson: context.values.json, asAgentic: context.values.agentic }),
});

const skillsShowCommand = define({
  name: "show",
  description: "Print one complete skill document",
  args: {
    skill: {
      type: "positional",
      required: true,
      description: "Skill ID from `weldall skills list`",
    },
    json: jsonArgument,
    agentic: agenticArgument,
  },
  examples:
    "weldall skills show expenses.review\nweldall skills show expenses.review --json\nweldall skills show expenses.review --agentic",
  run: async (context) => {
    assertExclusiveOutputFlags({ json: context.values.json, agentic: context.values.agentic });
    const config = await resolveWeldallConfig();
    const { result: skill, subject } = await showSkillWithSubject(config, context.values.skill);
    const snapshot = await appendixCache.readSnapshotForSubject(config.issuer, subject);
    const previews = new Map((snapshot?.skills ?? []).map((item) => [item.slug, item]));
    previews.set(skill.slug, skillPreview(skill));
    await updateSnapshotBestEffort(config.issuer, {
      skills: [...previews.values()].sort((left, right) => left.slug.localeCompare(right.slug)),
      subject,
    });
    if (context.values.agentic) process.stdout.write(skillDetailToon(skill));
    else if (context.values.json) jsonOutput(skill);
    else process.stdout.write(terminalDocument(skill.document));
  },
});

const skillsFindCommand = define({
  name: "find",
  description: "Search the locally cached skill catalog",
  args: {
    keywords: {
      type: "positional",
      required: true,
      description: "Text to match in skill IDs, titles, previews, tags, owners, or resources",
    },
    json: jsonArgument,
    agentic: agenticArgument,
  },
  examples:
    'weldall skills find employee\nweldall skills find "contract review date"\nweldall skills find personio --json\nweldall skills find personio --agentic',
  run: async (context) => {
    assertExclusiveOutputFlags({ json: context.values.json, agentic: context.values.agentic });
    const selection = await selectIssuer({ allowPrompt: false });
    if (!selection)
      throw new CliError("No Weldall issuer is configured", {
        hint: "Run `weldall config set-issuer <https://host>` first.",
      });
    const subject = await cachedSubject(selection.issuer);
    let snapshot = await appendixCache.readSnapshotForSubject(selection.issuer, subject);
    if (
      !snapshot?.skillsInitialized ||
      snapshot.skills.some((skill) => skill.preview === undefined)
    ) {
      const config = await resolveWeldallConfig();
      const { result, subject: authenticatedSubject } = await listSkillsWithSubject(config);
      snapshot = await cacheSkills(config.issuer, result.items, authenticatedSubject);
    }
    const keyword = context.values.keywords.trim().toLocaleLowerCase();
    if (!keyword) throw new CliError("Skill search keyword must not be empty");
    const matches = findCachedSkills(snapshot.skills, keyword);
    if (context.values.agentic || context.values.json) {
      if (context.values.agentic) process.stdout.write(skillMatchesToon(matches));
      else jsonOutput(matches);
      if (matches.length === 0) {
        printWarning({
          message: `No cached skills match ${JSON.stringify(context.values.keywords)}.`,
          hint: "Try fewer or broader words, such as the system, resource, or action; run `weldall skills list` to browse every visible skill.",
        });
      }
      return;
    }
    if (matches.length === 0) {
      warning({
        message: `No cached skills match ${JSON.stringify(context.values.keywords)}.`,
        hint: "Try fewer or broader words, such as the system, resource, or action; run `weldall skills list` to browse every visible skill.",
      });
      return;
    }
    printUi(
      <SkillsCard
        skills={matches.map((skill) => ({
          id: skill.slug,
          title: skill.title,
          available: skill.available,
          missingScopes: [],
        }))}
      />,
    );
  },
});

const connectionSelector = {
  type: "positional",
  required: true,
  description: "Connection name or ID",
} as const;
const attemptSelector = {
  type: "positional",
  required: true,
  description: "Setup attempt ID",
} as const;

const connectionColumns = [
  { header: "Name" },
  { header: "Connector" },
  { header: "Account" },
  { header: "Status" },
  { header: "Last used" },
  { header: "Requests", align: "right" },
] satisfies readonly TableColumn[];

/** Formats server timestamps for compact human-readable connection tables. */
const formatShortTimestamp = (value: string | null) => {
  if (value === null) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

/** Maps managed-connection lifecycle states onto the shared terminal palette. */
const getConnectionStatusColor = (status: string) => {
  if (status === "READY") return palette.success;
  if (status === "RECONNECT_REQUIRED" || status === "REVOCATION_PENDING") return palette.warning;
  if (status === "DISCONNECTED") return palette.danger;
  return undefined;
};

/** Builds the terminal-table rows for the owner connection list. */
const buildConnectionRows = (connections: readonly ConnectionSummary[]) =>
  connections.map((connection) => [
    connection.name,
    connection.connectorKey,
    connection.accountName,
    connection.status,
    formatShortTimestamp(connection.lastUsedAt),
    String(connection.requestCount),
  ]);

const connectorScopeGroups = (connector: ConnectorSummary) =>
  [...new Set(connector.scopes.map((scope) => scope.group))].map((group) => ({
    group,
    scopes: connector.scopes.filter((scope) => scope.group === group),
  }));

/** Renders one connector as its own permission catalog with the caller's current connections. */
export function ConnectorCard({
  connector,
  connections = [],
}: {
  connector: ConnectorSummary;
  connections?: readonly ConnectionSummary[];
}) {
  const groups = connectorScopeGroups(connector);
  return (
    <Card title={terminalText(connector.name)} accent={palette.success}>
      <Text>
        <Text dimColor>Key </Text>
        {terminalText(connector.key)}
        <Text dimColor> · Type </Text>
        {terminalText(connector.type)}
      </Text>
      {connections.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Your connections</Text>
          {connections.map((connection) => {
            const color = getConnectionStatusColor(connection.status);
            return (
              <Text key={connection.id}>
                • {terminalText(connection.name)} · {terminalText(connection.accountName)} ·{" "}
                <Text {...(color === undefined ? {} : { color })}>
                  {terminalText(connection.status)}
                </Text>
              </Text>
            );
          })}
        </Box>
      )}
      {groups.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No permissions are exposed by this connector.</Text>
        </Box>
      ) : (
        groups.map(({ group, scopes }) => (
          <Box key={group} flexDirection="column" marginTop={1}>
            <Text bold>{terminalText(group)}</Text>
            {scopes.map((scope) => {
              const selection = scope.required
                ? "required"
                : connector.defaultScopes.includes(scope.id)
                  ? "selected by default"
                  : "optional";
              return (
                <Box key={scope.id} flexDirection="column" marginLeft={1}>
                  <Text>
                    • {terminalText(scope.label)} <Text dimColor>({selection})</Text>
                  </Text>
                  <Box marginLeft={2}>
                    <Text dimColor>{terminalText(scope.description)}</Text>
                  </Box>
                </Box>
              );
            })}
          </Box>
        ))
      )}
    </Card>
  );
}

function ConnectionRequestGuide({ includeSetup = false }: { includeSetup?: boolean }) {
  return (
    <Card title="Make provider requests" accent={palette.accent}>
      {includeSetup && (
        <Text>
          <Text dimColor>Connect: </Text>
          weldall connections connect &lt;connector-key&gt; --name &lt;connection-name&gt;
        </Text>
      )}
      <Text>
        <Text dimColor>Request: </Text>
        weldall request --connection &lt;connection-name-or-id&gt; &lt;provider-https-url&gt;
      </Text>
      <Text dimColor>Run `weldall request --help` for methods, headers, and request bodies.</Text>
    </Card>
  );
}

/** Prints one connection's credential-free details for a human CLI user. */
const printConnectionDetails = (connection: ConnectionSummary) => {
  const fields: Array<readonly [string, string]> = [
    ["Name", connection.name],
    ["Connection ID", connection.id],
    ["Connector", connection.connectorKey],
    ["Status", connection.status],
    ["Account", connection.accountName],
    ["Account ID", connection.accountId],
    ["Selected scopes", connection.selectedScopes.join(", ") || "—"],
    ["Granted scopes", connection.grantedScopes.join(", ") || "—"],
    ["Last used", formatShortTimestamp(connection.lastUsedAt)],
    ["Requests", String(connection.requestCount)],
    ["Created", formatShortTimestamp(connection.createdAt)],
    ["Updated", formatShortTimestamp(connection.updatedAt)],
  ];
  if (connection.revocationError) fields.push(["Revocation error", connection.revocationError]);
  printFields({ fields, title: "Connection" });
};

/** Prints one interrupted setup attempt for human CLI recovery. */
const printConnectionAttempt = (attempt: ConnectionAttempt) => {
  const fields: Array<readonly [string, string]> = [
    ["Attempt", attempt.id],
    ["Status", attempt.status],
    ["Connector", `${attempt.connector.name} (${attempt.connector.key})`],
    ["Expires", formatShortTimestamp(attempt.expiresAt)],
    ["Selected scopes", attempt.selection.scopes.join(", ") || "—"],
  ];
  if (attempt.connection)
    fields.push(["Connection", `${attempt.connection.name} (${attempt.connection.id})`]);
  printFields({ fields, title: "Connection setup" });
};

/** Loads connections and prints the selected human, JSON, or agent-oriented CLI representation. */
export const printConnections = async ({
  asJson,
  asAgentic,
}: {
  asJson: boolean | undefined;
  asAgentic: boolean | undefined;
}) => {
  assertExclusiveOutputFlags({ json: asJson, agentic: asAgentic });
  const config = await resolveWeldallConfig();
  const connections = await listConnections(config);
  await cacheConnectorState(config.issuer, { connections });
  if (asAgentic) {
    process.stdout.write(encodeConnectionsToon({ connections, issuer: config.issuer }));
    return;
  }
  if (asJson) {
    jsonOutput(connections);
    return;
  }
  if (connections.length === 0) {
    printUi(
      <Box flexDirection="column" gap={1}>
        <Card title="Connections" accent={palette.primary}>
          <Text>No connections yet. Run `weldall connectors` to see what you can connect.</Text>
        </Card>
        <ConnectionRequestGuide includeSetup />
      </Box>,
    );
    return;
  }
  printWideUi(
    <Box flexDirection="column" gap={1}>
      <TableCard
        title="Connections"
        columns={connectionColumns}
        rows={buildConnectionRows(connections)}
        cellColor={(_rowIndex, columnIndex, value) =>
          columnIndex === 3 ? getConnectionStatusColor(value) : undefined
        }
      />
      <ConnectionRequestGuide />
    </Box>,
  );
};

const connectionsListCommand = define({
  name: "list",
  description: "List connections owned by the signed-in account",
  args: { json: jsonArgument, agentic: agenticArgument },
  examples:
    "weldall connections list\nweldall connections list --json\nweldall connections list --agentic",
  run: (context) =>
    printConnections({ asJson: context.values.json, asAgentic: context.values.agentic }),
});

export const connectorsCommand = define({
  name: "connectors",
  description: "Discover connectors, their permissions, and how to make provider requests",
  args: { json: jsonArgument, agentic: agenticArgument },
  examples:
    "weldall connectors\n" +
    "weldall connections connect <connector-key> --name <connection-name>\n" +
    "weldall request --connection <connection-name> <provider-https-url>\n" +
    "weldall connectors --json\n" +
    "weldall connectors --agentic",
  run: async (context) => {
    assertExclusiveOutputFlags({ json: context.values.json, agentic: context.values.agentic });
    const config = await resolveWeldallConfig();
    const showConnections = !context.values.agentic && !context.values.json;
    const [connectors, connections] = await Promise.all([
      listConnectors(config),
      showConnections ? listConnections(config) : Promise.resolve([]),
    ]);
    await cacheConnectorState(config.issuer, {
      connectors,
      ...(showConnections ? { connections } : {}),
    });
    if (context.values.agentic) {
      process.stdout.write(encodeConnectorsToon(connectors));
      return;
    }
    if (context.values.json) {
      jsonOutput(connectors);
      return;
    }
    if (connectors.length === 0) {
      info("No connectors are enabled on this Weldall installation.");
      return;
    }
    printWideUi(
      <Box flexDirection="column" gap={1}>
        {connectors.map((connector) => (
          <ConnectorCard
            key={connector.key}
            connector={connector}
            connections={connections.filter(
              (connection) =>
                connection.connectorKey === connector.key && connection.status !== "DISCONNECTED",
            )}
          />
        ))}
        <ConnectionRequestGuide includeSetup />
      </Box>,
    );
  },
});

const connectCommand = define({
  name: "connect",
  description: "Authorize an account for a connector",
  args: {
    connector: {
      type: "positional",
      required: true,
      description: "Connector key from `weldall connectors`",
    },
    name: { type: "string", required: true, description: "Name for this connection" },
    json: jsonArgument,
    agentic: agenticArgument,
  },
  examples:
    "weldall connections connect google --name my-google\nweldall connections connect google --name my-google --json\nweldall connections connect google --name my-google --agentic",
  run: async ({ values }) => {
    assertExclusiveOutputFlags({ json: values.json, agentic: values.agentic });
    const config = await resolveWeldallConfig();
    const connection = await connectAccount({
      config,
      connector: values.connector,
      name: values.name,
    });
    if (values.agentic)
      process.stdout.write(encodeConnectionDetailToon({ connection, issuer: config.issuer }));
    else if (values.json) jsonOutput(connection);
    else {
      success(`Connected ${terminalText(connection.name)}.`);
      printConnectionDetails(connection);
    }
  },
});

const reconnectCommand = define({
  name: "reconnect",
  description: "Re-authorize an existing connection while keeping its identity",
  args: { connection: connectionSelector, json: jsonArgument, agentic: agenticArgument },
  examples:
    "weldall connections reconnect my-google\nweldall connections reconnect my-google --json\nweldall connections reconnect my-google --agentic",
  run: async ({ values }) => {
    assertExclusiveOutputFlags({ json: values.json, agentic: values.agentic });
    const config = await resolveWeldallConfig();
    const current = await showConnection({ config, selector: values.connection });
    const connection = await connectAccount({
      config,
      connector: current.connectorKey,
      name: current.name,
      reconnect: current.id,
    });
    if (values.agentic)
      process.stdout.write(encodeConnectionDetailToon({ connection, issuer: config.issuer }));
    else if (values.json) jsonOutput(connection);
    else {
      success(`Reconnected ${terminalText(connection.name)}.`);
      printConnectionDetails(connection);
    }
  },
});

const showConnectionCommand = define({
  name: "show",
  description: "Show one connection's permissions and health",
  args: { connection: connectionSelector, json: jsonArgument, agentic: agenticArgument },
  examples:
    "weldall connections show my-google\nweldall connections show my-google --json\nweldall connections show my-google --agentic",
  run: async ({ values }) => {
    assertExclusiveOutputFlags({ json: values.json, agentic: values.agentic });
    const config = await resolveWeldallConfig();
    const connection = await showConnection({ config, selector: values.connection });
    if (values.agentic)
      process.stdout.write(encodeConnectionDetailToon({ connection, issuer: config.issuer }));
    else if (values.json) jsonOutput(connection);
    else printConnectionDetails(connection);
  },
});

const disconnectCommand = define({
  name: "disconnect",
  description: "Delete a managed connection after best-effort provider revocation",
  args: { connection: connectionSelector, json: jsonArgument, agentic: agenticArgument },
  examples:
    "weldall connections disconnect my-google\nweldall connections disconnect my-google --json\nweldall connections disconnect my-google --agentic",
  run: async ({ values }) => {
    assertExclusiveOutputFlags({ json: values.json, agentic: values.agentic });
    const result = await disconnectConnection({
      config: await resolveWeldallConfig(),
      selector: values.connection,
    });
    const confirmed = result.status === "DISCONNECTED" && result.revocationConfirmed !== false;
    if (values.agentic) process.stdout.write(encodeDisconnectToon(result));
    else if (values.json) jsonOutput(result);
    else if (confirmed) success(`Disconnected ${terminalText(values.connection)}.`);
    else
      warning({
        message: "Disconnect is pending or provider revocation is unconfirmed.",
        hint: result.message ?? `Run weldall connections disconnect ${values.connection} to retry.`,
      });
    if (!confirmed) process.exitCode = 1;
  },
});

const connectionStatusCommand = define({
  name: "status",
  description: "Check an interrupted connection setup",
  args: { attempt: attemptSelector, json: jsonArgument, agentic: agenticArgument },
  examples:
    "weldall connections status <attempt-id>\nweldall connections status <attempt-id> --json\nweldall connections status <attempt-id> --agentic",
  run: async ({ values }) => {
    assertExclusiveOutputFlags({ json: values.json, agentic: values.agentic });
    const attempt = await showConnectionAttempt({
      config: await resolveWeldallConfig(),
      id: values.attempt,
    });
    if (values.agentic) process.stdout.write(encodeConnectionAttemptToon(attempt));
    else if (values.json) jsonOutput(attempt);
    else printConnectionAttempt(attempt);
  },
});

const cancelConnectionCommand = define({
  name: "cancel",
  description: "Cancel an attempt and revoke any retained unused provider grant",
  args: { attempt: attemptSelector, json: jsonArgument },
  examples:
    "weldall connections cancel <attempt-id>\nweldall connections cancel <attempt-id> --json",
  run: async ({ values }) => {
    const result = await requestConnectionApi({
      config: await resolveWeldallConfig(),
      path: `connection-authorizations/${encodeURIComponent(values.attempt)}`,
      method: "DELETE",
    });
    if (values.json) jsonOutput(result);
    else success(`Cancelled setup attempt ${terminalText(values.attempt)}.`);
  },
});

export const connectionsCommand = define({
  name: "connections",
  description: "Manage owner-only connections and use them for provider API requests",
  args: { json: jsonArgument, agentic: agenticArgument },
  examples:
    "weldall connections\n" +
    "weldall request --connection <connection-name-or-id> <provider-https-url>\n" +
    "weldall connections --json\n" +
    "weldall connections --agentic",
  subCommands: {
    list: connectionsListCommand,
    connect: connectCommand,
    reconnect: reconnectCommand,
    show: showConnectionCommand,
    disconnect: disconnectCommand,
    status: connectionStatusCommand,
    cancel: cancelConnectionCommand,
  },
  run: (context) =>
    printConnections({ asJson: context.values.json, asAgentic: context.values.agentic }),
});

export const skillsCommand = define({
  name: "skills",
  description: "Discover agent instructions published by your organization",
  args: { json: jsonArgument, agentic: agenticArgument },
  subCommands: { list: skillsListCommand, show: skillsShowCommand, find: skillsFindCommand },
  run: (context) => printSkills({ asJson: context.values.json, asAgentic: context.values.agentic }),
});

const setIssuerCommand = define({
  name: "set-issuer",
  description: "Validate and save the Weldall issuer preference",
  args: {
    issuer: {
      type: "positional",
      description: "Weldall HTTPS origin",
    },
  },
  examples: "weldall config set-issuer https://weldall.example.com",
  run: async (context) => {
    const config = await discoverIssuer(context.values.issuer);
    await weldallConfigCache.write(config.issuer, config).catch(() => undefined);
    await issuerPreferences.write(config.issuer);
    success(`Saved ${config.issuer}.`);
    if (process.env.WELDALL_ISSUER !== undefined)
      info("WELDALL_ISSUER is currently overriding this preference.");
  },
});

const getIssuerCommand = define({
  name: "get-issuer",
  description: "Show the effective Weldall issuer and its source",
  args: {
    json: {
      type: "boolean",
      description: "Print machine-readable JSON",
    },
  },
  run: async (context) => {
    const selection = await selectIssuer({ allowPrompt: false });
    if (!selection)
      throw new CliError("No Weldall issuer is configured", {
        exitCode: 2,
        hint: "Run `weldall config set-issuer <https://host>` or set WELDALL_ISSUER.",
      });
    if (context.values.json) jsonOutput(selection);
    else
      printFields({
        fields: [
          ["Issuer", selection.issuer],
          ["Source", selection.source],
        ],
        title: "Configuration",
      });
  },
});

const refreshConfigCommand = define({
  name: "refresh",
  description: "Refresh and revalidate cached Weldall discovery metadata",
  examples: "weldall config refresh",
  run: async () => {
    const config = await resolveWeldallConfig({ refresh: true });
    success(`Refreshed configuration for ${config.issuer}.`);
  },
});

const resetIssuerCommand = define({
  name: "reset-issuer",
  description: "Remove the saved Weldall issuer preference",
  run: async () => {
    await issuerPreferences.clear();
    success("Cleared the saved Weldall issuer.");
    if (process.env.WELDALL_ISSUER !== undefined)
      info("WELDALL_ISSUER remains active for this process.");
  },
});

export const configCommand = define({
  name: "config",
  description: "Choose which Weldall host this CLI uses",
  subCommands: {
    "set-issuer": setIssuerCommand,
    "get-issuer": getIssuerCommand,
    "reset-issuer": resetIssuerCommand,
    refresh: refreshConfigCommand,
  },
  run: () => info("Run `weldall config --help` to see configuration commands."),
});

export const mainCommand = define({
  name: "weldall",
  description: "Sign in securely and use your organization's APIs",
  run: () => info("Run `weldall status` to see your account and permissions."),
});
