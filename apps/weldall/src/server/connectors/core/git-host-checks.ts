import { db } from "@weldall/db";
import type { ConnectorActor } from "../contracts";
import { ConnectorError } from "../errors";
import type { GitHostCheck, GitHostCheckRepository } from "../git-host";
import { writeGitHostCheckAudit } from "../git-audit";
import { gitHostProvider, openGitHostWith } from "./git-hosts";
import { assertAdmin } from "./shared-connections";

export interface GitHostCheckReport {
  connector: { key: string; name: string; type: string };
  /** The existing app repository that checks needing one used; null when none exists yet. */
  repository: { owner: string; name: string } | null;
  checks: GitHostCheck[];
  summary: { pass: number; fail: number; unverifiable: number };
}

const ENABLE_HINT =
  "Set enabled: true for it in the IaC manifest and apply (or enable it in the admin UI).";

/**
 * Runs the connect checklist of a Git host connector for an administrator: the connector and its
 * shared credential here, then the host-side checks (`GitHost.checkSetup`). Read-only on the
 * host. A provisioned credential is used even while its shared connection or the connector is
 * still disabled, so an administrator can check before enabling; both are reported as failures.
 * Every run is audited (`git_host.checked`), because it uses the stored credential.
 */
export async function checkGitHostConnector({
  actor,
  connectorKey,
  signal,
}: {
  actor: ConnectorActor;
  connectorKey: string;
  signal: AbortSignal;
}): Promise<GitHostCheckReport> {
  await assertAdmin(actor);
  const started = performance.now();
  const connector = await db.connector.findUnique({ where: { key: connectorKey } });
  if (!connector) throw new ConnectorError("not_found", "Connector not found.", 404);
  const provider = gitHostProvider(connector);
  const checks: GitHostCheck[] = [
    connector.enabled
      ? {
          id: "connector",
          title: "Connector enabled",
          state: "pass",
          required: true,
          reason: `The connector "${connector.key}" is enabled.`,
          action: null,
        }
      : {
          id: "connector",
          title: "Connector enabled",
          state: "fail",
          required: true,
          reason: `The connector "${connector.key}" is disabled, so nobody can publish through it.`,
          action: `${ENABLE_HINT} The checks below run anyway.`,
        },
  ];

  const credentialed = await db.connection.findMany({
    where: { connectorId: connector.id, accessMode: "SCOPED", credentialId: { not: null } },
    orderBy: { createdAt: "asc" },
    take: 10,
  });
  const usable = credentialed.filter(({ enabled, status }) => enabled && status === "READY");
  const ready = credentialed.filter(({ status }) => status === "READY");
  // The same rule as `openGitHost`: exactly one enabled, ready shared connection.
  const connection = usable.length === 1 ? usable[0]! : ready.length === 1 ? ready[0]! : null;
  const credentialCheck = (state: "pass" | "fail", reason: string, action: string | null) =>
    checks.push({
      id: "credential",
      title: "Shared credential",
      state,
      required: true,
      reason,
      action,
    });
  if (usable.length === 1)
    credentialCheck(
      "pass",
      `The shared connection "${connection!.key ?? connection!.name}" holds the credential and is enabled.`,
      null,
    );
  else if (usable.length > 1)
    credentialCheck(
      "fail",
      `${usable.length} enabled shared connections hold a credential for this connector; Weldall uses none of them.`,
      "Keep exactly one enabled and disable or delete the others.",
    );
  else if (connection)
    credentialCheck(
      "fail",
      `The shared connection "${connection.key ?? connection.name}" holds the credential but is disabled.`,
      `${ENABLE_HINT} The checks below use its credential anyway.`,
    );
  else if (credentialed.length)
    credentialCheck(
      "fail",
      "The shared connection's credential needs to be provisioned again.",
      "Upload the credential again on the shared connection in the admin UI (Connections).",
    );
  else
    credentialCheck(
      "fail",
      "No shared connection of this connector holds a credential.",
      "Declare a shared connection for this connector in the IaC manifest (enabled: false), apply, upload the credential on it in the admin UI (Connections), then enable it.",
    );

  const app = await db.app.findFirst({
    where: { connectorId: connector.id, templateCommit: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { repositoryOwner: true, repositoryName: true, defaultBranch: true },
  });
  const repository: GitHostCheckRepository | null = app
    ? { owner: app.repositoryOwner, name: app.repositoryName, defaultBranch: app.defaultBranch }
    : null;
  const host = openGitHostWith({ provider, connector, connection });
  checks.push(...(await host.checkSetup({ repository }, signal)));

  await writeGitHostCheckAudit({
    actor,
    connectorId: connector.id,
    repository,
    checks,
    durationMs: performance.now() - started,
  });
  const count = (state: GitHostCheck["state"]) =>
    checks.filter((check) => check.state === state).length;
  return {
    connector: { key: connector.key, name: connector.name, type: connector.providerType },
    repository: repository && { owner: repository.owner, name: repository.name },
    checks,
    summary: { pass: count("pass"), fail: count("fail"), unverifiable: count("unverifiable") },
  };
}
