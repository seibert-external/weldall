"use client";

import { useMemo, useState } from "react";
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { DateRangeInput, type DateRange } from "@astryxdesign/core/DateRangeInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
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
import { useQuery } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type PaginationState,
  type SortingState,
  type Updater,
} from "@tanstack/react-table";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import { AUDIT_EVENT_TYPES, type AuditEventDto, type AuditEventType } from "@/lib/audit";
import { useTRPC } from "@/trpc/react";
import { createSortingParser, resolveUpdater, sortLabel } from "../table-state";

const PAGE_SIZE = 20;
const sortingParser = createSortingParser(new Set(["occurredAt"]), [
  { id: "occurredAt", desc: true },
]);
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});
const eventTypeOptions = AUDIT_EVENT_TYPES.map((value) => ({ value, label: value }));
const outcomes = ["success", "denied", "failed"] as const;
const outcomeOptions = outcomes.map((value) => ({ value, label: value }));
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
type AuditRow = Omit<AuditEventDto, "metadata"> & { metadata?: unknown };

export function AuditEventsTable({ userId }: { userId?: string } = {}) {
  const trpc = useTRPC();
  const [selectedEvent, setSelectedEvent] = useState<AuditRow | null>(null);
  const [{ from, to, eventType, outcome, actorEmail, page, sort: sorting }, setTableQuery] =
    useQueryStates(
      {
        from: parseAsString.withDefault(""),
        to: parseAsString.withDefault(""),
        eventType: parseAsString.withDefault(""),
        outcome: parseAsString.withDefault(""),
        actorEmail: parseAsString.withDefault(""),
        page: parseAsInteger.withDefault(1),
        sort: sortingParser,
      },
      { history: "replace", shallow: true },
    );
  const selectedEventType = AUDIT_EVENT_TYPES.includes(eventType as AuditEventType)
    ? (eventType as AuditEventType)
    : undefined;
  const selectedOutcome = outcomes.includes(outcome as (typeof outcomes)[number])
    ? (outcome as (typeof outcomes)[number])
    : undefined;
  const dateRange = toDateRange(from, to);
  const currentPage = Math.max(1, page);
  const pagination = useMemo<PaginationState>(
    () => ({ pageIndex: currentPage - 1, pageSize: PAGE_SIZE }),
    [currentPage],
  );
  const columnFilters = useMemo<ColumnFiltersState>(
    () => [
      ...(dateRange ? [{ id: "occurredAt", value: dateRange }] : []),
      ...(selectedEventType ? [{ id: "eventType", value: selectedEventType }] : []),
      ...(selectedOutcome ? [{ id: "outcome", value: selectedOutcome }] : []),
      ...(!userId && actorEmail ? [{ id: "actor", value: actorEmail }] : []),
    ],
    [actorEmail, dateRange, selectedEventType, selectedOutcome, userId],
  );
  const auditQuery = useQuery(
    trpc.admin.auditEvents.list.queryOptions({
      page: currentPage,
      pageSize: PAGE_SIZE,
      ...(dateRange
        ? {
            from: `${dateRange.start}T00:00:00.000Z`,
            to: `${dateRange.end}T23:59:59.999Z`,
          }
        : {}),
      ...(selectedEventType ? { eventType: selectedEventType } : {}),
      ...(selectedOutcome ? { outcome: selectedOutcome } : {}),
      ...(userId ? { userId } : actorEmail ? { email: actorEmail } : {}),
      sort: sortingToAuditSort(sorting),
    }),
  );
  const events = auditQuery.data?.items ?? [];
  const columns = useMemo<ColumnDef<AuditRow>[]>(
    () => [
      {
        accessorKey: "occurredAt",
        header: "Occurred",
        cell: ({ getValue }) => (
          <time className="inline-block min-w-[14rem] whitespace-nowrap">
            {dateFormatter.format(new Date(getValue<string>()))}
          </time>
        ),
      },
      {
        accessorKey: "eventType",
        header: "Type",
        enableSorting: false,
        cell: ({ getValue }) => <Badge label={getValue<string>()} variant="info" />,
      },
      {
        id: "actor",
        accessorFn: (event) => event.actorEmail ?? event.actorId,
        header: "User / actor",
        enableSorting: false,
        cell: ({ getValue }) => <span>{getValue<string>()}</span>,
      },
      {
        accessorKey: "outcome",
        header: "Outcome",
        enableSorting: false,
        cell: ({ row, getValue }) => (
          <div className="grid gap-1">
            <Badge
              label={getValue<string>()}
              variant={outcomeVariant(getValue<AuditEventDto["outcome"]>())}
            />
            {row.original.reasonCode ? (
              <code className="text-xs">{row.original.reasonCode}</code>
            ) : null}
          </div>
        ),
      },
      {
        id: "subject",
        header: "Subject",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.subjectId ? (
            <code className="whitespace-nowrap text-xs">{row.original.subjectId}</code>
          ) : (
            <Text color="secondary">None</Text>
          ),
      },
      {
        id: "metadata",
        header: "Details",
        enableSorting: false,
        cell: ({ row }) => (
          <Button
            label="Show"
            onClick={() => setSelectedEvent(row.original)}
            size="sm"
            variant="secondary"
          />
        ),
      },
    ],
    [],
  );
  const table = useReactTable<AuditRow>({
    data: events,
    columns,
    state: { sorting, pagination, columnFilters },
    manualSorting: true,
    manualPagination: true,
    manualFiltering: true,
    rowCount: auditQuery.data?.total ?? 0,
    onSortingChange: (updater: Updater<SortingState>) => {
      void setTableQuery({ sort: resolveUpdater(updater, sorting), page: 1 });
    },
    onPaginationChange: (updater: Updater<PaginationState>) => {
      const next = resolveUpdater(updater, pagination);
      void setTableQuery({ page: next.pageIndex + 1 });
    },
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <>
      <div className="admin-audit-filters" aria-label="Audit log filters">
        <DateRangeInput
          hasClear
          isLabelHidden
          label="Occurred between"
          onChange={(range) =>
            void setTableQuery({
              from: range?.start ?? null,
              to: range?.end ?? null,
              page: 1,
            })
          }
          placeholder="From – to"
          value={dateRange}
          width={300}
        />
        <Selector
          hasClear
          isLabelHidden
          label="Event type"
          onChange={(value) => void setTableQuery({ eventType: value, page: 1 })}
          options={eventTypeOptions}
          placeholder="All event types"
          value={selectedEventType ?? null}
          width={260}
        />
        <Selector
          hasClear
          isLabelHidden
          label="Outcome"
          onChange={(value) => void setTableQuery({ outcome: value, page: 1 })}
          options={outcomeOptions}
          placeholder="All outcomes"
          value={selectedOutcome ?? null}
          width={180}
        />
        {!userId ? (
          <TextInput
            hasClear
            isLabelHidden
            label="User email"
            onChange={(value) => void setTableQuery({ actorEmail: value || null, page: 1 })}
            placeholder="User email contains…"
            startIcon="search"
            value={actorEmail}
            width={280}
          />
        ) : null}
      </div>
      {auditQuery.error ? (
        <Banner
          container="card"
          status="error"
          title={userId ? "Could not load user audit events" : "Could not load audit events"}
          description={auditQuery.error.message}
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
          <div className="w-full overflow-x-auto" role="group" aria-label="Audit events table">
            <table className="w-full min-w-[1200px] border-collapse text-left">
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
                {!auditQuery.isPending && table.getRowModel().rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">
                        {userId
                          ? "No audit events for this user match these filters."
                          : "No audit events match these filters."}
                      </Text>
                    </TableCell>
                  </TableRow>
                ) : null}
                {auditQuery.isPending ? (
                  <TableRow>
                    <TableCell colSpan={columns.length}>
                      <Text color="secondary">Loading audit events…</Text>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </table>
          </div>
        </TableContext.Provider>
        <div className="admin-table-footer">
          <Pagination
            label={userId ? "User audit event pages" : "Audit event pages"}
            onChange={(nextPage) => table.setPageIndex(nextPage - 1)}
            page={pagination.pageIndex + 1}
            pageSize={pagination.pageSize}
            totalItems={auditQuery.data?.total ?? 0}
            variant="count"
          />
        </div>
      </div>
      {selectedEvent ? (
        <Dialog
          isOpen
          maxHeight="calc(100vh - 32px)"
          onOpenChange={(isOpen) => {
            if (!isOpen) setSelectedEvent(null);
          }}
          purpose="info"
          width="min(800px, calc(100vw - 32px))"
        >
          <Layout
            header={
              <DialogHeader
                hasDivider
                onOpenChange={(isOpen) => {
                  if (!isOpen) setSelectedEvent(null);
                }}
                title="Audit event details"
              />
            }
            content={
              <LayoutContent>
                <pre className="overflow-auto whitespace-pre-wrap text-xs">
                  {JSON.stringify(selectedEvent, null, 2)}
                </pre>
              </LayoutContent>
            }
            footer={
              <LayoutFooter hasDivider>
                <div className="flex justify-end">
                  <Button
                    label="Close"
                    onClick={() => setSelectedEvent(null)}
                    variant="secondary"
                  />
                </div>
              </LayoutFooter>
            }
          />
        </Dialog>
      ) : null}
    </>
  );
}

function toDateRange(from: string, to: string): DateRange | null {
  return isoDatePattern.test(from) && isoDatePattern.test(to)
    ? ({ start: from, end: to } as DateRange)
    : null;
}

function sortingToAuditSort(sorting: SortingState) {
  return sorting[0]?.desc === false ? "occurredAt.asc" : "occurredAt.desc";
}

function outcomeVariant(outcome: AuditEventDto["outcome"]): BadgeVariant {
  return outcome === "success" ? "success" : outcome === "denied" ? "warning" : "error";
}
