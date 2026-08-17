"use client";

import { useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/react";
import { useOperationToast } from "../_components/use-operation-toast";
import { approvalLabel } from "./browser-connection-presentation";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

type RevocationTarget =
  | { kind: "connection"; connectionId: string; label: string }
  | { kind: "user"; userId: string; label: string }
  | { kind: "resource"; resourceId: string; label: string }
  | { kind: "origin"; origin: string; label: string };

export function BrowserConnections({
  userId,
  resourceId,
  ownerLabel,
}: {
  userId?: string;
  resourceId?: string;
  ownerLabel: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const operationToast = useOperationToast();
  const [target, setTarget] = useState<RevocationTarget | null>(null);
  const connectionsQuery = useQuery(
    trpc.admin.browserConnections.list.queryOptions({
      ...(userId ? { userId } : {}),
      ...(resourceId ? { resourceId } : {}),
      includeRevoked: true,
    }),
  );
  const revokeMutation = useMutation(
    trpc.admin.browserConnections.revoke.mutationOptions({
      onSuccess: async ({ revoked }) => {
        operationToast.success(
          revoked === 1 ? "Browser connection revoked" : `${revoked} browser connections revoked`,
          "browser-connection-revoke",
        );
        setTarget(null);
        await queryClient.invalidateQueries();
      },
      onError: async (error) => {
        operationToast.error(
          "Could not revoke browser connection",
          error,
          "browser-connection-revoke",
        );
        await queryClient.invalidateQueries();
      },
    }),
  );
  const rows = connectionsQuery.data ?? [];
  const activeCount = rows.filter((connection) => connection.state === "active").length;

  return (
    <section className="grid gap-4" aria-labelledby="browser-connections-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="m-0 text-xl font-semibold" id="browser-connections-title">
            Connected browsers
          </h2>
          <Text color="secondary">
            Sender-constrained browser sessions are separate from CLI and machine credentials.
          </Text>
        </div>
        {activeCount > 0 ? (
          <Button
            label={`Revoke all for ${ownerLabel}`}
            onClick={() =>
              setTarget(
                userId
                  ? { kind: "user", userId, label: `all browser connections for ${ownerLabel}` }
                  : {
                      kind: "resource",
                      resourceId: resourceId!,
                      label: `all browser connections for ${ownerLabel}`,
                    },
              )
            }
            type="button"
            variant="destructive"
          />
        ) : null}
      </div>
      {connectionsQuery.error ? (
        <Banner
          container="card"
          status="error"
          title="Could not load browser connections"
          description={connectionsQuery.error.message}
        />
      ) : null}
      <div className="w-full overflow-x-auto">
        <table className="w-full border-collapse text-left" aria-label="Browser connections">
          <thead>
            <tr className="border-border border-b">
              <th className="p-2">Account</th>
              <th className="p-2">Origin and resource</th>
              <th className="p-2">Created / last used</th>
              <th className="p-2">Approval</th>
              <th className="p-2">State</th>
              <th className="p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((connection) => (
              <tr className="border-border border-b align-top" key={connection.id}>
                <td className="p-2">
                  <div className="grid gap-1">
                    <span>{connection.account?.name ?? connection.subject}</span>
                    <Text color="secondary">{connection.account?.email ?? connection.subject}</Text>
                  </div>
                </td>
                <td className="p-2">
                  <div className="grid gap-1">
                    <code className="break-all text-xs">{connection.origin}</code>
                    <code className="break-all text-xs">{connection.resource}</code>
                  </div>
                </td>
                <td className="p-2">
                  <div className="grid gap-1 whitespace-nowrap">
                    <time>{dateFormatter.format(new Date(connection.createdAt))}</time>
                    <Text color="secondary">
                      {connection.lastUsedAt
                        ? dateFormatter.format(new Date(connection.lastUsedAt))
                        : "Never refreshed"}
                    </Text>
                  </div>
                </td>
                <td className="p-2">{approvalLabel(connection.approvedVia)}</td>
                <td className="p-2">
                  <Badge
                    label={connection.state === "active" ? "Active" : "Revoked"}
                    variant={connection.state === "active" ? "success" : "neutral"}
                  />
                </td>
                <td className="p-2">
                  {connection.state === "active" ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        label="Revoke connection"
                        onClick={() =>
                          setTarget({
                            kind: "connection",
                            connectionId: connection.id,
                            label: `the browser connection from ${connection.origin}`,
                          })
                        }
                        type="button"
                        variant="destructive"
                      />
                      <Button
                        label="Revoke origin"
                        onClick={() =>
                          setTarget({
                            kind: "origin",
                            origin: connection.origin,
                            label: `all browser connections at ${connection.origin}`,
                          })
                        }
                        type="button"
                        variant="secondary"
                      />
                    </div>
                  ) : connection.revokedAt ? (
                    <Text color="secondary">
                      {dateFormatter.format(new Date(connection.revokedAt))}
                    </Text>
                  ) : null}
                </td>
              </tr>
            ))}
            {!connectionsQuery.isPending && rows.length === 0 ? (
              <tr>
                <td className="p-3" colSpan={6}>
                  <Text color="secondary">No browser connections have been recorded.</Text>
                </td>
              </tr>
            ) : null}
            {connectionsQuery.isPending ? (
              <tr>
                <td className="p-3" colSpan={6}>
                  <Text color="secondary">Loading browser connections…</Text>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <AlertDialog
        actionLabel="Revoke browser connections"
        description={
          target
            ? `Revoke ${target.label}? Existing downstream access tokens retain only their short signed lifetime.`
            : "Revoke this browser connection?"
        }
        isActionLoading={revokeMutation.isPending}
        isOpen={target !== null}
        onAction={() => {
          if (!target) return;
          revokeMutation.mutate(
            target.kind === "connection"
              ? { connectionId: target.connectionId }
              : target.kind === "user"
                ? { userId: target.userId }
                : target.kind === "resource"
                  ? { resourceId: target.resourceId }
                  : { origin: target.origin },
          );
        }}
        onOpenChange={(open) => {
          if (!open && !revokeMutation.isPending) {
            revokeMutation.reset();
            setTarget(null);
          }
        }}
        title="Revoke browser connections?"
      />
    </section>
  );
}
