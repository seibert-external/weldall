"use client";

import { useCallback, useMemo, useState } from "react";
import type { ColumnDef, SortingState, Updater } from "@tanstack/react-table";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { Pagination } from "@astryxdesign/core/Pagination";
import { Selector } from "@astryxdesign/core/Selector";
import {
  TableBody,
  TableCell,
  TableContext,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import type { SkillDto } from "@/server/admin/service";
import { useTRPC } from "@/trpc/react";
import { ManagementBadge } from "@/components/admin/management-badge";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { useOperationToast } from "../../_components/use-operation-toast";
import { createSortingParser, resolveUpdater, sortLabel } from "../table-state";

const sortingParser = createSortingParser(new Set(["title", "updatedAt"]), [
  { id: "title", desc: false },
]);
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
type ResourceSkillSource = Extract<SkillDto["source"], { type: "resource" }>;
const catalogStatuses: Record<
  ResourceSkillSource["catalogState"],
  {
    icon: "success" | "warning" | "error" | "info";
    color: "success" | "warning" | "error" | "accent";
    label: string;
  }
> = {
  fresh: { icon: "success", color: "success", label: "Fresh" },
  stale: { icon: "warning", color: "warning", label: "Stale" },
  failed: { icon: "error", color: "error", label: "Failed" },
  expired: { icon: "error", color: "error", label: "Expired" },
  pending: { icon: "info", color: "accent", label: "Pending" },
  disabled: { icon: "info", color: "accent", label: "Disabled" },
};

export function SkillsTable() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [deletingSkill, setDeletingSkill] = useState<SkillDto | null>(null);
  const [{ q, source, page, sort: sorting }, setTableQuery] = useQueryStates(
    {
      q: parseAsString.withDefault(""),
      source: parseAsString.withDefault(""),
      page: parseAsInteger.withDefault(1),
      sort: sortingParser,
    },
    { history: "replace", shallow: true },
  );
  const skillsQuery = useQuery(
    trpc.admin.skills.list.queryOptions({
      page,
      pageSize: 20,
      q,
      ...(source ? { source } : {}),
      sort: sortingToSkillSort(sorting),
    }),
  );
  const sourcesQuery = useQuery(trpc.admin.skills.sources.queryOptions());
  const sourceOptions = useMemo(
    () => [
      { value: "manual", label: "Manual" },
      ...(sourcesQuery.data ?? []).map((resource) => ({
        value: resource.id,
        label: resource.name,
      })),
    ],
    [sourcesQuery.data],
  );
  const changeSource = useCallback(
    async (value: string | null) => {
      await setTableQuery({ source: value, page: 1 });
    },
    [setTableQuery],
  );
  const skills = skillsQuery.data?.items ?? [];
  const columns = useMemo<ColumnDef<SkillDto>[]>(
    () => [
      {
        accessorKey: "title",
        header: "Title",
        cell: ({ getValue }) => <span className="font-medium">{getValue<string>()}</span>,
      },
      {
        accessorKey: "slug",
        header: "Skill ID",
        enableSorting: false,
        cell: ({ getValue }) => <code className="text-sm">{getValue<string>()}</code>,
      },
      {
        id: "source",
        header: "Source",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="grid justify-items-start gap-1">
            {row.original.source.type === "manual" ? (
              <HStack gap={2} vAlign="center">
                <Text type="body">Manual</Text>
                <ManagementBadge management={row.original.management} />
              </HStack>
            ) : (
              <Button
                href={`/resources/${row.original.source.resourceId}`}
                label={row.original.source.name}
                size="sm"
                variant="ghost"
              />
            )}
            {row.original.overridden ? <Text color="secondary">Overridden</Text> : null}
          </div>
        ),
      },
      {
        id: "catalogStatus",
        header: "Catalog status",
        enableSorting: false,
        cell: ({ row }) => {
          if (row.original.source.type === "manual") {
            return <Text color="secondary">Not applicable</Text>;
          }
          const status = catalogStatuses[row.original.source.catalogState];
          return (
            <HStack gap={2} vAlign="center">
              <Text type="body">{status.label}</Text>
              <Icon icon={status.icon} color={status.color} size="sm" />
            </HStack>
          );
        },
      },
      {
        accessorKey: "requiredScopes",
        header: "Required scopes",
        enableSorting: false,
        cell: ({ getValue, row }) => {
          const scopes = getValue<string[]>();
          if (!scopes.length) return "None";
          return (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {scopes.map((scope) => {
                const warning = row.original.scopeWarnings.find(
                  (candidate) => candidate === `Unknown scope: ${scope}`,
                );
                return (
                  <HStack key={scope} gap={1} vAlign="center">
                    <code className="text-sm">{scope}</code>
                    {warning ? (
                      <Tooltip content={warning} hasHoverIndication={false}>
                        <span aria-label={warning} className="inline-flex" tabIndex={0}>
                          <Icon color="warning" icon="warning" size="sm" />
                        </span>
                      </Tooltip>
                    ) : null}
                  </HStack>
                );
              })}
            </div>
          );
        },
      },
      {
        accessorKey: "visibility",
        header: "Visibility",
        enableSorting: false,
        cell: ({ getValue }) => {
          const visibility = getValue<SkillDto["visibility"]>();
          return (
            <Badge
              label={visibility === "HIDDEN_IF_UNALLOWED" ? "Hidden if unallowed" : "Default"}
              variant={visibility === "HIDDEN_IF_UNALLOWED" ? "purple" : "neutral"}
            />
          );
        },
      },
      {
        accessorKey: "updatedAt",
        header: "Updated",
        cell: ({ getValue }) => dateFormatter.format(new Date(getValue<string>())),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex justify-end gap-2">
            <Button
              href={`/skills/${row.original.id}`}
              label="Open"
              size="sm"
              variant="secondary"
            />
            {!row.original.readOnly ? (
              <Button
                label="Delete"
                onClick={() => setDeletingSkill(row.original)}
                size="sm"
                variant="destructive"
              />
            ) : null}
          </div>
        ),
      },
    ],
    [],
  );
  const table = useReactTable({
    data: skills,
    columns,
    state: { sorting },
    manualSorting: true,
    onSortingChange: (updater: Updater<SortingState>) => {
      const next = resolveUpdater(updater, sorting);
      void setTableQuery({ sort: next, page: 1 });
    },
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <>
      <HerocrumbsActions>
        <div className="admin-table-action-row">
          <TextInput
            hasClear
            isLabelHidden
            label="Find skills"
            onChange={(value) => void setTableQuery({ q: value || null, page: 1 })}
            placeholder="Find skills…"
            size="lg"
            startIcon="search"
            value={q}
            width={260}
          />
          <Selector
            hasClear
            isLabelHidden
            changeAction={changeSource}
            label="Source"
            options={sourceOptions}
            placeholder="All sources"
            value={source || null}
            width={220}
          />
          <Button href="/skills/new" label="Create skill" variant="primary" />
        </div>
      </HerocrumbsActions>

      {skillsQuery.error ? (
        <Banner
          container="card"
          status="error"
          title="Could not load skills"
          description={skillsQuery.error.message}
        />
      ) : null}
      {sourcesQuery.error ? (
        <Banner
          container="card"
          status="error"
          title="Could not load skill sources"
          description={sourcesQuery.error.message}
        />
      ) : null}

      <div>
        <TableContext.Provider
          value={{
            density: "balanced",
            dividers: "rows",
            hasHover: false,
            isStriped: false,
            textOverflow: "wrap",
            verticalAlign: "middle",
          }}
        >
          <div className="w-full overflow-x-auto" role="group" aria-label="Skills table">
            <table className="w-full min-w-[1000px] border-collapse text-left">
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id} isHeaderRow>
                    {headerGroup.headers.map((header) => {
                      const sorted = header.column.getIsSorted();
                      const label = String(header.column.columnDef.header ?? "");
                      return (
                        <TableHeaderCell
                          key={header.id}
                          scope="col"
                          aria-sort={
                            sorted ? (sorted === "asc" ? "ascending" : "descending") : undefined
                          }
                        >
                          {header.column.getCanSort() ? (
                            <button
                              className="w-full border-0 bg-transparent p-0 text-left font-[inherit] text-inherit"
                              onClick={header.column.getToggleSortingHandler()}
                              type="button"
                            >
                              {sortLabel(label, sorted)}
                            </button>
                          ) : (
                            label
                          )}
                        </TableHeaderCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {!skillsQuery.isPending && table.getRowModel().rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">
                        {q || source
                          ? "No skills match these filters."
                          : "No skills have been created."}
                      </Text>
                    </TableCell>
                  </TableRow>
                ) : null}
                {skillsQuery.isPending ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">Loading skills…</Text>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </table>
          </div>
        </TableContext.Provider>
        <div className="admin-table-footer">
          <Pagination
            label="Skill pages"
            onChange={(nextPage) => void setTableQuery({ page: nextPage })}
            page={page}
            pageSize={20}
            totalItems={skillsQuery.data?.total ?? 0}
            variant="count"
          />
        </div>
      </div>

      <DeleteSkillDialog
        skill={deletingSkill}
        onClose={() => setDeletingSkill(null)}
        onDeleted={async () => {
          setDeletingSkill(null);
          await queryClient.invalidateQueries();
        }}
      />
    </>
  );
}

function DeleteSkillDialog({
  skill,
  onClose,
  onDeleted,
}: {
  skill: SkillDto | null;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const trpc = useTRPC();
  const operationToast = useOperationToast();
  const mutation = useMutation(
    trpc.admin.skills.delete.mutationOptions({
      onSuccess: () => {
        operationToast.success("Skill deleted", "skill-delete");
        void onDeleted();
      },
      onError: (error) => operationToast.error("Could not delete skill", error, "skill-delete"),
    }),
  );
  return (
    <AlertDialog
      actionLabel="Delete skill"
      description={
        skill
          ? `Delete ${skill.title}? Agents will no longer be able to discover it.`
          : "Delete this skill?"
      }
      isActionLoading={mutation.isPending}
      isOpen={Boolean(skill)}
      onAction={() => {
        if (skill) mutation.mutate({ id: skill.id, expectedVersion: skill.version });
      }}
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) {
          mutation.reset();
          onClose();
        }
      }}
      title="Delete skill?"
    />
  );
}

function sortingToSkillSort(sorting: SortingState) {
  const first = sorting[0] ?? { id: "title", desc: false };
  return `${first.id}.${first.desc ? "desc" : "asc"}` as
    "title.asc" | "title.desc" | "updatedAt.asc" | "updatedAt.desc";
}
