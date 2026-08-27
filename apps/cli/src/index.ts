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
import { selectIssuer } from "./config.js";
import {
  iacImportCommand,
  iacInitCommand,
  iacPlanCommand,
  iacStateCommand,
  iacUnmanageCommand,
  iacUpCommand,
  iacValidateCommand,
} from "./iac/commands.js";
import { CliError, errorMessage } from "./errors.js";
import { brandHeading, helpHeader, printError, printWarning, terminalDocument } from "./output.js";
import { appendixCache, type CliHeaderSnapshot } from "./storage/appendix.js";
import { keychain, type StoredIdentity } from "./storage/keychain.js";
import { installTestHttpBridge } from "./test-http-bridge.js";
import { runTestRuntimeHook } from "./test-runtime.js";
import { phaseTiming, timingNow } from "./timing.js";
import { runUpdateCheck } from "./update-check.js";
import { printFriendlyValidation } from "./validation.js";

interface LocalHeader extends CliHeaderSnapshot {
  issuer: string | null;
  identity: StoredIdentity | null;
}

const emptySnapshot = (): CliHeaderSnapshot => ({ appendix: "", scopes: [], skills: [] });

async function loadLocalHeader(includeAppendix: boolean): Promise<LocalHeader> {
  try {
    const issuer = (await selectIssuer({ allowPrompt: false }))?.issuer ?? null;
    if (!issuer) return { issuer: null, identity: null, ...emptySnapshot() };
    const credentials = await keychain.get(issuer).catch(() => null);
    const identity = credentials?.identity ?? null;
    const snapshot = includeAppendix
      ? await appendixCache
          .readSnapshotForSubject(issuer, identity?.subject ?? null)
          .catch(() => null)
      : null;
    return {
      issuer,
      identity,
      ...(snapshot ?? emptySnapshot()),
    };
  } catch {
    // Help must remain available when the local configuration cannot be read.
    return { issuer: null, identity: null, ...emptySnapshot() };
  }
}

async function notifyUpdateAvailable() {
  const advice = await runUpdateCheck({ currentVersion: packageJson.version }).catch(() => null);
  if (advice) printWarning(advice.message, advice.hint);
}

export async function runCli(argv = process.argv.slice(2)) {
  const totalStartedAt = timingNow();
  const normalizedArgv =
    argv[0] === "skills" &&
    argv[1] !== undefined &&
    !argv[1].startsWith("-") &&
    !["list", "show", "find"].includes(argv[1])
      ? ["skills", "show", ...argv.slice(1)]
      : argv;
  const rootHelp =
    normalizedArgv.length === 0 ||
    (normalizedArgv.length === 1 && (normalizedArgv[0] === "--help" || normalizedArgv[0] === "-h"));
  const iacCommand = ["init", "validate", "plan", "up", "import", "unmanage", "state"].includes(
    normalizedArgv[0] ?? "",
  );
  let localHeader: Promise<LocalHeader> | undefined;

  try {
    installTestHttpBridge();
    if (await runTestRuntimeHook()) return;
    await cli(normalizedArgv.length === 0 ? ["--help"] : normalizedArgv, mainCommand, {
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
        init: iacInitCommand,
        validate: iacValidateCommand,
        plan: iacPlanCommand,
        up: iacUpCommand,
        import: iacImportCommand,
        unmanage: iacUnmanageCommand,
        state: iacStateCommand,
      },
      renderHeader: async (context) => {
        if ((context.values as Record<string, unknown>).help !== true) return "";
        if (iacCommand) return "";
        localHeader ??= loadLocalHeader(rootHelp);
        const header = await localHeader;
        if (rootHelp)
          return helpHeader(
            header.issuer,
            header.identity,
            header.appendix,
            header.scopes,
            header.skills,
          );
        return brandHeading(header.issuer, header.identity);
      },
      renderValidationErrors: null,
    });
  } catch (error) {
    if (error instanceof AggregateError) {
      printFriendlyValidation(error);
      process.exitCode = 2;
      phaseTiming("total", totalStartedAt);
      await notifyUpdateAvailable();
      return;
    }
    const cliError = error instanceof CliError ? error : undefined;
    printError(errorMessage(error), cliError?.hint);
    if (process.env.WELDALL_DEBUG && error instanceof Error && error.stack)
      console.error(`\n${terminalDocument(error.stack)}`);
    process.exitCode = cliError?.exitCode ?? 1;
  }
  phaseTiming("total", totalStartedAt);
  await notifyUpdateAvailable();
}

await runCli();
