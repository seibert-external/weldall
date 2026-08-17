"use client";

import { useId, useState, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import {
  TableBody,
  TableCell,
  TableContext,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { useQuery } from "@tanstack/react-query";
import type { UserAccessDto } from "@/server/admin/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { PlanetLoader } from "../../_components/planet-loader";
import { AuditEventsTable } from "../audit/audit-events-table";
import { BrowserConnections } from "../browser-connections";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "long",
  timeStyle: "short",
});

export function UserDetail({ userId }: { userId: string }) {
  const trpc = useTRPC();
  const userQuery = useQuery(trpc.admin.users.get.queryOptions({ id: userId }));

  if (userQuery.isPending) return <PlanetLoader />;
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
            <dd className="m-0 text-sm font-normal">
              {dateFormatter.format(new Date(user.createdAt))}
            </dd>
          </div>
          <div className="grid gap-1 sm:col-span-2">
            <dt className="text-xs text-[var(--color-text-secondary)]">User ID</dt>
            <dd className="m-0 break-all font-mono text-sm">{user.id}</dd>
          </div>
        </dl>
      </section>
      <hr className="border-border m-0 border-0 border-t" />
      <section className="grid gap-5" aria-labelledby="user-access-title">
        <div className="grid gap-1">
          <h2 className="m-0 text-xl font-semibold" id="user-access-title">
            Effective access
          </h2>
          <Text color="secondary">
            Computed from this person&apos;s direct email assignment and current group memberships.
            Each effective scope keeps every assignment that grants it.
          </Text>
        </div>
        {user.access.unavailableGroupProviders.length > 0 ? (
          <Banner
            container="card"
            status="warning"
            title="Some group access could not be resolved"
            description={`Access from ${user.access.unavailableGroupProviders
              .map((provider) => provider.name)
              .join(
                ", ",
              )} is omitted because the live membership lookup failed. Direct access and successfully resolved group access are still shown.`}
          />
        ) : null}
        <AccessTabs access={user.access} />
      </section>
      <hr className="border-border m-0 border-0 border-t" />
      <BrowserConnections userId={user.id} ownerLabel={user.email} />
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

type AccessTab = "scopes" | "resources" | "skills";

type AccessTableRow = {
  key: string;
  name: ReactNode;
  reason: ReactNode;
};

function AccessTabs({ access }: { access: UserAccessDto }) {
  const [activeTab, setActiveTab] = useState<AccessTab>("scopes");
  const id = useId();
  const tabId = (tab: AccessTab) => `${id}-${tab}-tab`;
  const panelId = (tab: AccessTab) => `${id}-${tab}-panel`;

  return (
    <div className="grid gap-4">
      <TabList
        aria-label="Effective access categories"
        hasDivider
        onChange={(value) => setActiveTab(value as AccessTab)}
        role="tablist"
        value={activeTab}
      >
        <Tab
          aria-controls={panelId("scopes")}
          aria-selected={activeTab === "scopes"}
          id={tabId("scopes")}
          label={`Scopes (${access.effectiveScopes.length})`}
          role="tab"
          value="scopes"
        />
        <Tab
          aria-controls={panelId("resources")}
          aria-selected={activeTab === "resources"}
          id={tabId("resources")}
          label={`Resources (${access.resources.length})`}
          role="tab"
          value="resources"
        />
        <Tab
          aria-controls={panelId("skills")}
          aria-selected={activeTab === "skills"}
          id={tabId("skills")}
          label={`Skills (${access.skills.length})`}
          role="tab"
          value="skills"
        />
      </TabList>

      <div
        aria-labelledby={tabId("scopes")}
        hidden={activeTab !== "scopes"}
        id={panelId("scopes")}
        role="tabpanel"
        tabIndex={0}
      >
        <AccessTable
          emptyMessage="No scopes are currently effective for this person."
          label="Effective scopes"
          rows={access.effectiveScopes.map((scope) => ({
            key: scope.key,
            name: <code className="text-sm">{scope.key}</code>,
            reason: scope.assignments.map(scopeAssignmentReason).join("; "),
          }))}
        />
      </div>

      <div
        aria-labelledby={tabId("resources")}
        hidden={activeTab !== "resources"}
        id={panelId("resources")}
        role="tabpanel"
        tabIndex={0}
      >
        <AccessTable
          emptyMessage="No registered resources are currently accessible."
          label="Accessible resources"
          rows={access.resources.map((resource) => ({
            key: resource.id,
            name: (
              <div className="grid justify-items-start gap-1">
                <a className="font-medium underline" href={`/resources/${resource.id}`}>
                  {resource.name}
                </a>
                <code className="text-sm">{resource.key}</code>
              </div>
            ),
            reason: `Accessible through ${resource.grantedScopes.length === 1 ? "scope" : "scopes"}: ${resource.grantedScopes.join(", ")}.`,
          }))}
        />
      </div>

      <div
        aria-labelledby={tabId("skills")}
        hidden={activeTab !== "skills"}
        id={panelId("skills")}
        role="tabpanel"
        tabIndex={0}
      >
        <AccessTable
          emptyMessage="No published skills are currently accessible."
          label="Accessible skills"
          rows={access.skills.map((skill) => ({
            key: skill.slug,
            name: (
              <div className="grid justify-items-start gap-1">
                <span className="font-medium">{skill.title}</span>
                <code className="text-sm">{skill.slug}</code>
              </div>
            ),
            reason:
              skill.requiredScopes.length === 0
                ? "Accessible because this skill requires no scopes."
                : `Accessible because all required ${skill.requiredScopes.length === 1 ? "scope is" : "scopes are"} effective: ${skill.requiredScopes.join(", ")}.`,
          }))}
        />
      </div>
    </div>
  );
}

function AccessTable({
  emptyMessage,
  label,
  rows,
}: {
  emptyMessage: string;
  label: string;
  rows: AccessTableRow[];
}) {
  return (
    <TableContext.Provider
      value={{
        density: "balanced",
        dividers: "grid",
        hasHover: false,
        isStriped: false,
        textOverflow: "wrap",
        verticalAlign: "middle",
      }}
    >
      <div className="w-full overflow-x-auto" role="group" aria-label={label}>
        <table className="w-full min-w-[640px] table-fixed border-collapse text-left">
          <colgroup>
            <col className="w-2/5" />
            <col className="w-3/5" />
          </colgroup>
          <TableHeader>
            <TableRow isHeaderRow>
              <TableHeaderCell scope="col">Name</TableHeaderCell>
              <TableHeaderCell scope="col">Reason</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell>{row.name}</TableCell>
                <TableCell>{row.reason}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={2}>
                  <Text color="secondary">{emptyMessage}</Text>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </table>
      </div>
    </TableContext.Provider>
  );
}

function scopeAssignmentReason(
  assignment: UserAccessDto["effectiveScopes"][number]["assignments"][number],
): string {
  return assignment.type === "email"
    ? `Directly assigned to ${assignment.email}`
    : `Assigned through membership in ${assignment.providerKey}/${assignment.groupId} from ${assignment.providerName}`;
}
