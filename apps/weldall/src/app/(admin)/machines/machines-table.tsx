"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
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
import { ManagementBadge } from "@/components/admin/management-badge";
import type { MachineClientDto } from "@/server/machines/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";

export function MachinesTable() {
  const trpc = useTRPC();
  const [search, setSearch] = useState("");
  const machinesQuery = useQuery(trpc.admin.machineClients.list.queryOptions());
  const machines = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return machinesQuery.data ?? [];
    return (machinesQuery.data ?? []).filter(
      (machine) =>
        machine.name.toLocaleLowerCase().includes(needle) ||
        machine.clientId.toLocaleLowerCase().includes(needle),
    );
  }, [machinesQuery.data, search]);
  const columns = useMemo<ColumnDef<MachineClientDto>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row, getValue }) => (
          <div className="grid gap-1">
            <span className="font-medium">{getValue<string>()}</span>
            <ManagementBadge management={row.original.management} />
          </div>
        ),
      },
      {
        accessorKey: "clientId",
        header: "Client ID",
        cell: ({ getValue }) => <code className="text-sm">{getValue<string>()}</code>,
      },
      {
        accessorKey: "enabled",
        header: "Status",
        cell: ({ getValue }) => (
          <Badge
            label={getValue<boolean>() ? "Enabled" : "Deactivated"}
            variant={getValue<boolean>() ? "success" : "purple"}
          />
        ),
      },
      {
        id: "keys",
        header: "Active keys",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.keys.filter((key) => !key.revokedAt).length.toLocaleString()}
          </span>
        ),
      },
      {
        id: "resources",
        header: "Resources",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.access.resourceIds.length.toLocaleString()}
          </span>
        ),
      },
      {
        id: "scopes",
        header: "Scopes",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.access.scopeIds.length.toLocaleString()}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button
              href={`/machines/${row.original.id}`}
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
    data: machines,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <>
      <HerocrumbsActions>
        <div className="admin-table-action-row">
          <TextInput
            hasClear
            isLabelHidden
            label="Find machines"
            onChange={setSearch}
            placeholder="Find machines…"
            size="lg"
            startIcon="search"
            value={search}
            width={280}
          />
          <Button href="/machines/new" label="Register machine" variant="primary" />
        </div>
      </HerocrumbsActions>

      {machinesQuery.error ? (
        <Banner
          container="card"
          description={machinesQuery.error.message}
          status="error"
          title="Could not load machines"
        />
      ) : null}

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
        <div className="w-full overflow-x-auto" role="group" aria-label="Machines table">
          <table className="w-full min-w-[820px] border-collapse text-left">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} isHeaderRow>
                  {headerGroup.headers.map((header) => (
                    <TableHeaderCell key={header.id} scope="col">
                      {String(header.column.columnDef.header ?? "")}
                    </TableHeaderCell>
                  ))}
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
              {!machinesQuery.isPending && table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>
                    <Text color="secondary">
                      {search
                        ? "No machines match this search."
                        : "No machine clients are registered."}
                    </Text>
                  </TableCell>
                </TableRow>
              ) : null}
              {machinesQuery.isPending ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>
                    <Text color="secondary">Loading machines…</Text>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </table>
        </div>
      </TableContext.Provider>
    </>
  );
}
