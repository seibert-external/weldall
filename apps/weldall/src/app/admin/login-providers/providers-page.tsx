"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { TableBody, TableCell, TableContext, TableRow } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import type { LoginProviderDto } from "@/server/admin/login-providers";
import { buttonForeground } from "@/server/auth/oidc-config";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import {
  isInteractiveTableTarget,
  OverflowFade,
  ResizableTableHeader,
  TableRowAction,
} from "../resizable-table";
import { api } from "./oidc-admin-api";

const emptyLoginProviders: LoginProviderDto[] = [];

export function LoginProvidersPage() {
  const router = useRouter();
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const providersQuery = useQuery({
    queryKey: ["admin", "login-providers"],
    queryFn: async () => (await api("admin-providers")).providers as LoginProviderDto[],
  });
  const providers = providersQuery.data ?? emptyLoginProviders;

  const columns = useMemo<ColumnDef<LoginProviderDto>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Provider",
        size: 320,
        minSize: 200,
        maxSize: 480,
        cell: ({ row, getValue }) => {
          const name = getValue<string>();
          return (
            <OverflowFade title={name}>
              <div className="flex w-max flex-nowrap items-center gap-2 whitespace-nowrap">
                <span>{name}</span>
                <span
                  className="rounded px-2 py-1"
                  style={{
                    background: row.original.buttonColor,
                    color: buttonForeground(row.original.buttonColor),
                  }}
                >
                  {row.original.buttonLabel}
                </span>
              </div>
            </OverflowFade>
          );
        },
      },
      {
        accessorKey: "issuer",
        header: "Issuer",
        size: 400,
        minSize: 220,
        maxSize: 640,
        cell: ({ getValue }) => {
          const issuer = getValue<string>();
          return (
            <OverflowFade title={issuer}>
              <code className="whitespace-nowrap text-sm">{issuer}</code>
            </OverflowFade>
          );
        },
      },
      {
        accessorKey: "enabled",
        header: "Status",
        size: 140,
        minSize: 110,
        maxSize: 200,
        cell: ({ getValue }) => (
          <Badge
            label={getValue<boolean>() ? "Enabled" : "Disabled"}
            variant={getValue<boolean>() ? "success" : "neutral"}
          />
        ),
      },
      {
        accessorKey: "sortOrder",
        header: "Order",
        size: 110,
        minSize: 80,
        maxSize: 160,
        cell: ({ getValue }) => <span className="whitespace-nowrap">{getValue<number>()}</span>,
      },
      {
        accessorKey: "hasClientSecret",
        header: "Credential",
        size: 160,
        minSize: 130,
        maxSize: 220,
        cell: ({ getValue }) => (
          <Badge
            label={getValue<boolean>() ? "Configured" : "Missing"}
            variant={getValue<boolean>() ? "neutral" : "warning"}
          />
        ),
      },
    ],
    [],
  );
  const table = useReactTable({
    data: providers,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <>
      <HerocrumbsActions>
        <Button
          href="/admin/login-providers/new"
          isDisabled={providers.length >= 100 || Boolean(providersQuery.error)}
          label="Add login provider"
          variant="primary"
        />
      </HerocrumbsActions>
      <Text color="secondary">
        OIDC providers assert identity, not Weldall permissions. Disabling or editing does not
        revoke existing sessions or downstream tokens. Disable to remove a login option; identity
        bindings and audit are retained.
      </Text>
      {providersQuery.error ? (
        <Banner
          container="card"
          description={providersQuery.error.message}
          status="error"
          title="Could not load login providers"
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
        <div className="w-full overflow-x-auto" role="group" aria-label="Login providers table">
          <table
            className="admin-resizable-table table-fixed border-collapse text-left"
            style={{ minWidth: "100%", width: table.getTotalSize() }}
          >
            <ResizableTableHeader table={table} />
            <TableBody>
              {table.getRowModel().rows.map((row) => {
                const href = `/admin/login-providers/${row.original.id}`;
                return (
                  <TableRow
                    key={row.id}
                    aria-label={`Edit ${row.original.name}`}
                    data-clickable="true"
                    onClick={(event) => {
                      if (isInteractiveTableTarget(event.target, event.currentTarget)) return;
                      router.push(href);
                    }}
                  >
                    {row.getVisibleCells().map((cell, index) => (
                      <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                        {index === 0 ? (
                          <TableRowAction href={href} label={`Edit ${row.original.name}`}>
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
              {!providersQuery.isPending &&
              !providersQuery.error &&
              table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>
                    <Text color="secondary">No login providers have been configured.</Text>
                  </TableCell>
                </TableRow>
              ) : null}
              {providersQuery.isPending ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>
                    <Text color="secondary">Loading login providers…</Text>
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
