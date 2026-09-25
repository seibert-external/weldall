"use client";

import { useState, type ReactNode } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { scopeCatalog } from "@/server/connectors/providers/google/setup";
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
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [removed, setRemoved] = useState<{ revocationConfirmed: boolean } | null>(null);
  const disconnect = useMutation(
    trpc.admin.managed.disconnect.mutationOptions({
      onSuccess: async (result) => {
        setConfirmDisconnect(false);
        setRemoved(result);
        await queryClient.invalidateQueries({
          queryKey: trpc.admin.managed.connections.queryKey(),
        });
      },
      onError: async (error) => {
        operationToast.error("Could not finish disconnecting", error, "connection-disconnect");
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
            label="Disconnect"
            variant="destructive"
            isLoading={disconnect.isPending}
            onClick={() => setConfirmDisconnect(true)}
          />
        ) : null}
      </HerocrumbsActions>
      {removed ? (
        <Banner
          container="card"
          status={removed.revocationConfirmed ? "success" : "warning"}
          title="Connection removed from Weldall"
          description={
            removed.revocationConfirmed
              ? "The connection and its stored tokens have been deleted."
              : "Google access could not be confirmed revoked. Remove the app's access in Google account settings. The local connection and tokens have been deleted, so Weldall cannot retry revocation."
          }
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
        isOpen={confirmDisconnect}
        title="Disconnect and remove connection?"
        actionLabel="Disconnect"
        description={`Permanently remove ${connectionQuery.data?.name ?? "this connection"} and its stored tokens? Weldall will try to revoke Google access, but will delete the local connection even if revocation fails. In that case, remove access in Google account settings. Revocation may affect other connections using the same Google account and OAuth client.`}
        isActionLoading={disconnect.isPending}
        onAction={() => disconnect.mutate({ id: connectionId })}
        onOpenChange={(open) => {
          if (!disconnect.isPending) setConfirmDisconnect(open);
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
          <DetailValue label="Google account ID">
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
            ? "Ready connections may call any operation Google authorizes with these exact scopes on reviewed Google API origins."
            : "No access is currently available."}
        </Text>
        <div className="grid gap-6 lg:grid-cols-2">
          <ScopeList title="Selected permissions" scopes={connection.selectedScopes} />
          <ScopeList title="Granted by Google" scopes={connection.grantedScopes} />
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

function ScopeList({ title, scopes }: { title: string; scopes: string[] }) {
  return (
    <section className="grid content-start gap-3" aria-label={title}>
      <h3 className="m-0 font-semibold">
        {title} ({scopes.length})
      </h3>
      {scopes.length ? (
        <ul className="m-0 grid list-none gap-3 p-0">
          {scopes.map((scope) => {
            const descriptor = scopeCatalog.find((item) => item.id === scope);
            return (
              <li key={scope} className="grid gap-1">
                <span>{descriptor?.label ?? scope}</span>
                <code className="text-secondary break-all text-xs">{scope}</code>
              </li>
            );
          })}
        </ul>
      ) : (
        <Text color="secondary">None</Text>
      )}
    </section>
  );
}
