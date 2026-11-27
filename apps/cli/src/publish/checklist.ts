import { selectRegistry, type OpenRegistry } from "../git/registries.js";
import { terminalText } from "../output.js";
import { openRegistryApi, type ChecklistAnswer, type RegistryApiOptions } from "./registry-api.js";

/**
 * `weldall app checklist`: the administrator's set-up checklist of a registry's Git host (the
 * GitHub App's key and installation, permissions, templates, reviewer team, default-branch rule,
 * commit identity), run by the registry (`GET <api>/admin/checklist`, its administration
 * permission). Read-only on the host; with auditing on, the registry records every run in
 * Weldall's audit log.
 */

/** Exit code when a required check failed; the output lists which. */
export const CHECKLIST_FAILED_EXIT_CODE = 3;

/** What `weldall app checklist --json` prints: the registry's report and which registry ran it. */
export interface ChecklistReport extends ChecklistAnswer {
  registry: { key: string; name: string };
}

export async function readChecklist({
  registries,
  registry,
  appId,
  ...options
}: RegistryApiOptions & {
  registries: OpenRegistry;
  /** The registry's resource key; needed when Weldall lists several for the administrator. */
  registry?: string | undefined;
  /** An app of this registry, for the checks that need a repository. */
  appId?: string | undefined;
}): Promise<ChecklistReport> {
  const api = await openRegistryApi(
    registries,
    (found) => selectRegistry(found, { key: registry, need: "admin-changes" }),
    "admin-changes",
    options,
  );
  const answer = await api.readChecklist(appId);
  return { registry: { key: api.registry.key, name: api.registry.name }, ...answer };
}

const LABELS = { pass: "PASS", fail: "FAIL", unverifiable: "CANNOT VERIFY" } as const;

/** One line per check, the action indented below it; registry texts are made terminal-safe. */
export function formatChecklist(value: ChecklistReport): string {
  const width = Math.max(...Object.values(LABELS).map((label) => label.length));
  const lines = [
    `Checks for registry "${terminalText(value.registry.key)}" (${terminalText(value.host.kind)}, organisation ${terminalText(value.host.organization)})`,
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
