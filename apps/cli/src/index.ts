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
import { brandHeading, helpHeader, printError, terminalDocument } from "./output.js";
import { whoAmI } from "./services/auth.js";
import { listScopes } from "./services/resources.js";
import { getCliAppendix } from "./services/settings.js";
import { listSkills } from "./services/skills.js";
import {
  appendixCache,
  type CachedSkillPreview,
  type CliHeaderSnapshot,
} from "./storage/appendix.js";
import { keychain, type StoredIdentity } from "./storage/keychain.js";
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
    const [snapshot, credentials] = await Promise.all([
      includeAppendix
        ? appendixCache.readSnapshot(issuer).catch(() => null)
        : Promise.resolve(null),
      keychain.get(issuer).catch(() => null),
    ]);
    return {
      issuer,
      identity: credentials?.identity ?? null,
      ...(snapshot ?? emptySnapshot()),
    };
  } catch {
    // Help must remain available when the local configuration cannot be read.
    return { issuer: null, identity: null, ...emptySnapshot() };
  }
}

async function refreshCliHeader(issuer: string) {
  try {
    const timeoutMs = 2_500;
    const config = await discoverIssuer(issuer, {
      fetcher: createHttpsDeadlineFetch(timeoutMs),
      timeoutMs,
    });
    const snapshot = (await appendixCache.readSnapshot(issuer)) ?? emptySnapshot();
    const appendix = await getCliAppendix(config).catch(() => snapshot.appendix);
    await whoAmI(config).catch(() => undefined);
    const scopes = await listScopes(config)
      .then((result) => result.assignedScopes)
      .catch(() => snapshot.scopes);
    const skills = await listSkills(config)
      .then((result): CachedSkillPreview[] =>
        result.items.map(({ slug, title, available }) => ({ slug, title, available })),
      )
      .catch(() => snapshot.skills);
    await appendixCache.writeSnapshot(issuer, { appendix, scopes, skills });
  } catch {
    // The cached appendix remains usable while discovery or refresh is unavailable.
  }
}

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
    if (issuer) await refreshCliHeader(issuer);
  }
}

await runCli();
