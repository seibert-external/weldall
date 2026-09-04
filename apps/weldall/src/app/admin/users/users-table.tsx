"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef, SortingState, Updater } from "@tanstack/react-table";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Pagination } from "@astryxdesign/core/Pagination";
import { TableBody, TableCell, TableContext, TableRow } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import type { UserDto } from "@/server/admin/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import {
  isInteractiveTableTarget,
  OverflowFade,
  ResizableTableHeader,
  TableRowAction,
} from "../resizable-table";
import { createSortingParser, resolveUpdater } from "../table-state";

const PAGE_SIZE = 200;
const sortingParser = createSortingParser(new Set(["name", "email", "createdAt"]), [
  { id: "createdAt", desc: true },
]);
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const emptyUsers: UserDto[] = [];

export function UsersTable() {
  const router = useRouter();
  const trpc = useTRPC();
  const [{ q, page, sort: sorting }, setTableQuery] = useQueryStates(
    {
      q: parseAsString.withDefault(""),
      page: parseAsInteger.withDefault(1),
      sort: sortingParser,
    },
    { history: "replace", shallow: true },
  );
  const usersQuery = useQuery(
    trpc.admin.users.list.queryOptions({
      page,
      pageSize: PAGE_SIZE,
      q,
      sort: sortingToUserSort(sorting),
    }),
  );
  const users = usersQuery.data?.items ?? emptyUsers;
  const columns = useMemo<ColumnDef<UserDto>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        size: 340,
        minSize: 180,
        maxSize: 520,
        cell: ({ getValue }) => {
          const name = getValue<string>();
          return <OverflowFade title={name}>{name}</OverflowFade>;
        },
      },
      {
        accessorKey: "email",
        header: "Email",
        size: 500,
        minSize: 240,
        maxSize: 760,
        cell: ({ getValue }) => {
          const email = getValue<string>();
          return <OverflowFade title={email}>{email}</OverflowFade>;
        },
      },
      {
        accessorKey: "emailVerified",
        header: "Identity",
        size: 200,
        minSize: 140,
        maxSize: 260,
        enableSorting: false,
        cell: ({ getValue }) => (
          <Badge
            label={getValue<boolean>() ? "Verified" : "Unverified"}
            variant={getValue<boolean>() ? "success" : "warning"}
          />
        ),
      },
      {
        accessorKey: "createdAt",
        header: "First signed in",
        size: 360,
        minSize: 220,
        maxSize: 460,
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
    data: users,
    columns,
    state: { sorting },
    manualSorting: true,
    columnResizeMode: "onChange",
    onSortingChange: (updater: Updater<SortingState>) => {
      void setTableQuery({ sort: resolveUpdater(updater, sorting), page: 1 });
    },
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <>
      <HerocrumbsActions>
        <TextInput
          hasClear
          isLabelHidden
          label="Find users"
          onChange={(value) => void setTableQuery({ q: value || null, page: 1 })}
          placeholder="Find users…"
          size="lg"
          startIcon="search"
          value={q}
          width={280}
        />
      </HerocrumbsActions>
      {usersQuery.error ? (
        <Banner
          container="card"
          status="error"
          title="Could not load users"
          description={usersQuery.error.message}
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
          <div className="w-full overflow-x-auto" role="group" aria-label="Users table">
            <table
              className="admin-resizable-table table-fixed border-collapse text-left"
              style={{ minWidth: "100%", width: table.getTotalSize() }}
            >
              <ResizableTableHeader table={table} />
              <TableBody>
                {table.getRowModel().rows.map((row) => {
                  const href = `/admin/users/${encodeURIComponent(row.original.id)}`;
                  return (
                    <TableRow
                      key={row.id}
                      aria-label={`Open ${row.original.name}`}
                      data-clickable="true"
                      onClick={(event) => {
                        if (isInteractiveTableTarget(event.target, event.currentTarget)) return;
                        router.push(href);
                      }}
                    >
                      {row.getVisibleCells().map((cell, index) => (
                        <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                          {index === 0 ? (
                            <TableRowAction href={href} label={`Open ${row.original.name}`}>
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
                {!usersQuery.isPending && table.getRowModel().rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">
                        {q
                          ? "No people match this search."
                          : "No people are known to this server yet."}
                      </Text>
                    </TableCell>
                  </TableRow>
                ) : null}
                {usersQuery.isPending ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">Loading people…</Text>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </table>
          </div>
        </TableContext.Provider>
        <div className="admin-table-footer">
          <Pagination
            label="User pages"
            onChange={(nextPage) => void setTableQuery({ page: nextPage })}
            page={page}
            pageSize={PAGE_SIZE}
            totalItems={usersQuery.data?.total ?? 0}
            variant="count"
          />
        </div>
      </div>
    </>
  );
}

function sortingToUserSort(sorting: SortingState) {
  const first = sorting[0] ?? { id: "createdAt", desc: true };
  return `${first.id}.${first.desc ? "desc" : "asc"}` as
    "name.asc" | "name.desc" | "email.asc" | "email.desc" | "createdAt.asc" | "createdAt.desc";
}
