"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminPersonalConnectionDto } from "@/server/connectors/admin-service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions, HerocrumbsTitle } from "../../_components/herocrumbs";
import { useOperationToast } from "../../_components/use-operation-toast";
import { AuditEventsTable } from "../audit/audit-events-table";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "long",
  timeStyle: "short",
});

type Status = AdminPersonalConnectionDto["status"];

export function ConnectionDetail({ connectionId }: { connectionId: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useOperationToast();
  const [isDisconnectOpen, setIsDisconnectOpen] = useState(false);
  const query = useQuery(trpc.admin.connections.get.queryOptions({ id: connectionId }));
  const disconnectMutation = useMutation(
    trpc.admin.connections.disconnect.mutationOptions({
      onSuccess: async () => {
        toast.success("Connection disconnected", "connection-disconnect");
        await queryClient.invalidateQueries();
        router.push("/admin/connections");
      },
      onError: (error) =>
        toast.error("Could not request disconnect", error, "connection-disconnect"),
    }),
  );

  if (query.isPending) return <Text color="secondary">Loading connection…</Text>;
  if (query.error) {
    return (
      <Banner
        container="card"
        description={query.error.message}
        status="error"
        title="Could not load connection"
      />
    );
  }

  const connection = query.data;

  return (
    <>
      <HerocrumbsTitle title={connection.name} />
      <HerocrumbsActions>
        <Button
          label="Disconnect"
          onClick={() => setIsDisconnectOpen(true)}
          variant="destructive"
        />
        <Button href="/admin/connections" label="Back to connections" variant="secondary" />
      </HerocrumbsActions>

      <section className="grid gap-4" aria-labelledby="connection-detail-title">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="m-0 text-xl font-semibold" id="connection-detail-title">
              {connection.name}
            </h2>
            <Badge
              label={statusLabel(connection.status)}
              variant={statusVariant(connection.status)}
            />
          </div>
          <Text color="secondary">{statusDescription(connection.status)}</Text>
        </div>

        <DetailSection title="Identity and ownership">
          <Detail label="Connection ID" mono value={connection.id} />
          <Detail
            label="Owner"
            value={
              <span>
                {connection.owner.name} · {connection.owner.email}
              </span>
            }
          />
          <Detail label="Owner ID" mono value={connection.owner.id} />
          <Detail label="Device binding" mono value={connection.deviceId} />
        </DetailSection>

        <DetailSection title="Provider">
          <Detail
            label="Connector"
            value={`${connection.connector.name} (${connection.connector.key})`}
          />
          <Detail label="Connector ID" mono value={connection.connector.id} />
          <Detail label="Google account" value={connection.accountDisplayName} />
          <Detail label="Provider account ID" mono value={connection.providerAccountId} />
          <Detail label="Credential location" value="Local on the bound device" />
        </DetailSection>

        <DetailSection title="Granted access">
          <Detail
            label="Enabled APIs"
            value={connection.enabledApis.map(apiLabel).join(", ") || "None"}
          />
          <Detail
            label="Granted scopes"
            value={
              connection.grantedScopes.length > 0 ? (
                <ul className="m-0 grid list-none gap-1 p-0">
                  {connection.grantedScopes.map((scope) => (
                    <li className="break-all font-mono text-sm" key={scope}>
                      {scope}
                    </li>
                  ))}
                </ul>
              ) : (
                "None"
              )
            }
          />
        </DetailSection>

        <DetailSection title="Lifecycle">
          <Detail label="Created" value={formatDate(connection.createdAt)} />
          <Detail label="Updated" value={formatDate(connection.updatedAt)} />
          <Detail label="Connected" value={formatDate(connection.connectedAt)} />
          <Detail label="Last lease" value={formatDate(connection.lastLeaseAt)} />
          <Detail label="Record version" value={String(connection.version)} />
        </DetailSection>
      </section>

      <section className="grid gap-4" aria-labelledby="connection-audit-title">
        <div className="grid gap-1">
          <h2 className="m-0 text-xl font-semibold" id="connection-audit-title">
            Audit activity
          </h2>
          <Text color="secondary">
            Authorization, credential, lease, and lifecycle events for this connection.
          </Text>
        </div>
        <AuditEventsTable subjectId={connection.id} subjectType="connection" />
      </section>

      <AlertDialog
        actionLabel="Request disconnect"
        description={`Disconnect ${connection.name}? Weldall will delete the connection and stop issuing leases immediately. Credentials on an offline device cannot be removed automatically; revoke the grant in Google if provider-side revocation is required.`}
        isActionLoading={disconnectMutation.isPending}
        isOpen={isDisconnectOpen}
        onAction={() =>
          disconnectMutation.mutate({
            id: connection.id,
            expectedVersion: connection.version,
          })
        }
        onOpenChange={(open) => {
          if (!disconnectMutation.isPending) setIsDisconnectOpen(open);
        }}
        title="Disconnect connection?"
      />
    </>
  );
}

function DetailSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="border-border grid gap-3 border-t pt-4">
      <h3 className="m-0 text-base font-semibold">{title}</h3>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</dl>
    </section>
  );
}

function Detail({
  label,
  mono = false,
  value,
}: {
  label: string;
  mono?: boolean;
  value: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1">
      <dt className="text-xs text-[var(--color-text-secondary)]">{label}</dt>
      <dd className={`m-0 break-words text-sm ${mono ? "font-mono" : "font-normal"}`}>{value}</dd>
    </div>
  );
}

function formatDate(value: string | null) {
  return value ? dateFormatter.format(new Date(value)) : "Never";
}

function statusLabel(status: Status) {
  const labels: Record<Status, string> = {
    ready: "Ready",
    reconnect_required: "Reconnect required",
  };
  return labels[status];
}

function statusVariant(status: Status): "success" | "warning" | "neutral" {
  return status === "ready" ? "success" : "warning";
}

function statusDescription(status: Status) {
  const descriptions: Record<Status, string> = {
    ready: "The connection can receive leases for its granted Google APIs.",
    reconnect_required:
      "The stored Google credentials stopped working and must be authorized again.",
  };
  return descriptions[status];
}

function apiLabel(value: string) {
  return value === "gmail" ? "Gmail" : value === "calendar" ? "Google Calendar" : value;
}
