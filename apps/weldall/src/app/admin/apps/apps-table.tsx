"use client";

import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Pagination } from "@astryxdesign/core/Pagination";
import { Selector } from "@astryxdesign/core/Selector";
import { TableBody, TableCell, TableContext, TableRow } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useQuery } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import type { AdminAppEntry } from "@/server/app-registry/registry";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { OverflowFade, ResizableTableHeader } from "../resizable-table";

const PAGE_SIZE = 200;
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const STATES = ["active", "expiring_soon", "expired"] as const;
type AppState = (typeof STATES)[number];
export const APP_STATE_LABELS: Record<AppState, string> = {
  active: "Active",
  expiring_soon: "Expiring soon",
  expired: "Expired",
};
const APP_STATE_VARIANTS: Record<AppState, BadgeVariant> = {
  active: "success",
  expiring_soon: "warning",
  expired: "error",
};
const stateOptions = STATES.map((value) => ({ value, label: APP_STATE_LABELS[value] }));
const emptyApps: AdminAppEntry[] = [];

export function AppStateBadge({ state }: { state: AppState }) {
  return <Badge label={APP_STATE_LABELS[state]} variant={APP_STATE_VARIANTS[state]} />;
}

/**
 * A link that comes from a Git host's CI or from a person. Only https URLs without credentials
 * become links; the text is the URL as plain text, never markup.
 */
export function ExternalLink({ href, label }: { href: string | null; label?: string }) {
  const safe = httpsUrl(href);
  if (!safe) return <Text color="secondary">None</Text>;
  const text = label ?? safe;
  return (
    <OverflowFade title={safe}>
      <a href={safe} target="_blank" rel="noopener noreferrer nofollow">
        {text}
      </a>
    </OverflowFade>
  );
}

export function httpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

const formatDate = (value: string | null) =>
  value ? (
    <time className="whitespace-nowrap">{dateFormatter.format(new Date(value))}</time>
  ) : (
    <Text color="secondary">Never</Text>
  );
const plain = (value: string) => <OverflowFade title={value}>{value}</OverflowFade>;

/** Read-only list of every app published through Weldall, expired and expiring ones first. */
export function AppsTable() {
  const trpc = useTRPC();
  const [{ q, state, page }, setTableQuery] = useQueryStates(
    {
      q: parseAsString.withDefault(""),
      state: parseAsString.withDefault(""),
      page: parseAsInteger.withDefault(1),
    },
    { history: "replace", shallow: true },
  );
  const selectedState = STATES.includes(state as AppState) ? (state as AppState) : undefined;
  const appsQuery = useQuery(
    trpc.admin.apps.list.queryOptions({
      page: Math.max(1, page),
      pageSize: PAGE_SIZE,
      q,
      ...(selectedState ? { state: selectedState } : {}),
    }),
  );
  const apps = appsQuery.data?.items ?? emptyApps;
  const columns = useMemo<ColumnDef<AdminAppEntry>[]>(
    () => [
      {
        accessorKey: "name",
        header: "App",
        size: 220,
        minSize: 140,
        maxSize: 400,
        cell: ({ getValue }) => plain(getValue<string>()),
      },
      {
        accessorKey: "state",
        header: "State",
        size: 160,
        minSize: 130,
        maxSize: 220,
        cell: ({ getValue }) => <AppStateBadge state={getValue<AppState>()} />,
      },
      {
        accessorKey: "expiresAt",
        header: "Expires",
        size: 160,
        minSize: 120,
        maxSize: 240,
        cell: ({ getValue }) => formatDate(getValue<string>()),
      },
      {
        id: "owner",
        accessorFn: (app) => app.owner.email,
        header: "Owner",
        size: 260,
        minSize: 160,
        maxSize: 420,
        cell: ({ row }) => (
          <OverflowFade title={`${row.original.owner.name} <${row.original.owner.email}>`}>
            {row.original.owner.name}
            <br />
            <Text color="secondary">{row.original.owner.email}</Text>
          </OverflowFade>
        ),
      },
      {
        accessorKey: "purpose",
        header: "Purpose",
        size: 320,
        minSize: 180,
        maxSize: 600,
        cell: ({ getValue }) => plain(getValue<string>()),
      },
      {
        id: "repository",
        header: "Repository",
        size: 260,
        minSize: 160,
        maxSize: 420,
        cell: ({ row }) => {
          const { owner, name, webUrl } = row.original.repository;
          return webUrl ? (
            <ExternalLink href={webUrl} label={`${owner}/${name}`} />
          ) : (
            plain(`${owner}/${name}`)
          );
        },
      },
      {
        accessorKey: "template",
        header: "Template",
        size: 150,
        minSize: 110,
        maxSize: 260,
        cell: ({ getValue }) => {
          const template = getValue<string | null>();
          return template ? plain(template) : <Text color="secondary">None</Text>;
        },
      },
      {
        id: "preview",
        header: "Preview",
        size: 240,
        minSize: 120,
        maxSize: 420,
        cell: ({ row }) => <ExternalLink href={row.original.links.preview} />,
      },
      {
        id: "live",
        header: "Live",
        size: 240,
        minSize: 120,
        maxSize: 420,
        cell: ({ row }) => <ExternalLink href={row.original.links.live} />,
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        size: 160,
        minSize: 120,
        maxSize: 240,
        cell: ({ getValue }) => formatDate(getValue<string>()),
      },
      {
        accessorKey: "confirmedAt",
        header: "Last confirmed",
        size: 170,
        minSize: 130,
        maxSize: 240,
        cell: ({ getValue }) => formatDate(getValue<string | null>()),
      },
    ],
    [],
  );
  const table = useReactTable({
    data: apps,
    columns,
    defaultColumn: { enableSorting: false },
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <>
      <HerocrumbsActions>
        <TextInput
          hasClear
          isLabelHidden
          label="Find apps"
          onChange={(value) => void setTableQuery({ q: value || null, page: 1 })}
          placeholder="Find apps or owners…"
          size="lg"
          startIcon="search"
          value={q}
          width={280}
        />
      </HerocrumbsActions>
      <div className="admin-audit-filters" aria-label="App registry filters">
        <Selector
          hasClear
          isLabelHidden
          label="State"
          onChange={(value) => void setTableQuery({ state: value, page: 1 })}
          options={stateOptions}
          placeholder="All states"
          value={selectedState ?? null}
          width={200}
        />
        {appsQuery.data ? (
          <Text color="secondary">
            Owners confirm their apps every {appsQuery.data.reverificationDays} days. An app is
            expiring soon {appsQuery.data.expiringSoonDays} days before its expiry and expired after
            it. Expired apps are only flagged; nothing is stopped.
          </Text>
        ) : null}
      </div>
      {appsQuery.error ? (
        <Banner
          container="card"
          status="error"
          title="Could not load apps"
          description={appsQuery.error.message}
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
          <div className="w-full overflow-x-auto" role="group" aria-label="App registry table">
            <table
              className="admin-resizable-table table-fixed border-collapse text-left"
              style={{ minWidth: "100%", width: table.getTotalSize() }}
            >
              <ResizableTableHeader table={table} />
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} data-state={row.original.state}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {!appsQuery.isPending && table.getRowModel().rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">
                        {q || selectedState
                          ? "No apps match this search."
                          : "No apps have been published through Weldall yet."}
                      </Text>
                    </TableCell>
                  </TableRow>
                ) : null}
                {appsQuery.isPending ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">Loading apps…</Text>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </table>
          </div>
        </TableContext.Provider>
        <div className="admin-table-footer">
          <Pagination
            label="App pages"
            onChange={(nextPage) => void setTableQuery({ page: nextPage })}
            page={Math.max(1, page)}
            pageSize={PAGE_SIZE}
            totalItems={appsQuery.data?.total ?? 0}
            variant="count"
          />
        </div>
      </div>
    </>
  );
}
