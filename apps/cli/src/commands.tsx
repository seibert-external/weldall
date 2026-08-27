import { define } from "gunshi";
import { Box } from "ink";
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
  IdentityCard,
  PermissionsCard,
  SkillsCard,
  info,
  printFields,
  printUi,
  printWarning,
  success,
  terminalDocument,
  terminalText,
  warning,
} from "./output.js";
import { login, logout, whoAmI } from "./services/auth.js";
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
import { appendixCache, type CachedSkillPreview } from "./storage/appendix.js";
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
  ...(skill.meta?.tags === undefined ? {} : { tags: skill.meta.tags }),
  ...(skill.meta?.owner === undefined ? {} : { owner: skill.meta.owner }),
  ...(skill.source.type === "resource"
    ? { sourceKey: skill.source.key, sourceName: skill.source.name }
    : { sourceName: "Weldall" }),
});

const cachedSubject = async (issuer: string) => {
  const credentials = await keychain.get(issuer).catch(() => null);
  return credentials?.version === 2
    ? (credentials.accessSession?.subject ?? credentials.identity?.subject ?? null)
    : (credentials?.identity?.subject ?? null);
};

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
    if (!process.stdout.isTTY) {
      success(`Logged in as ${terminalText(subject)}.`);
      return;
    }
    success("You're signed in.");
    try {
      const [identity, scopedPermissions, appendix] = await Promise.all([
        whoAmI(config),
        listScopesWithSubject(config),
        getCliAppendix(config).catch(() => undefined),
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
      });
      console.log();
      printStatus(identity, permissions);
    } catch {
      warning(
        "Signed in, but your account details could not be loaded.",
        "Run `weldall status` to try again.",
      );
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

export const statusCommand = define({
  name: "status",
  description: "Show who you are signed in as and what you can do",
  args: { json: jsonArgument },
  examples: "weldall status\nweldall status --json",
  run: async (context) => {
    const config = await resolveWeldallConfig();
    const [identity, scopedPermissions, appendix] = await Promise.all([
      whoAmI(config),
      listScopesWithSubject(config),
      getCliAppendix(config).catch(() => undefined),
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
  args: { json: jsonArgument },
  examples: "weldall scopes\nweldall scopes --json",
  run: async (context) => {
    const config = await resolveWeldallConfig();
    const { result: permissions, subject } = await listScopesWithSubject(config);
    await updateSnapshotBestEffort(config.issuer, {
      scopes: permissions.assignedScopes,
      subject,
    });
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
      required: true,
      description: "Permission to request; repeat for more than one",
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
    "weldall request --scope expenses:read https://expenses.example/api/expenses\n" +
    "weldall request -X POST --scope expenses:create --json '{\"amount\":24}' https://expenses.example/api/expenses\n" +
    "weldall request -X PUT --scope files:write -T ./report.pdf -H 'Content-Type: application/pdf' https://files.example/api/report.pdf\n" +
    "weldall request --scope files:read -o ./report.pdf https://files.example/api/report.pdf\n" +
    "weldall request --scope personio:read --paginate offset --page-size 100 --total-pages-pointer /metadata/total_pages --max-pages 20 --concurrency 3 --page-output jsonl https://gateway.example/personio/employees",
  run: async (context) => {
    const headers = parseHeaders(context.values.header);
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
        scopes: context.values.scope,
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

    const response = await resourceRequest(await resolveWeldallConfig(), {
      url: parseRequestUrl(context.values.url),
      method: context.values.method,
      scopes: context.values.scope,
      headers,
      ...(payload.kind === "json"
        ? { json: payload.value }
        : payload.kind === "text" || payload.kind === "file" || payload.kind === "form"
          ? { body: payload.body }
          : {}),
    });
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

const printSkills = async (asJson: boolean | undefined) => {
  const config = await resolveWeldallConfig();
  const { result, subject } = await listSkillsWithSubject(config);
  await cacheSkills(config.issuer, result.items, subject);
  if (asJson) {
    jsonOutput(result);
    return;
  }
  for (const item of result.warnings) printWarning(formatSkillWarning(item));
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
  args: { json: jsonArgument },
  examples: "weldall skills\nweldall skills list\nweldall skills list --json",
  run: (context) => printSkills(context.values.json),
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
  },
  examples: "weldall skills show expenses.review\nweldall skills show expenses.review --json",
  run: async (context) => {
    const config = await resolveWeldallConfig();
    const { result: skill, subject } = await showSkillWithSubject(config, context.values.skill);
    const snapshot = await appendixCache.readSnapshotForSubject(config.issuer, subject);
    const previews = new Map((snapshot?.skills ?? []).map((item) => [item.slug, item]));
    previews.set(skill.slug, skillPreview(skill));
    await updateSnapshotBestEffort(config.issuer, {
      skills: [...previews.values()].sort((left, right) => left.slug.localeCompare(right.slug)),
      subject,
    });
    if (context.values.json) jsonOutput(skill);
    else process.stdout.write(terminalDocument(skill.document));
  },
});

const skillsFindCommand = define({
  name: "find",
  description: "Search the locally cached skill catalog",
  args: {
    keyword: {
      type: "positional",
      required: true,
      description: "Text to match in skill names, tags, owners, or resources",
    },
    json: jsonArgument,
  },
  examples: "weldall skills find employee\nweldall skills find personio --json",
  run: async (context) => {
    const selection = await selectIssuer({ allowPrompt: false });
    if (!selection)
      throw new CliError("No Weldall issuer is configured", {
        hint: "Run `weldall config set-issuer <https://host>` first.",
      });
    const subject = await cachedSubject(selection.issuer);
    let snapshot = await appendixCache.readSnapshotForSubject(selection.issuer, subject);
    if (!snapshot?.skillsInitialized) {
      const config = await resolveWeldallConfig();
      const { result, subject: authenticatedSubject } = await listSkillsWithSubject(config);
      snapshot = await cacheSkills(config.issuer, result.items, authenticatedSubject);
    }
    const keyword = context.values.keyword.trim().toLocaleLowerCase();
    if (!keyword) throw new CliError("Skill search keyword must not be empty");
    const matches = snapshot.skills.filter((skill) =>
      [
        skill.slug,
        skill.title,
        ...(skill.tags ?? []),
        skill.owner ?? "",
        skill.sourceKey ?? "",
        skill.sourceName ?? "",
      ].some((value) => value.toLocaleLowerCase().includes(keyword)),
    );
    if (context.values.json) {
      jsonOutput(matches);
      return;
    }
    if (matches.length === 0) {
      info(`No cached skills match ${JSON.stringify(context.values.keyword)}.`);
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

export const skillsCommand = define({
  name: "skills",
  description: "Discover agent instructions published by your organization",
  args: { json: jsonArgument },
  subCommands: { list: skillsListCommand, show: skillsShowCommand, find: skillsFindCommand },
  run: (context) => printSkills(context.values.json),
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
      printFields(
        [
          ["Issuer", selection.issuer],
          ["Source", selection.source],
        ],
        "Configuration",
      );
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
