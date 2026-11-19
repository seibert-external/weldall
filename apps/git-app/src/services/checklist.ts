import { appIdSchema } from "@weldall/sdk";
import { authorizePerson } from "../access.js";
import { auditList } from "../audit.js";
import { GitAppError } from "../errors.js";
import type { GitHostCheck, GitHostCheckRepository } from "../hosts/git-host.js";
import type { HostKind } from "../hosts/index.js";
import { lookupApp } from "../weldall.js";
import type { GitAppServices, Person } from "./context.js";

export interface ChecklistReport {
  host: { kind: HostKind; organization: string };
  /** The existing app repository that checks needing one used; null when none was named. */
  repository: { owner: string; name: string } | null;
  checks: GitHostCheck[];
  summary: { pass: number; fail: number; unverifiable: number };
}

const checkId = /^[a-z0-9._-]{1,120}$/;

/**
 * Runs the set-up checklist of this instance's Git host for an administrator
 * (`weldall app checklist`). The host secret's format is validated at start; whether the host
 * accepts it is one of the checks. Checks
 * that need an existing repository use the app named by `appId` (any ready app of this resource),
 * otherwise they report that they cannot be verified yet. Read-only on the host. Every run is
 * audited (`git_host.checked`), because it uses the host secret; when Weldall does not store the
 * entry, the report is withheld (503).
 */
export async function runChecklist({
  services,
  person,
  appId,
  signal,
}: {
  services: GitAppServices;
  person: Person;
  appId?: string | undefined;
  signal: AbortSignal;
}): Promise<ChecklistReport> {
  await authorizePerson(services.weldall, person.id, [services.scopes.admin]);
  const started = performance.now();
  let repository: GitHostCheckRepository | null = null;
  if (appId !== undefined) {
    const found = appIdSchema.safeParse(appId).success
      ? await lookupApp(services.weldall, { app: { id: appId } })
      : null;
    if (!found) throw new GitAppError("not_found", "No app of this Git app has this id.", 404);
    if (!found.app.ready)
      throw new GitAppError(
        "repository_not_ready",
        "The app's repository is still being created; name a ready app.",
        409,
      );
    repository = {
      owner: found.app.repository.owner,
      name: found.app.repository.name,
      defaultBranch: found.app.defaultBranch,
    };
  }
  const checks = await services.host.host.checkSetup({ repository }, signal);
  const count = (state: GitHostCheck["state"]) =>
    checks.filter((check) => check.state === state).length;
  const summary = { pass: count("pass"), fail: count("fail"), unverifiable: count("unverifiable") };
  await services.audit.success({
    eventType: "git_host.checked",
    subject: person.id,
    repository: repository && { owner: repository.owner, name: repository.name },
    details: {
      passed: summary.pass,
      failed: summary.fail,
      unverifiable: summary.unverifiable,
      failedChecks: auditList(
        checks.filter(({ state, id }) => state === "fail" && checkId.test(id)).map(({ id }) => id),
        "checks",
      ),
      durationMs: Math.round(performance.now() - started),
    },
  });
  return {
    host: { kind: services.host.kind, organization: services.host.organization },
    repository: repository && { owner: repository.owner, name: repository.name },
    checks,
    summary,
  };
}
