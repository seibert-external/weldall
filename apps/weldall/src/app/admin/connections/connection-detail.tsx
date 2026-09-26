"use client";

import { useState, type ReactNode } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { PlanetLoader } from "../../_components/planet-loader";
import { useOperationToast } from "../../_components/use-operation-toast";
import { connectionStatuses, type ConnectionRow } from "./connection-view";

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" });
const formatDate = (value: string | Date | null) =>
  value ? dateFormatter.format(new Date(value)) : "Never";

export function ConnectionDetail({ connectionId }: { connectionId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const operationToast = useOperationToast();
  const connectionQuery = useQuery(
    trpc.admin.managed.connection.queryOptions({ id: connectionId }),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [removed, setRemoved] = useState(false);
  const remove = useMutation(
    trpc.admin.managed.deleteConnection.mutationOptions({
      onSuccess: async () => {
        setConfirmDelete(false);
        setRemoved(true);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.admin.managed.connections.queryKey() }),
          queryClient.invalidateQueries({
            queryKey: trpc.admin.managed.connection.queryKey({ id: connectionId }),
          }),
        ]);
      },
      onError: async (error) => {
        operationToast.error("Could not delete connection", error, "connection-delete");
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.admin.managed.connection.queryKey({ id: connectionId }),
          }),
          queryClient.invalidateQueries({ queryKey: trpc.admin.managed.connections.queryKey() }),
        ]);
      },
    }),
  );

  return (
    <>
      <HerocrumbsActions>
        <Button href="/admin/connections" label="Back to connections" variant="secondary" />
        {!removed && connectionQuery.data && !connectionQuery.error ? (
          <Button
            label="Delete connection"
            variant="destructive"
            isLoading={remove.isPending}
            onClick={() => setConfirmDelete(true)}
          />
        ) : null}
      </HerocrumbsActions>
      {removed ? (
        <Banner
          container="card"
          status="warning"
          title="Connection deleted from Weldall"
          description="The connection, linked authorization attempts and stored credentials have been deleted. Provider access was not revoked. Remove access in your provider's account settings if needed; Weldall can no longer revoke it."
        />
      ) : connectionQuery.isPending ? (
        <PlanetLoader />
      ) : connectionQuery.error ? (
        <Banner
          container="card"
          status="error"
          title={
            connectionQuery.error.data?.code === "NOT_FOUND"
              ? "Connection not found"
              : "Could not load connection"
          }
          description={connectionQuery.error.message}
        />
      ) : (
        <ConnectionSummary connection={connectionQuery.data} />
      )}
      <AlertDialog
        isOpen={confirmDelete}
        title="Delete connection?"
        actionLabel="Delete connection"
        description={`Permanently delete ${connectionQuery.data?.name ?? "this connection"}, its authorization attempts and stored credentials from Weldall? This does not revoke provider access. Ask the owner to disconnect first, or remove access in the provider's account settings. Removing the OAuth application may affect other users and applications; existing tokens may remain valid according to the provider's policies. In-flight requests may still finish.`}
        isActionLoading={remove.isPending}
        onAction={() => remove.mutate({ id: connectionId })}
        onOpenChange={(open) => {
          if (!remove.isPending) setConfirmDelete(open);
        }}
      />
    </>
  );
}

/** Read-only, credential-free details shared by the page and rendering tests. */
export function ConnectionSummary({ connection }: { connection: ConnectionRow }) {
  return (
    <>
      <section className="grid gap-4" aria-labelledby="connection-detail-title">
        <div className="grid gap-1">
          <h2 className="m-0 text-xl font-semibold" id="connection-detail-title">
            {connection.name}
          </h2>
          <Text color="secondary">{connection.accountName}</Text>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge {...connectionStatuses[connection.status]} />
          {!connection.connectorEnabled ? (
            <Badge label="Connector disabled" variant="warning" />
          ) : null}
        </div>
        {connection.revocationError ? (
          <Banner
            container="card"
            status="warning"
            title="Disconnect needs attention"
            description={connection.revocationError}
          />
        ) : null}
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DetailValue label="Owner">
            <a
              className="underline"
              href={`/admin/users/${encodeURIComponent(connection.ownerId)}`}
            >
              {connection.owner.name ?? connection.owner.email}
            </a>
            <div>{connection.owner.email}</div>
          </DetailValue>
          <DetailValue label="Connector">
            <a className="underline" href="/admin/connectors">
              {connection.connectorKey}
            </a>
          </DetailValue>
          <DetailValue label="Connection ID">
            <code>{connection.id}</code>
          </DetailValue>
          <DetailValue label="Provider account ID">
            <code>{connection.accountId}</code>
          </DetailValue>
        </dl>
      </section>
      <hr className="border-border m-0 border-0 border-t" />
      <section className="grid gap-4" aria-labelledby="connection-usage-title">
        <h2 className="m-0 text-xl font-semibold" id="connection-usage-title">
          Usage
        </h2>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <DetailValue label="Request dispatches">
            {connection.requestCount.toLocaleString()}
          </DetailValue>
          <DetailValue label="Last used">{formatDate(connection.lastUsedAt)}</DetailValue>
          <DetailValue label="Created">{formatDate(connection.createdAt)}</DetailValue>
          <DetailValue label="Updated">{formatDate(connection.updatedAt)}</DetailValue>
        </dl>
      </section>
      <hr className="border-border m-0 border-0 border-t" />
      <section className="grid gap-4" aria-labelledby="connection-access-title">
        <h2 className="m-0 text-xl font-semibold" id="connection-access-title">
          Effective access
        </h2>
        <Text color="secondary">
          {connection.connectorEnabled && connection.status === "READY"
            ? "Ready connections may call operations authorized by the provider's granted permissions, within the connector's request restrictions."
            : "No access is currently available."}
        </Text>
        <div className="grid gap-6 lg:grid-cols-2">
          <ScopeList
            title="Selected permissions"
            scopes={connection.selectedScopes}
            labels={connection.scopeLabels}
          />
          <ScopeList
            title="Granted permissions"
            scopes={connection.grantedScopes}
            labels={connection.scopeLabels}
          />
        </div>
      </section>
    </>
  );
}

function DetailValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-1">
      <dt className="text-secondary text-xs">{label}</dt>
      <dd className="m-0 break-all text-sm">{children}</dd>
    </div>
  );
}

function ScopeList({
  title,
  scopes,
  labels,
}: {
  title: string;
  scopes: string[];
  labels: Record<string, string>;
}) {
  return (
    <section className="grid content-start gap-3" aria-label={title}>
      <h3 className="m-0 font-semibold">
        {title} ({scopes.length})
      </h3>
      {scopes.length ? (
        <ul className="m-0 grid list-none gap-3 p-0">
          {scopes.map((scope) => (
            <li key={scope} className="grid gap-1">
              <span>{labels[scope] ?? scope}</span>
              <code className="text-secondary break-all text-xs">{scope}</code>
            </li>
          ))}
        </ul>
      ) : (
        <Text color="secondary">None</Text>
      )}
    </section>
  );
}
