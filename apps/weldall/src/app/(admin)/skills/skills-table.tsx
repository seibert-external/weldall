"use client";

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef, SortingState, Updater } from "@tanstack/react-table";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { Pagination } from "@astryxdesign/core/Pagination";
import { Selector } from "@astryxdesign/core/Selector";
import { TableBody, TableCell, TableContext, TableRow } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import type { SkillDto } from "@/server/admin/service";
import { useTRPC } from "@/trpc/react";
import { ManagementBadge } from "@/components/admin/management-badge";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import {
  isInteractiveTableTarget,
  OverflowFade,
  ResizableTableHeader,
  TableRowAction,
} from "../resizable-table";
import { createSortingParser, resolveUpdater } from "../table-state";

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
  const router = useRouter();
  const trpc = useTRPC();
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
        size: 220,
        minSize: 160,
        maxSize: 420,
        cell: ({ getValue }) => {
          const title = getValue<string>();
          return <OverflowFade title={title}>{title}</OverflowFade>;
        },
      },
      {
        accessorKey: "slug",
        header: "Skill ID",
        size: 180,
        minSize: 140,
        maxSize: 360,
        enableSorting: false,
        cell: ({ getValue }) => {
          const slug = getValue<string>();
          return (
            <OverflowFade title={slug}>
              <code className="whitespace-nowrap text-sm">{slug}</code>
            </OverflowFade>
          );
        },
      },
      {
        id: "source",
        header: "Source",
        size: 200,
        minSize: 160,
        maxSize: 380,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="grid justify-items-start gap-1">
            {row.original.source.type === "manual" ? (
              <HStack gap={2} vAlign="center">
                <Text type="body">Manual</Text>
                <ManagementBadge management={row.original.management} />
              </HStack>
            ) : (
              <div onClick={(event) => event.stopPropagation()}>
                <Button
                  href={`/resources/${row.original.source.resourceId}`}
                  label={row.original.source.name}
                  size="sm"
                  variant="ghost"
                />
              </div>
            )}
            {row.original.overridden ? <Text color="secondary">Overridden</Text> : null}
          </div>
        ),
      },
      {
        id: "catalogStatus",
        header: "Catalog status",
        size: 180,
        minSize: 150,
        maxSize: 280,
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
        size: 220,
        minSize: 170,
        maxSize: 520,
        enableSorting: false,
        cell: ({ getValue, row }) => {
          const scopes = getValue<string[]>();
          if (!scopes.length) return "None";
          return (
            <OverflowFade title={scopes.join(", ")}>
              <div className="flex w-max flex-nowrap gap-3 whitespace-nowrap">
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
            </OverflowFade>
          );
        },
      },
      {
        accessorKey: "visibility",
        header: "Visibility",
        size: 170,
        minSize: 140,
        maxSize: 260,
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
        size: 230,
        minSize: 210,
        maxSize: 360,
        cell: ({ getValue }) => (
          <time className="whitespace-nowrap">
            {dateFormatter.format(new Date(getValue<string>()))}
          </time>
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
    columnResizeMode: "onChange",
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
            dividers: "grid",
            hasHover: false,
            isStriped: false,
            textOverflow: "wrap",
            verticalAlign: "middle",
          }}
        >
          <div className="w-full overflow-x-auto" role="group" aria-label="Skills table">
            <table
              className="admin-resizable-table table-fixed border-collapse text-left"
              style={{ minWidth: "100%", width: table.getTotalSize() }}
            >
              <ResizableTableHeader table={table} />
              <TableBody>
                {table.getRowModel().rows.map((row) => {
                  const href = `/skills/${row.original.id}`;
                  return (
                    <TableRow
                      key={row.id}
                      aria-label={`Open ${row.original.title}`}
                      data-clickable="true"
                      onClick={(event) => {
                        if (isInteractiveTableTarget(event.target, event.currentTarget)) return;
                        router.push(href);
                      }}
                    >
                      {row.getVisibleCells().map((cell, index) => (
                        <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                          {index === 0 ? (
                            <TableRowAction href={href} label={`Open ${row.original.title}`}>
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </TableRowAction>
                          ) : (
                            flexRender(cell.column.columnDef.cell, cell.getContext())
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
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
    </>
  );
}

function sortingToSkillSort(sorting: SortingState) {
  const first = sorting[0] ?? { id: "title", desc: false };
  return `${first.id}.${first.desc ? "desc" : "asc"}` as
    "title.asc" | "title.desc" | "updatedAt.asc" | "updatedAt.desc";
}
