"use client";

import { useEffect, useMemo, useState } from "react";
import { TextInput } from "@astryxdesign/core/TextInput";
import { parseAsString, useQueryStates } from "nuqs";
import {
  TableBody,
  TableCell,
  TableContext,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import type { DirectoryResource, DirectoryScope } from "@/server/directory/search";

const resourceColumns: ColumnDef<DirectoryResource>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ getValue }) => <span className="directory-table-name">{getValue<string>()}</span>,
  },
  {
    accessorKey: "key",
    header: "ID",
    cell: ({ getValue }) => <code>{getValue<string>()}</code>,
  },
  {
    accessorKey: "resourceIdentifier",
    header: "Resource identifier",
    cell: ({ getValue }) => <code>{getValue<string>()}</code>,
  },
];

const scopeColumns: ColumnDef<DirectoryScope>[] = [
  {
    accessorKey: "key",
    header: "Name",
    cell: ({ getValue }) => <code>{getValue<string>()}</code>,
  },
  {
    accessorKey: "description",
    header: "Description",
  },
];

export function ResourceDirectoryTable({
  resources,
  selectedKey,
}: {
  resources: DirectoryResource[];
  selectedKey: string | undefined;
}) {
  return (
    <DirectoryTable
      columns={resourceColumns}
      emptyLabel="No resources are available."
      initialSortColumn="name"
      itemLabel="resource"
      items={resources}
      searchPlaceholder="Search resources"
      searchText={(resource) =>
        [resource.name, resource.key, resource.resourceIdentifier].join(" ")
      }
      selectedKey={selectedKey}
      title="Resources"
    />
  );
}

export function ScopeDirectoryTable({
  scopes,
  selectedKey,
}: {
  scopes: DirectoryScope[];
  selectedKey: string | undefined;
}) {
  return (
    <DirectoryTable
      columns={scopeColumns}
      emptyLabel="No scopes are assigned to you."
      initialSortColumn="key"
      itemLabel="scope"
      items={scopes}
      searchPlaceholder="Search scopes"
      searchText={(scope) => [scope.key, scope.description].join(" ")}
      selectedKey={selectedKey}
      title="Scopes"
    />
  );
}

function DirectoryTable<T extends { key: string }>({
  columns,
  emptyLabel,
  initialSortColumn,
  itemLabel,
  items,
  searchPlaceholder,
  searchText,
  selectedKey,
  title,
}: {
  columns: ColumnDef<T>[];
  emptyLabel: string;
  initialSortColumn: string;
  itemLabel: string;
  items: T[];
  searchPlaceholder: string;
  searchText: (item: T) => string;
  selectedKey: string | undefined;
  title: string;
}) {
  const [{ q: query }, setDirectoryQuery] = useQueryStates(
    { q: parseAsString.withDefault("") },
    { history: "replace", shallow: true },
  );
  const [sorting, setSorting] = useState<SortingState>([{ id: initialSortColumn, desc: false }]);
  const normalizedSearchText = useMemo(
    () => new Map(items.map((item) => [item.key, searchText(item).toLocaleLowerCase()])),
    [items, searchText],
  );
  const table = useReactTable({
    data: items,
    columns,
    state: { globalFilter: query, sorting },
    onSortingChange: setSorting,
    globalFilterFn: (row, _columnId, value) => {
      const terms = String(value).trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
      const text = normalizedSearchText.get(row.original.key) ?? "";
      return terms.every((term) => text.includes(term));
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const rows = table.getRowModel().rows;

  useEffect(() => {
    if (!selectedKey) return;
    document
      .getElementById(`directory-row-${encodeURIComponent(selectedKey)}`)
      ?.scrollIntoView({ block: "center" });
  }, [selectedKey]);

  return (
    <section className="directory-table-layout" aria-labelledby="directory-table-title">
      <div className="directory-table-heading">
        <h1 id="directory-table-title">{title}</h1>
        <div className="directory-inline-search">
          <TextInput
            hasClear
            isLabelHidden
            label={`Search ${title.toLocaleLowerCase()}`}
            onChange={(value) => void setDirectoryQuery({ q: value || null })}
            placeholder={searchPlaceholder}
            startIcon="search"
            value={query}
            width="100%"
          />
        </div>
      </div>

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
        <div
          className="directory-table-viewport"
          role="region"
          aria-label={`${title} table`}
          tabIndex={0}
        >
          <table className="directory-table">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} isHeaderRow>
                  {headerGroup.headers.map((header) => {
                    const sorted = header.column.getIsSorted();
                    return (
                      <TableHeaderCell
                        aria-sort={
                          sorted ? (sorted === "asc" ? "ascending" : "descending") : undefined
                        }
                        key={header.id}
                        scope="col"
                      >
                        {header.isPlaceholder ? null : (
                          <button
                            className="directory-table-sort"
                            onClick={header.column.getToggleSortingHandler()}
                            type="button"
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            <span aria-hidden="true">
                              {sorted === "asc" ? "↑" : sorted === "desc" ? "↓" : "↕"}
                            </span>
                          </button>
                        )}
                      </TableHeaderCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  aria-current={row.original.key === selectedKey ? "true" : undefined}
                  data-selected={row.original.key === selectedKey || undefined}
                  id={`directory-row-${encodeURIComponent(row.original.key)}`}
                  key={row.id}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>
                    <span className="directory-table-empty">
                      {query ? `No ${itemLabel}s match this search.` : emptyLabel}
                    </span>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </table>
        </div>
      </TableContext.Provider>
    </section>
  );
}
