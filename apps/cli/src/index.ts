#!/usr/bin/env -S node --use-system-ca
import { cli } from "gunshi";
import packageJson from "../package.json" with { type: "json" };
import {
  configCommand,
  loginCommand,
  logoutCommand,
  mainCommand,
  requestCommand,
  scopesCommand,
  skillsCommand,
  statusCommand,
  whoamiCommand,
} from "./commands.js";
import { discoverIssuer, selectIssuer } from "./config.js";
import { CliError, errorMessage } from "./errors.js";
import { createHttpsDeadlineFetch } from "./http.js";
import { appendixFrame, brandHeading, printError, terminalDocument } from "./output.js";
import { getCliAppendix } from "./services/settings.js";
import { appendixCache } from "./storage/appendix.js";
import { renderFriendlyValidation } from "./validation.js";

interface LocalHeader {
  issuer: string | null;
  appendix: string;
}

async function loadLocalHeader(includeAppendix: boolean): Promise<LocalHeader> {
  try {
    const issuer = (await selectIssuer({ allowPrompt: false }))?.issuer ?? null;
    return {
      issuer,
      appendix: issuer && includeAppendix ? ((await appendixCache.read(issuer)) ?? "") : "",
    };
  } catch {
    // Help must remain available when the local configuration cannot be read.
    return { issuer: null, appendix: "" };
  }
}

async function refreshCliAppendix(issuer: string) {
  try {
    const timeoutMs = 2_500;
    const config = await discoverIssuer(issuer, {
      fetcher: createHttpsDeadlineFetch(timeoutMs),
      timeoutMs,
    });
    await appendixCache.write(issuer, await getCliAppendix(config));
  } catch {
    // The cached appendix remains usable while discovery or refresh is unavailable.
  }
}

const agentIntroduction = [
  "Agents can discover approved capabilities and access APIs with scoped credentials.",
  "Start with `weldall skills`, then use `weldall skills show <skill-id>` for instructions.",
].join("\n");

export async function runCli(argv = process.argv.slice(2)) {
  const rootHelp =
    argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"));
  let localHeader: Promise<LocalHeader> | undefined;

  try {
    await cli(argv.length === 0 ? ["--help"] : argv, mainCommand, {
      name: "weldall",
      version: packageJson.version,
      description: "Secure access to your organization's APIs",
      strict: true,
      subCommands: {
        login: loginCommand,
        logout: logoutCommand,
        status: statusCommand,
        whoami: whoamiCommand,
        scopes: scopesCommand,
        skills: skillsCommand,
        request: requestCommand,
        config: configCommand,
      },
      renderHeader: async (context) => {
        if ((context.values as Record<string, unknown>).help !== true) return "";
        localHeader ??= loadLocalHeader(rootHelp);
        const header = await localHeader;
        return [
          brandHeading(header.issuer),
          agentIntroduction,
          rootHelp ? appendixFrame(header.appendix) : "",
        ]
          .filter(Boolean)
          .join("\n\n");
      },
      renderValidationErrors: renderFriendlyValidation,
    });
  } catch (error) {
    if (error instanceof AggregateError) {
      process.exitCode = 2;
      return;
    }
    const cliError = error instanceof CliError ? error : undefined;
    printError(errorMessage(error), cliError?.hint);
    if (process.env.WELDALL_DEBUG && error instanceof Error && error.stack)
      console.error(`\n${terminalDocument(error.stack)}`);
    process.exitCode = cliError?.exitCode ?? 1;
  }

  if (rootHelp) {
    localHeader ??= loadLocalHeader(true);
    const { issuer } = await localHeader;
    if (issuer) await refreshCliAppendix(issuer);
  }
}

await runCli();
