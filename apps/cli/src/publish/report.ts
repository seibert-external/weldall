import { CliError } from "../errors.js";
import { info, printFields, success, terminalText, warning } from "../output.js";
import type { ConflictChoice } from "./conflicts.js";
import { PublishError } from "./errors.js";
import type { PublishResult } from "./publish.js";
import type { AppConfirmReport, AppListReport } from "./registry.js";
import type { AppStatusReport } from "./status.js";

/** Exit codes an agent can branch on; the JSON output carries the details. */
export const PUBLISH_EXIT_CODES = { conflict: 3, refused: 4 } as const;

const CHOICES = new Set<ConflictChoice>(["folder", "local", "repo"]);

/** `--decide <path>=<folder|local|repo>`, repeatable. */
export function parseDecisions(
  values: readonly string[] | undefined,
): Record<string, ConflictChoice> {
  const decisions: Record<string, ConflictChoice> = {};
  for (const value of values ?? []) {
    const separator = value.lastIndexOf("=");
    const path = value.slice(0, separator);
    const choice = value.slice(separator + 1) as ConflictChoice;
    if (separator <= 0 || !CHOICES.has(choice))
      throw new CliError(`Invalid --decide ${value}`, {
        exitCode: 2,
        hint: "Use --decide <path>=folder|local|repo, once per conflicted file.",
      });
    decisions[path] = choice;
  }
  return decisions;
}

const list = (paths: readonly string[], limit = 20) =>
  [
    ...paths.slice(0, limit).map((path) => `  ${terminalText(path)}`),
    ...(paths.length > limit ? [`  … and ${paths.length - limit} more`] : []),
  ].join("\n");

/** The result as JSON on stdout; an error as `{ outcome: "error", error }`. */
export function publishJson(
  value:
    PublishResult | AppStatusReport | AppListReport | AppConfirmReport | PublishError | CliError,
): string {
  if (value instanceof CliError)
    return JSON.stringify(
      {
        outcome: "error",
        error: {
          code: value instanceof PublishError ? value.code : "error",
          message: value.message,
          ...(value.hint ? { hint: value.hint } : {}),
          ...(value instanceof PublishError && value.details ? { details: value.details } : {}),
        },
      },
      null,
      2,
    );
  return JSON.stringify(value, null, 2);
}

export function printPublishResult(result: PublishResult) {
  const { outcome } = result;
  if (outcome === "refused") {
    warning({
      message: `Nothing was published. These files look like secrets or data and are not sent:\n${list(
        (result.refused ?? []).map(({ path, reason }) => `${path}: ${reason}`),
      )}`,
      hint: "Remove them from the folder or add them to .gitignore, then publish again.",
    });
  } else if (outcome === "conflict") {
    const files = result.conflict?.files ?? [];
    warning({
      message: `Nothing was published: your changes and the app's repository changed the same files.\n${list(
        files.map(
          ({ path, kind, decided }) =>
            `${path} (${kind}${decided ? ", decided" : ""}): ${files.find((file) => file.path === path)!.choices.join("|")}`,
        ),
      )}`,
      hint: result.conflict?.written
        ? "The folder now holds the merge result. Resolve each file, then publish again with --decide <path>=folder|local|repo for every file listed."
        : "Publish again with --resolve to write the merge result with conflict markers into the folder.",
    });
  } else if (outcome === "published") {
    success(
      result.pullRequest?.created
        ? `Published. Pull request: ${result.pullRequest.webUrl}`
        : `Published to ${result.pullRequest ? `pull request ${result.pullRequest.webUrl}` : "the app's repository"}.`,
    );
  } else if (outcome === "nothing_to_publish") {
    info("Nothing new to publish: the app's repository already has this state.");
  } else {
    success("The folder has the app repository's current state.");
  }

  if (result.files.length)
    info(`Published files:\n${list(result.files.map(({ path, change }) => `${change} ${path}`))}`);
  const fields: Array<[string, string]> = [];
  if (result.app) fields.push(["App", `${result.app.name} (${result.app.id})`]);
  if (result.pullRequest) fields.push(["Pull request", result.pullRequest.webUrl]);
  if (result.links.preview) fields.push(["Preview", result.links.preview]);
  if (result.links.live) fields.push(["Live", result.links.live]);
  if (fields.length) printFields({ fields, title: "Publish" });
  for (const notice of result.notices)
    warning({
      message: notice.paths.length ? `${notice.message}\n${list(notice.paths)}` : notice.message,
    });
  for (const item of result.warnings) warning({ message: `Weldall: ${item.message}` });
}

const REVIEW_STATE = {
  approved: "approved",
  changes_requested: "changes requested",
  commented: "commented",
  dismissed: "dismissed",
} as const;

export function printAppStatus(status: AppStatusReport) {
  const fields: Array<[string, string]> = [["App", `${status.app.name} (${status.app.id})`]];
  const pull = status.pullRequest;
  if (pull) {
    fields.push(["Pull request", `${pull.webUrl} (${pull.state})`]);
    const failed = pull.checks.filter(({ state }) => state === "failure").length;
    const pending = pull.checks.filter(({ state }) => state === "pending").length;
    if (pull.checks.length)
      fields.push(["Checks", `${pull.checks.length} (${failed} failed, ${pending} pending)`]);
  } else fields.push(["Pull request", "none"]);
  if (status.links.preview) fields.push(["Preview", status.links.preview]);
  if (status.links.live) fields.push(["Live", status.links.live]);
  printFields({ fields, title: "App status" });
  for (const review of pull?.reviews ?? [])
    info(
      `Review by ${terminalText(review.author)} (${REVIEW_STATE[review.state]})${
        review.body ? `:\n${terminalText(review.body)}` : ""
      }`,
    );
  for (const item of status.warnings) warning({ message: `Weldall: ${item.message}` });
}

/** Readable labels of the app registry's states. */
export const APP_STATE_LABELS = {
  active: "active",
  expiring_soon: "expiring soon",
  expired: "expired",
} as const;

/** The day of an ISO timestamp, e.g. `2027-02-16`; the JSON output keeps the full timestamp. */
export const isoDay = (value: string) => value.slice(0, 10);

export function printAppConfirmed({ app }: AppConfirmReport) {
  success(
    `Confirmed ${terminalText(app.name)} (${app.id}) as still needed until ${isoDay(app.expiresAt)}.`,
  );
}
