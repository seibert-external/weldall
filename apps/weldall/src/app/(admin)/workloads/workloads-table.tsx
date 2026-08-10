"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";

export function WorkloadsTable() {
  const trpc = useTRPC();
  const query = useQuery(trpc.admin.workloadClients.list.queryOptions());
  return (
    <>
      <HerocrumbsActions>
        <Button href="/workloads/new" label="Register workload" variant="primary" />
      </HerocrumbsActions>
      {query.error ? (
        <Banner
          container="card"
          status="error"
          title="Could not load workloads"
          description={query.error.message}
        />
      ) : null}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b">
              <th className="p-3">Name</th>
              <th className="p-3">Client ID</th>
              <th className="p-3">Status</th>
              <th className="p-3">Keys</th>
              <th className="p-3">Grants</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {(query.data ?? []).map((client) => (
              <tr className="border-b" key={client.id}>
                <td className="p-3 font-medium">{client.name}</td>
                <td className="p-3">
                  <code>{client.clientId}</code>
                </td>
                <td className="p-3">
                  <Badge
                    label={client.enabled ? "Enabled" : "Deactivated"}
                    variant={client.enabled ? "neutral" : "purple"}
                  />
                </td>
                <td className="p-3">{client.keys.filter((key) => !key.revokedAt).length}</td>
                <td className="p-3">{client.grants.filter((grant) => grant.enabled).length}</td>
                <td className="p-3 text-right">
                  <Button
                    href={`/workloads/${client.id}`}
                    label="Open"
                    size="sm"
                    variant="secondary"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!query.isPending && !query.data?.length ? (
        <Text color="secondary">No workload clients are registered.</Text>
      ) : null}
    </>
  );
}
