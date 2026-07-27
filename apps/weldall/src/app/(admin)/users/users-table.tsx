"use client";

import { useMemo } from "react";
import type { ColumnDef, SortingState, Updater } from "@tanstack/react-table";
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
import { useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import type { UserDto } from "@/server/admin/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { createSortingParser, resolveUpdater, sortLabel } from "../table-state";

const PAGE_SIZE = 20;
const sortingParser = createSortingParser(new Set(["name", "email", "createdAt"]), [
  { id: "createdAt", desc: true },
]);
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function UsersTable() {
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
  const users = usersQuery.data?.items ?? [];
  const columns = useMemo<ColumnDef<UserDto>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ getValue }) => <span className="font-medium">{getValue<string>()}</span>,
      },
      {
        accessorKey: "email",
        header: "Email",
      },
      {
        accessorKey: "emailVerified",
        header: "Identity",
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
        cell: ({ getValue }) => (
          <time className="whitespace-nowrap">
            {dateFormatter.format(new Date(getValue<string>()))}
          </time>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button
              href={`/users/${encodeURIComponent(row.original.id)}`}
              label="Open"
              size="sm"
              variant="secondary"
            />
          </div>
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
            dividers: "rows",
            hasHover: false,
            isStriped: false,
            textOverflow: "wrap",
            verticalAlign: "middle",
          }}
        >
          <div className="w-full overflow-x-auto" role="group" aria-label="Users table">
            <table className="w-full min-w-[800px] border-collapse text-left">
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
                {!usersQuery.isPending && table.getRowModel().rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">
                        {q ? "No users match this search." : "No users have signed in yet."}
                      </Text>
                    </TableCell>
                  </TableRow>
                ) : null}
                {usersQuery.isPending ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">Loading users…</Text>
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
