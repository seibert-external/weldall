import { define } from "gunshi";
import { resolveWeldallConfig } from "./config.js";
import { CliError } from "./errors.js";
import { runGitCredentialHelper } from "./git/credential-helper.js";
import { directOpenRegistry, directWeldallAccess } from "./git/weldall-access.js";
import { info, palette, printWideUi, TableCard, terminalText, type TableColumn } from "./output.js";
import {
  assignOwner,
  confirmMyApp,
  listAllApps,
  listMyApps,
  type AdminAppListReport,
  type AppListReport,
} from "./publish/apps.js";
import {
  CHECKLIST_FAILED_EXIT_CODE,
  formatChecklist,
  readChecklist,
  requiredCheckFailed,
} from "./publish/checklist.js";
import { publishApp, type PublishOptions } from "./publish/publish.js";
import { APP_STATES, type AppState } from "./publish/registry-api.js";
import {
  parseDecisions,
  printAppConfirmed,
  printAppStatus,
  printOwnerAssigned,
  printPublishResult,
  PUBLISH_EXIT_CODES,
  publishJson,
  reviewText,
} from "./publish/report.js";
import { readAppStatus } from "./publish/status.js";

/**
 * `weldall app …` (singular): create, publish and look after one's own apps through the
 * organisation's registry, and `weldall git-credential`, the helper git runs for the registry's
 * git route. `weldall apps` (plural, `commands.tsx`) only lists the apps shared with a person
 * from Weldall.
 */

const jsonArgument = {
  type: "boolean",
  description: "Print machine-readable JSON instead of explanatory text",
} as const;

const registryArgument = (description: string) => ({ type: "string" as const, description });

export const gitCredentialCommand = define({
  name: "git-credential",
  description:
    "Git credential helper for the git route of your organisation's app registry; git runs it, not people",
  args: {
    operation: {
      type: "positional",
      required: true,
      description: "Operation from git: get, store, or erase (store and erase do nothing)",
    },
  },
  examples:
    "git config credential.https://registry.example.com/git/.helper '!weldall git-credential'",
  // stdout belongs to git's credential protocol: no Ink output, no colors, no notices.
  run: (context) =>
    runGitCredentialHelper({
      operation: context.values.operation,
      input: process.stdin,
      output: process.stdout,
      errors: process.stderr,
      environment: process.env,
      weldall: directWeldallAccess(),
    }),
});

const publishFolderArguments = {
  dir: {
    type: "string",
    description:
      "The app's folder (top level of its git repository); defaults to the current folder",
  },
  resolve: {
    type: "boolean",
    description:
      "On conflict, write the merge result with conflict markers into the folder so they can be resolved",
  },
  decide: {
    type: "string",
    multiple: true,
    description:
      "After --resolve: `<path>=folder|local|repo` for each conflicted file; repeat per file",
  },
  json: jsonArgument,
} as const;

/** Prints a CLI error as JSON on stdout when --json asked for it; otherwise lets it through. */
function failAsJson(json: boolean | undefined, error: unknown) {
  if (!json || !(error instanceof CliError)) throw error;
  console.log(publishJson(error));
  process.exitCode = error.exitCode;
}

/** Runs publish or sync and prints the result; with --json also errors become JSON on stdout. */
async function runPublishCommand(
  values: { dir?: string | undefined; json?: boolean | undefined; decide?: string[] | undefined },
  options: Omit<PublishOptions, "directory" | "registries" | "decisions">,
) {
  try {
    const result = await publishApp({
      ...options,
      directory: values.dir ?? process.cwd(),
      decisions: parseDecisions(values.decide),
      registries: directOpenRegistry(await resolveWeldallConfig()),
    });
    if (values.json) console.log(publishJson(result));
    else printPublishResult(result);
    if (result.outcome === "conflict") process.exitCode = PUBLISH_EXIT_CODES.conflict;
    if (result.outcome === "refused") process.exitCode = PUBLISH_EXIT_CODES.refused;
  } catch (error) {
    failAsJson(values.json, error);
  }
}

const appPublishCommand = define({
  name: "publish",
  description:
    "Publish the app folder: create the app on first use, merge its repository's state, push one commit and open or update the pull request",
  args: {
    ...publishFolderArguments,
    name: { type: "string", description: "App name (first publish only)" },
    description: {
      type: "string",
      description: "What the app is for, in a sentence or two (first publish only)",
    },
    share: {
      type: "string",
      multiple: true,
      description:
        "First publish only: a permission whose holders see the app (one you hold yourself, see `weldall scopes`); repeat for more. Without it only you see the app",
    },
    url: {
      type: "string",
      description: "First publish only: https link to the running app",
    },
    template: {
      type: "string",
      description: "Template name, when the folder does not record it in `weldall.template`",
    },
    registry: registryArgument(
      "Resource key of the registry to create the app in, when Weldall lists more than one (first publish only)",
    ),
    title: { type: "string", description: "Pull request title" },
    body: { type: "string", description: "Pull request description" },
  },
  examples:
    'weldall app publish --name "Travel expenses" --description "Submit and track travel expense claims" --json\n' +
    'weldall app publish --name "Travel expenses" --description "Track claims" --share sales:member --json\n' +
    "weldall app publish --title 'Add receipt upload' --json\n" +
    "weldall app publish --resolve --json\n" +
    "weldall app publish --decide src/total.ts=folder --decide logo.png=repo --json\n" +
    "If creating the app stops (a timeout, a busy registry), run the same command again: it continues with the same app.",
  run: ({ values }) =>
    runPublishCommand(values, {
      resolve: values.resolve ?? false,
      app: {
        ...(values.name === undefined ? {} : { name: values.name }),
        ...(values.description === undefined ? {} : { description: values.description }),
        ...(values.template === undefined ? {} : { template: values.template }),
        ...(values.registry === undefined ? {} : { registry: values.registry }),
        ...(values.share === undefined ? {} : { scopes: values.share }),
        ...(values.url === undefined ? {} : { url: values.url }),
      },
      pullRequest: {
        ...(values.title === undefined ? {} : { title: values.title }),
        ...(values.body === undefined ? {} : { body: values.body }),
      },
    }),
});

const appSyncCommand = define({
  name: "sync",
  description:
    "Bring the app repository's current state into the folder without publishing anything",
  args: publishFolderArguments,
  examples: "weldall app sync --json\nweldall app sync --resolve --json",
  run: ({ values }) =>
    runPublishCommand(values, { syncOnly: true, resolve: values.resolve ?? false }),
});

const appStatusCommand = define({
  name: "status",
  description:
    "Show the app's pull request with its reviews and checks, and the preview and live links",
  args: {
    dir: publishFolderArguments.dir,
    app: { type: "string", description: "App id; reads that app instead of the folder's" },
    registry: registryArgument(
      "With --app: resource key of the registry that keeps it; by default the CLI asks every registry you can use",
    ),
    json: jsonArgument,
  },
  examples: "weldall app status --json\nweldall app status --app app_3f2a9c0d1e4b5a6f7081 --json",
  run: async ({ values }) => {
    try {
      const status = await readAppStatus({
        directory: values.dir ?? process.cwd(),
        ...(values.app === undefined ? {} : { appId: values.app }),
        ...(values.registry === undefined ? {} : { registry: values.registry }),
        registries: directOpenRegistry(await resolveWeldallConfig()),
      });
      if (values.json) console.log(publishJson(status));
      else printAppStatus(status);
    } catch (error) {
      failAsJson(values.json, error);
    }
  },
});

/** Prints a command's JSON on stdout; with --json also its CLI errors become JSON. */
async function runAppJsonCommand<T>(
  json: boolean | undefined,
  operation: () => Promise<T>,
  print: (value: T) => void,
  after?: (value: T) => void,
) {
  try {
    const value = await operation();
    if (json) console.log(JSON.stringify(value, null, 2));
    else print(value);
    after?.(value);
  } catch (error) {
    failAsJson(json, error);
  }
}

const appListColumns = [
  { header: "App" },
  { header: "Review" },
  { header: "Repository" },
  { header: "ID" },
] satisfies readonly TableColumn[];

const reviewColor = (value: string) =>
  value.startsWith("review due since")
    ? palette.danger
    : value.startsWith("review by") && value.includes("(soon)")
      ? palette.warning
      : undefined;

const reviewCell = (app: { state: AppState; expiresAt: string }) =>
  `${reviewText(app)}${app.state === "expiring_soon" ? " (soon)" : ""}`;

const nameCell = (app: { name: string; removedAt: string | null }) =>
  `${app.name}${app.removedAt ? " (not listed)" : ""}`;

function printAppList(report: AppListReport) {
  if (report.apps.length === 0) {
    info(
      "You have no apps of your own in a registry yet. `weldall app publish` creates one; `weldall apps` lists the apps shared with you.",
    );
    return;
  }
  printWideUi(
    <TableCard
      title="Your apps"
      columns={appListColumns}
      rows={report.apps.map((app) => [
        nameCell(app),
        reviewCell(app),
        app.repository?.name ?? "none",
        app.id,
      ])}
      cellColor={(_rowIndex, columnIndex, value) =>
        columnIndex === 1 ? reviewColor(value) : undefined
      }
    />,
  );
  if (report.apps.some((app) => app.removedAt))
    info(
      "Apps marked (not listed) are not shown to others at the moment: their weldall-app.yml is missing or invalid, or their repository is archived or out of reach. Publishing a fix brings them back.",
    );
  if (report.apps.some((app) => app.state !== "active"))
    info(
      `Apps must be confirmed as still needed every ${report.reverificationDays} days. Run \`weldall app confirm <id>\` for each app that is still in use; a due review is only flagged, the app keeps working.`,
    );
}

const adminColumns = [
  { header: "App" },
  { header: "Owner" },
  { header: "Review" },
  { header: "Repository" },
  { header: "ID" },
] satisfies readonly TableColumn[];

function printAllApps(report: AdminAppListReport) {
  if (report.apps.length === 0) {
    info("The registry has no apps that match.");
    return;
  }
  printWideUi(
    <TableCard
      title={`All apps of ${terminalText(report.registry)} (page ${report.page}, ${report.apps.length} of ${report.total})`}
      columns={adminColumns}
      rows={report.apps.map((app) => [
        nameCell(app),
        app.owner ?? "no owner",
        reviewCell(app),
        app.repository?.name ?? "none",
        app.id,
      ])}
      cellColor={(_rowIndex, columnIndex, value) =>
        columnIndex === 1 && value === "no owner"
          ? palette.warning
          : columnIndex === 2
            ? reviewColor(value)
            : undefined
      }
    />,
  );
  if (report.page * report.pageSize < report.total)
    info(`More apps: add --page ${report.page + 1}.`);
  if (report.apps.some((app) => app.owner === null))
    info(
      "An app without an owner cannot be confirmed or published to. Assign one with `weldall app set-owner <id> --owner <Weldall user id>`.",
    );
}

const positiveInteger = (value: string | undefined, name: string) => {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,5}$/.test(value))
    throw new CliError(`--${name} must be a positive whole number`, { exitCode: 2 });
  return Number(value);
};

const appListCommand = define({
  name: "list",
  description:
    "List your own apps in each registry you can use, with their review date; administrators add --all for every app",
  args: {
    registry: registryArgument("Lists only the apps of this registry (resource key)"),
    all: {
      type: "boolean",
      description:
        "Administrators: every app of one registry, also those without an owner, the ones to confirm first",
    },
    state: {
      type: "string",
      description:
        "With --all: only apps in this review state: active, expiring_soon (review due soon) or expired (review due)",
    },
    withoutOwner: {
      type: "boolean",
      toKebab: true,
      description: "With --all: only apps without an owner",
    },
    page: { type: "string", description: "With --all: page number (default 1)" },
    pageSize: {
      type: "string",
      toKebab: true,
      description: "With --all: apps per page (1 to 200, default 50)",
    },
    json: jsonArgument,
  },
  examples:
    "weldall app list\nweldall app list --json\nweldall app list --all --without-owner\nweldall app list --all --state expired --json",
  run: ({ values }) => {
    if (values.all)
      return runAppJsonCommand(
        values.json,
        async () => {
          const state = values.state;
          if (state !== undefined && !(APP_STATES as readonly string[]).includes(state))
            throw new CliError(`--state must be one of ${APP_STATES.join(", ")}`, { exitCode: 2 });
          const page = positiveInteger(values.page, "page");
          const pageSize = positiveInteger(values.pageSize, "page-size");
          return listAllApps({
            registries: directOpenRegistry(await resolveWeldallConfig()),
            ...(values.registry === undefined ? {} : { registry: values.registry }),
            ...(state === undefined ? {} : { state: state as AppState }),
            ...(values.withoutOwner ? { ownerless: true } : {}),
            ...(page === undefined ? {} : { page }),
            ...(pageSize === undefined ? {} : { pageSize }),
          });
        },
        printAllApps,
      );
    return runAppJsonCommand(
      values.json,
      async () => {
        if (
          values.state !== undefined ||
          values.withoutOwner ||
          values.page !== undefined ||
          values.pageSize !== undefined
        )
          throw new CliError("--state, --without-owner, --page and --page-size need --all", {
            exitCode: 2,
          });
        return listMyApps({
          registries: directOpenRegistry(await resolveWeldallConfig()),
          ...(values.registry === undefined ? {} : { registry: values.registry }),
        });
      },
      printAppList,
    );
  },
});

const appConfirmCommand = define({
  name: "confirm",
  description:
    "Confirm that one of your apps is still needed; its next review moves 90 days ahead. Publishing does not do this",
  args: {
    app: {
      type: "positional",
      required: false,
      description: "App id from `weldall app list`; defaults to the app of --dir",
    },
    dir: publishFolderArguments.dir,
    registry: registryArgument(
      "With an app id: resource key of the registry that keeps it; by default the CLI asks every registry you can use",
    ),
    json: jsonArgument,
  },
  examples: "weldall app confirm app_3f2a9c0d1e4b5a6f7081\nweldall app confirm --json",
  run: ({ values }) =>
    runAppJsonCommand(
      values.json,
      async () =>
        confirmMyApp({
          directory: values.dir ?? process.cwd(),
          ...(values.app === undefined ? {} : { appId: values.app }),
          ...(values.registry === undefined ? {} : { registry: values.registry }),
          registries: directOpenRegistry(await resolveWeldallConfig()),
        }),
      printAppConfirmed,
    ),
});

const appSetOwnerCommand = define({
  name: "set-owner",
  description:
    "Administrators: assign or change the owner of an app (for example one the registry found in a repository); its review date does not move",
  args: {
    app: {
      type: "positional",
      required: true,
      description: "App id from `weldall app list --all`",
    },
    owner: {
      type: "string",
      required: true,
      description:
        "The new owner's Weldall user id (they see it with `weldall whoami --json`); they need the permission to publish apps",
    },
    registry: registryArgument(
      "Resource key of the registry that keeps the app, when Weldall lists more than one for you",
    ),
    json: jsonArgument,
  },
  examples: "weldall app set-owner app_3f2a9c0d1e4b5a6f7081 --owner user_123 --json",
  run: ({ values }) =>
    runAppJsonCommand(
      values.json,
      async () =>
        assignOwner({
          registries: directOpenRegistry(await resolveWeldallConfig()),
          appId: values.app,
          owner: values.owner,
          ...(values.registry === undefined ? {} : { registry: values.registry }),
        }),
      printOwnerAssigned,
    ),
});

const appChecklistCommand = define({
  name: "checklist",
  description:
    "Administrators: run the registry's set-up checklist against its Git host (access, permissions, templates, reviewer team, branch rule, commit identity); changes nothing",
  args: {
    registry: registryArgument(
      "Resource key of the registry to check, when Weldall lists more than one for you",
    ),
    app: {
      type: "string",
      description: "Id of an app of this registry, for the checks that need a repository",
    },
    json: jsonArgument,
  },
  examples:
    "weldall app checklist\nweldall app checklist --app app_3f2a9c0d1e4b5a6f7081 --json\n" +
    `Exits with ${CHECKLIST_FAILED_EXIT_CODE} when a required check failed.`,
  run: ({ values }) =>
    runAppJsonCommand(
      values.json,
      async () =>
        readChecklist({
          registries: directOpenRegistry(await resolveWeldallConfig()),
          registry: values.registry,
          appId: values.app,
        }),
      (report) => console.log(formatChecklist(report)),
      (report) => {
        if (requiredCheckFailed(report)) process.exitCode = CHECKLIST_FAILED_EXIT_CODE;
      },
    ),
});

export const appCommand = define({
  name: "app",
  description:
    "Create and publish your own apps through your organisation's registry, without a Git account (`weldall apps` lists the apps shared with you)",
  subCommands: {
    publish: appPublishCommand,
    sync: appSyncCommand,
    status: appStatusCommand,
    list: appListCommand,
    confirm: appConfirmCommand,
    "set-owner": appSetOwnerCommand,
    checklist: appChecklistCommand,
  },
  run: () =>
    info(
      "Run `weldall app publish --help`, `sync --help`, `status --help`, `list --help`, `confirm --help`, `set-owner --help` or `checklist --help`. `weldall apps` lists the apps shared with you.",
    ),
});
