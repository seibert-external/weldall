import { GIT_APP_SCOPES, selectGitApp, type OpenGitApp } from "../git/git-apps.js";
import { terminalText } from "../output.js";
import { openGitAppApi, type ChecklistAnswer } from "./git-app-api.js";

/**
 * `weldall app checklist`: the administrator's set-up checklist of one Git app's Git host (App or
 * bot access, organisation, templates, reviewer team, default-branch rule, commit identity), run
 * by the Git app (`GET <origin>/api/admin/checklist`, scope `git-app:admin`). Read-only on the
 * host; the Git app records every run in Weldall's audit log.
 */

/** Exit code when a required check failed; the output lists which. */
export const CHECKLIST_FAILED_EXIT_CODE = 3;

/** What `weldall app checklist --json` prints: the Git app's report and which Git app ran it. */
export interface ChecklistReport extends ChecklistAnswer {
  gitApp: { key: string; name: string };
}

export async function readChecklist({
  gitApps,
  gitApp,
  appId,
}: {
  gitApps: OpenGitApp;
  /** The Git app's resource key; needed when Weldall lists several for the administrator. */
  gitApp?: string | undefined;
  /** A ready app of this Git app, for the checks that need a repository. */
  appId?: string | undefined;
}): Promise<ChecklistReport> {
  const api = await openGitAppApi(
    gitApps,
    (resources) => selectGitApp(resources, { key: gitApp, scope: GIT_APP_SCOPES.admin }),
    GIT_APP_SCOPES.admin,
  );
  const answer = await api.readChecklist(appId);
  return { gitApp: { key: api.gitApp.key, name: api.gitApp.name }, ...answer };
}

const LABELS = { pass: "PASS", fail: "FAIL", unverifiable: "CANNOT VERIFY" } as const;

/** One line per check, the action indented below it; Git app texts are made terminal-safe. */
export function formatChecklist(value: ChecklistReport): string {
  const width = Math.max(...Object.values(LABELS).map((label) => label.length));
  const lines = [
    `Checks for Git app "${terminalText(value.gitApp.key)}" (${terminalText(value.host.kind)}, organisation ${terminalText(value.host.organization)})`,
    value.repository
      ? `Checks that need a repository used ${terminalText(`${value.repository.owner}/${value.repository.name}`)}.`
      : "No app was named: checks that need a repository cannot be verified (add --app <id>).",
    "",
  ];
  for (const check of value.checks) {
    const title = `${terminalText(check.title)}${check.required ? "" : " (recommended)"}`;
    lines.push(`${LABELS[check.state].padEnd(width)}  ${title}: ${terminalText(check.reason)}`);
    if (check.action) lines.push(`${" ".repeat(width)}  To do: ${terminalText(check.action)}`);
  }
  const { pass, fail, unverifiable } = value.summary;
  lines.push("", `${pass} passed, ${fail} failed, ${unverifiable} cannot be verified.`);
  return lines.join("\n");
}

/** True when a required check failed; recommendations and unverifiable checks do not count. */
export const requiredCheckFailed = (value: ChecklistReport) =>
  value.checks.some((check) => check.required && check.state === "fail");
