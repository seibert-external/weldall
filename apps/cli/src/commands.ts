import { define } from "gunshi";
import { discoverIssuer, resolveWeldallConfig, selectIssuer } from "./config.js";
import { CliError } from "./errors.js";
import { responseValue } from "./http.js";
import {
  bold,
  checkmark,
  dim,
  info,
  printFields,
  success,
  terminalDocument,
  terminalText,
  warning,
} from "./output.js";
import { login, logout, whoAmI } from "./services/auth.js";
import { listScopes, resourceRequest, type ResourceGrant } from "./services/resources.js";
import { listSkills, showSkill } from "./services/skills.js";
import { issuerPreferences } from "./storage/preferences.js";
import { buildRequestPayload, isTextResponse, writeResponseBody } from "./transfers.js";

const jsonOutput = (value: unknown) => console.log(JSON.stringify(value, null, 2));
type Identity = Awaited<ReturnType<typeof whoAmI>>;
type ScopeOverview = Awaited<ReturnType<typeof listScopes>>;

const printIdentity = (identity: Identity) => {
  console.log(`${bold("Signed in as")} ${terminalText(identity.name)}`);
  console.log();
  printFields([
    ["Email", terminalText(identity.email)],
    ["Weldall host", terminalText(identity.issuer)],
    ["Account ID", terminalText(identity.subject)],
  ]);
};

export const explainScope = (scope: string) => {
  const action = terminalText(scope.split(":").at(-1) ?? "").toLowerCase();
  const descriptions: Record<string, string> = {
    read: "Read data",
    create: "Create new data",
    write: "Create or change data",
    update: "Change existing data",
    delete: "Delete data",
    administer: "Manage access and settings",
    admin: "Manage access and settings",
    manage: "Manage data and settings",
  };
  const knownDescription = action ? descriptions[action] : undefined;
  return (
    knownDescription ??
    (action ? `${action.replaceAll(/[-_]/g, " ")} permission` : "Custom permission")
  );
};

export const printPermissions = (
  grants: ResourceGrant[],
  assignedScopes = [...new Set(grants.flatMap((grant) => grant.grantedScopes))].sort(),
) => {
  console.log(bold("Assigned permissions:"));
  if (assignedScopes.length === 0) {
    console.log("  No permissions are currently assigned to your account.");
    console.log(`  ${dim("Ask your Weldall administrator for the access you need.")}`);
    return;
  }

  const assignedWidth = Math.max(...assignedScopes.map((scope) => explainScope(scope).length));
  for (const scope of assignedScopes)
    console.log(
      `  ${checkmark()} ${explainScope(scope).padEnd(assignedWidth)}  ${dim(terminalText(scope))}`,
    );

  console.log();
  console.log(bold("Available APIs:"));
  const available = grants.filter((grant) => grant.grantedScopes.length > 0);
  if (available.length === 0) {
    console.log(`  ${dim("No enabled API resource currently exposes these permissions.")}`);
    return;
  }
  for (const grant of available) {
    console.log();
    console.log(bold(terminalText(grant.name)));
    const width = Math.max(...grant.grantedScopes.map((scope) => explainScope(scope).length));
    for (const scope of grant.grantedScopes)
      console.log(
        `  ${checkmark()} ${explainScope(scope).padEnd(width)}  ${dim(terminalText(scope))}`,
      );
  }
};

const printStatus = (identity: Identity, permissions: ScopeOverview) => {
  printIdentity(identity);
  console.log();
  printPermissions(permissions.resources, permissions.assignedScopes);
};

export const loginCommand = define({
  name: "login",
  description: "Sign in securely through your browser",
  examples: "weldall login",
  run: async () => {
    const config = await resolveWeldallConfig();
    info(`Opening ${config.issuer} in your browser…`);
    const subject = await login(config);
    if (!process.stdout.isTTY) {
      success(`Logged in as ${terminalText(subject)}.`);
      return;
    }
    success("You're signed in.");
    try {
      const identity = await whoAmI(config);
      const permissions = await listScopes(config);
      console.log();
      printStatus(identity, permissions);
    } catch {
      warning("Signed in, but your account details could not be loaded.");
      console.log(`  ${dim("Run `weldall status` to try again.")}`);
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
    else console.log("You were not signed in to this Weldall host.");
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
    const identity = await whoAmI(config);
    const permissions = await listScopes(config);
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
    const identity = await whoAmI(await resolveWeldallConfig());
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
    const permissions = await listScopes(await resolveWeldallConfig());
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
  },
  examples:
    "weldall request --scope expenses:read https://expenses.example/api/expenses\n" +
    "weldall request -X POST --scope expenses:create --json '{\"amount\":24}' https://expenses.example/api/expenses\n" +
    "weldall request -X PUT --scope files:write -T ./report.pdf -H 'Content-Type: application/pdf' https://files.example/api/report.pdf\n" +
    "weldall request --scope files:read -o ./report.pdf https://files.example/api/report.pdf",
  run: async (context) => {
    const headers = parseHeaders(context.values.header);
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

const printSkills = async (asJson: boolean | undefined) => {
  const skills = await listSkills(await resolveWeldallConfig());
  if (asJson) {
    jsonOutput(skills);
    return;
  }
  if (skills.length === 0) {
    console.log("No skills are visible to this account.");
    return;
  }
  for (const skill of skills) {
    const access = skill.available ? "available" : `missing ${skill.missingScopes.join(", ")}`;
    console.log(
      `${terminalText(skill.slug)}\t${terminalText(skill.title)}\t${terminalText(access)}`,
    );
  }
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
  examples: "weldall skills show expenses.list\nweldall skills show expenses.list --json",
  run: async (context) => {
    const skill = await showSkill(await resolveWeldallConfig(), context.values.skill);
    if (context.values.json) jsonOutput(skill);
    else process.stdout.write(terminalDocument(skill.document));
  },
});

export const skillsCommand = define({
  name: "skills",
  description: "Discover agent instructions published by your organization",
  args: { json: jsonArgument },
  subCommands: { list: skillsListCommand, show: skillsShowCommand },
  run: (context) => printSkills(context.values.json),
});

const setIssuerCommand = define({
  name: "set-issuer",
  description: "Validate and save a Weldall issuer in macOS Preferences",
  args: {
    issuer: {
      type: "positional",
      description: "Weldall HTTPS origin",
    },
  },
  examples: "weldall config set-issuer https://weldall.example.com",
  run: async (context) => {
    const config = await discoverIssuer(context.values.issuer);
    await issuerPreferences.write(config.issuer);
    success(`Saved ${config.issuer}.`);
    if (process.env.WELDALL_ISSUER !== undefined)
      console.log("WELDALL_ISSUER is currently overriding this preference.");
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
      printFields([
        ["Issuer", selection.issuer],
        ["Source", selection.source],
      ]);
  },
});

const resetIssuerCommand = define({
  name: "reset-issuer",
  description: "Remove the Weldall issuer from macOS Preferences",
  run: async () => {
    await issuerPreferences.clear();
    success("Cleared the saved Weldall issuer.");
    if (process.env.WELDALL_ISSUER !== undefined)
      console.log("WELDALL_ISSUER remains active for this process.");
  },
});

export const configCommand = define({
  name: "config",
  description: "Choose which Weldall host this CLI uses",
  subCommands: {
    "set-issuer": setIssuerCommand,
    "get-issuer": getIssuerCommand,
    "reset-issuer": resetIssuerCommand,
  },
  run: () => console.log("Run `weldall config --help` to see configuration commands."),
});

export const mainCommand = define({
  name: "weldall",
  description: "Sign in securely and use your organization's APIs",
  run: () => console.log("Run `weldall status` to see your account and permissions."),
});
