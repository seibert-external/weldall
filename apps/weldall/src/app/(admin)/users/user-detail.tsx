"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { AuditEventsTable } from "../audit/audit-events-table";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "long",
  timeStyle: "short",
});

export function UserDetail({ userId }: { userId: string }) {
  const trpc = useTRPC();
  const userQuery = useQuery(trpc.admin.users.get.queryOptions({ id: userId }));

  if (userQuery.isPending) return <Text color="secondary">Loading user…</Text>;
  if (userQuery.error) {
    return (
      <Banner
        container="card"
        status="error"
        title="Could not load user"
        description={userQuery.error.message}
      />
    );
  }

  const user = userQuery.data;
  return (
    <>
      <HerocrumbsActions>
        <Button href="/users" label="Back to users" variant="secondary" />
      </HerocrumbsActions>
      <section className="grid gap-4" aria-labelledby="user-detail-title">
        <div className="grid gap-1">
          <h2 className="m-0 text-xl font-semibold" id="user-detail-title">
            {user.name}
          </h2>
          <Text color="secondary">{user.email}</Text>
        </div>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-1">
            <dt className="text-xs text-[var(--color-text-secondary)]">Identity</dt>
            <dd className="m-0">
              <Badge
                label={user.emailVerified ? "Verified" : "Unverified"}
                variant={user.emailVerified ? "success" : "warning"}
              />
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-xs text-[var(--color-text-secondary)]">First signed in</dt>
            <dd className="m-0">{dateFormatter.format(new Date(user.createdAt))}</dd>
          </div>
          <div className="grid gap-1 sm:col-span-2">
            <dt className="text-xs text-[var(--color-text-secondary)]">User ID</dt>
            <dd className="m-0 break-all font-mono text-sm">{user.id}</dd>
          </div>
        </dl>
      </section>
      <hr className="border-border m-0 border-0 border-t" />
      <section className="grid gap-4" aria-labelledby="user-audit-title">
        <div className="grid gap-1">
          <h2 className="m-0 text-xl font-semibold" id="user-audit-title">
            Audit activity
          </h2>
          <Text color="secondary">
            Events performed by this user and scope changes affecting their assignment.
          </Text>
        </div>
        <AuditEventsTable userId={user.id} />
      </section>
    </>
  );
}
