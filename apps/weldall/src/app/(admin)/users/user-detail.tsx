"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { useQuery } from "@tanstack/react-query";
import type { UserAccessDto } from "@/server/admin/service";
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
        <AccessScopes scopes={user.access.effectiveScopes} />
        <div className="grid gap-5 lg:grid-cols-2">
          <AccessResources resources={user.access.resources} />
          <AccessSkills skills={user.access.skills} />
        </div>
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

function AccessScopes({ scopes }: { scopes: UserAccessDto["effectiveScopes"] }) {
  return (
    <div className="grid gap-3" aria-labelledby="effective-scopes-title">
      <h3 className="m-0 text-base font-semibold" id="effective-scopes-title">
        Effective scopes
      </h3>
      {scopes.length === 0 ? (
        <Text color="secondary">No scopes are currently effective for this person.</Text>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {scopes.map((scope) => (
            <li className="border-border grid gap-2 rounded-md border p-3" key={scope.key}>
              <div>
                <Badge
                  label={scope.key}
                  variant={scope.key === "weldall:administer" ? "purple" : "neutral"}
                />
              </div>
              <div className="grid gap-1 text-sm">
                <Text color="secondary">Granted by</Text>
                <ul className="m-0 grid gap-1 pl-5">
                  {scope.assignments.map((assignment) => (
                    <li key={`${assignment.type}:${assignment.id}`}>
                      {assignment.type === "email" ? (
                        <>
                          <a className="underline" href={`/assignments/${assignment.id}`}>
                            Direct email assignment
                          </a>{" "}
                          for <code>{assignment.email}</code>
                        </>
                      ) : (
                        <>
                          <a className="underline" href={`/group-assignments/${assignment.id}`}>
                            Group assignment
                          </a>{" "}
                          <code>
                            {assignment.providerKey}/{assignment.groupId}
                          </code>{" "}
                          from {assignment.providerName}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AccessResources({ resources }: { resources: UserAccessDto["resources"] }) {
  return (
    <div className="grid content-start gap-3" aria-labelledby="accessible-resources-title">
      <h3 className="m-0 text-base font-semibold" id="accessible-resources-title">
        Accessible resources
      </h3>
      {resources.length === 0 ? (
        <Text color="secondary">No registered resources are currently accessible.</Text>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {resources.map((resource) => (
            <li className="border-border grid gap-2 rounded-md border p-3" key={resource.id}>
              <div>
                <a className="font-medium underline" href={`/resources/${resource.id}`}>
                  {resource.name}
                </a>{" "}
                <code className="text-sm">{resource.key}</code>
              </div>
              <BadgeList label="Granted scopes" values={resource.grantedScopes} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AccessSkills({ skills }: { skills: UserAccessDto["skills"] }) {
  return (
    <div className="grid content-start gap-3" aria-labelledby="accessible-skills-title">
      <h3 className="m-0 text-base font-semibold" id="accessible-skills-title">
        Accessible skills
      </h3>
      {skills.length === 0 ? (
        <Text color="secondary">No published skills are currently accessible.</Text>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {skills.map((skill) => (
            <li className="border-border grid gap-2 rounded-md border p-3" key={skill.slug}>
              <div>
                <span className="font-medium">{skill.title}</span>{" "}
                <code className="text-sm">{skill.slug}</code>
              </div>
              <Text color="secondary">
                {skill.source.type === "admin"
                  ? "Administrator-managed skill"
                  : `Published by ${skill.source.name} (${skill.source.key})`}
              </Text>
              {skill.requiredScopes.length > 0 ? (
                <BadgeList label="Required scopes" values={skill.requiredScopes} />
              ) : (
                <Text color="secondary">No scopes required</Text>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BadgeList({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="grid gap-1">
      <Text color="secondary">{label}</Text>
      <div className="flex flex-wrap gap-1">
        {values.map((value) => (
          <Badge key={value} label={value} />
        ))}
      </div>
    </div>
  );
}
