"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Table as TanStackTable } from "@tanstack/react-table";
import { TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core/Table";
import { sortLabel } from "./table-state";

export function isInteractiveTableTarget(
  target: EventTarget | null,
  currentTarget: EventTarget | null,
) {
  if (!(target instanceof Element) || !(currentTarget instanceof Element)) return false;
  const interactive = target.closest(
    'a, button, input, select, textarea, [role="button"], [role="link"], [tabindex]',
  );
  return interactive !== null && interactive !== currentTarget;
}

type TableRowActionProps =
  | { children: ReactNode; href: string; label: string; onActivate?: never }
  | { children: ReactNode; href?: never; label: string; onActivate: () => void };

export function TableRowAction(props: TableRowActionProps) {
  const className = "admin-table-row-action";
  return "href" in props ? (
    <a aria-label={props.label} className={className} href={props.href}>
      {props.children}
    </a>
  ) : (
    <button
      aria-label={props.label}
      className={className}
      onClick={props.onActivate}
      type="button"
    >
      {props.children}
    </button>
  );
}

export function ResizableTableHeader<T>({ table }: { table: TanStackTable<T> }) {
  return (
    <TableHeader>
      {table.getHeaderGroups().map((headerGroup) => (
        <TableRow key={headerGroup.id} isHeaderRow>
          {headerGroup.headers.map((header) => {
            const sorted = header.column.getIsSorted();
            const label = String(header.column.columnDef.header ?? "");
            const minSize = header.column.columnDef.minSize ?? 20;
            const maxSize = header.column.columnDef.maxSize ?? Number.MAX_SAFE_INTEGER;
            return (
              <TableHeaderCell
                key={header.id}
                className="relative"
                scope="col"
                aria-sort={sorted ? (sorted === "asc" ? "ascending" : "descending") : undefined}
                style={{ width: header.getSize() }}
              >
                {header.column.getCanSort() ? (
                  <button
                    className="w-full border-0 bg-transparent p-0 pr-2 text-left font-[inherit] text-inherit"
                    onClick={header.column.getToggleSortingHandler()}
                    type="button"
                  >
                    {sortLabel(label, sorted)}
                  </button>
                ) : (
                  <span className="pr-2">{label}</span>
                )}
                {header.column.getCanResize() ? (
                  <div
                    aria-label={`Resize ${label} column`}
                    aria-orientation="vertical"
                    aria-valuemax={maxSize}
                    aria-valuemin={minSize}
                    aria-valuenow={header.getSize()}
                    className="admin-table-resizer"
                    data-resizing={header.column.getIsResizing() ? "true" : undefined}
                    onDoubleClick={() => header.column.resetSize()}
                    onKeyDown={(event) => {
                      const step = event.shiftKey ? 24 : 8;
                      const nextSize =
                        event.key === "Home"
                          ? minSize
                          : event.key === "End"
                            ? maxSize
                            : event.key === "ArrowLeft"
                              ? header.getSize() - step
                              : event.key === "ArrowRight"
                                ? header.getSize() + step
                                : null;
                      if (nextSize === null) return;
                      event.preventDefault();
                      table.setColumnSizing((current) => ({
                        ...current,
                        [header.column.id]: Math.min(maxSize, Math.max(minSize, nextSize)),
                      }));
                    }}
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    role="separator"
                    tabIndex={0}
                  />
                ) : null}
              </TableHeaderCell>
            );
          })}
        </TableRow>
      ))}
    </TableHeader>
  );
}

export function OverflowFade({ children, title }: { children: ReactNode; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const updateOverflow = () => setHasOverflow(element.scrollWidth > element.clientWidth + 1);
    updateOverflow();

    const observer = new ResizeObserver(updateOverflow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [title]);

  return (
    <div
      ref={ref}
      className="admin-table-overflow-fade"
      data-overflow={hasOverflow ? "true" : undefined}
      title={hasOverflow ? title : undefined}
    >
      {children}
    </div>
  );
}
