"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { TableBody, TableCell, TableContext, TableRow } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { ManagementBadge } from "@/components/admin/management-badge";
import type { MachineClientDto } from "@/server/machines/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { isInteractiveTableTarget, OverflowFade, ResizableTableHeader, TableRowAction } from "../resizable-table";

export function MachinesTable() {
  const router = useRouter();
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
        size: 320,
        minSize: 180,
        maxSize: 520,
        cell: ({ row, getValue }) => {
          const name = getValue<string>();
          return (
            <OverflowFade title={name}>
              <div className="flex w-max flex-nowrap items-center gap-2 whitespace-nowrap">
                <span>{name}</span>
                <ManagementBadge management={row.original.management} />
              </div>
            </OverflowFade>
          );
        },
      },
      {
        accessorKey: "clientId",
        header: "Client ID",
        size: 360,
        minSize: 220,
        maxSize: 620,
        cell: ({ getValue }) => {
          const clientId = getValue<string>();
          return (
            <OverflowFade title={clientId}>
              <code className="whitespace-nowrap text-sm">{clientId}</code>
            </OverflowFade>
          );
        },
      },
      {
        accessorKey: "enabled",
        header: "Status",
        size: 160,
        minSize: 120,
        maxSize: 220,
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
        size: 180,
        minSize: 130,
        maxSize: 240,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.keys.filter((key) => !key.revokedAt).length.toLocaleString()}
          </span>
        ),
      },
      {
        id: "resources",
        header: "Resources",
        size: 190,
        minSize: 130,
        maxSize: 260,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.access.resourceIds.length.toLocaleString()}
          </span>
        ),
      },
      {
        id: "scopes",
        header: "Scopes",
        size: 190,
        minSize: 130,
        maxSize: 260,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.access.scopeIds.length.toLocaleString()}
          </span>
        ),
      },
    ],
    [],
  );
  const table = useReactTable({
    data: machines,
    columns,
    enableSorting: false,
    columnResizeMode: "onChange",
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
          dividers: "grid",
          hasHover: false,
          isStriped: false,
          textOverflow: "wrap",
          verticalAlign: "middle",
        }}
      >
        <div className="w-full overflow-x-auto" role="group" aria-label="Machines table">
          <table
            className="admin-resizable-table table-fixed border-collapse text-left"
            style={{ minWidth: "100%", width: table.getTotalSize() }}
          >
            <ResizableTableHeader table={table} />
            <TableBody>
              {table.getRowModel().rows.map((row) => {
                const href = `/machines/${row.original.id}`;
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
                        ) : flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
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
