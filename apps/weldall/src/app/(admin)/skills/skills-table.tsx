"use client";

import { useMemo, useState } from "react";
import type { ColumnDef, SortingState, Updater } from "@tanstack/react-table";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Pagination } from "@astryxdesign/core/Pagination";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import type { SkillDto } from "@/server/admin/service";
import { useTRPC } from "@/trpc/react";
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

export function SkillsTable() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [deletingSkill, setDeletingSkill] = useState<SkillDto | null>(null);
  const [{ q, page, sort: sorting }, setTableQuery] = useQueryStates(
    {
      q: parseAsString.withDefault(""),
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
      sort: sortingToSkillSort(sorting),
    }),
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
          <div className="grid gap-1">
            <Badge
              label={row.original.source.type === "manual" ? "Manual" : row.original.source.name}
              variant={row.original.source.type === "manual" ? "neutral" : "purple"}
            />
            {row.original.source.type === "resource" ? (
              <Text color="secondary">{row.original.source.catalogState}</Text>
            ) : null}
            {row.original.overridden ? <Text color="secondary">Overridden</Text> : null}
          </div>
        ),
      },
      {
        accessorKey: "requiredScopes",
        header: "Required scopes",
        enableSorting: false,
        cell: ({ getValue, row }) => {
          const scopes = getValue<string[]>();
          return (
            <div className="grid gap-1">
              {scopes.length ? <code className="text-sm">{scopes.join(", ")}</code> : "None"}
              {row.original.scopeWarnings.map((warning) => (
                <Text key={warning} color="secondary">
                  {warning}
                </Text>
              ))}
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
            <table className="w-full min-w-[860px] border-collapse text-left">
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
                        {q ? "No skills match this search." : "No skills have been created."}
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
