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
import { animateBrandLine, brandLine, printError, terminalDocument } from "./output.js";
import { getCliAppendix } from "./services/settings.js";
import { renderFriendlyValidation } from "./validation.js";

async function loadCliAppendix() {
  try {
    const selection = await selectIssuer({ allowPrompt: false });
    if (!selection) return "";
    const config = await discoverIssuer(selection.issuer, { timeoutMs: 1_500 });
    return terminalDocument(await getCliAppendix(config)).trim();
  } catch {
    // Help must remain available while signed out, offline, or before initial configuration.
    return "";
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const animateHeader = argv.length === 0;
  const rootHelp =
    argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"));
  const appendix = rootHelp ? loadCliAppendix() : Promise.resolve("");
  let headerAnimated = false;

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
        if (animateHeader && !headerAnimated) {
          headerAnimated = true;
          await animateBrandLine();
        }
        return [brandLine(), await appendix].filter(Boolean).join("\n\n");
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
}

await runCli();
