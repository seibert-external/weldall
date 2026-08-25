"use client";

import type { SortingState, Updater } from "@tanstack/react-table";
import { createParser } from "nuqs";

export function createSortingParser(allowedColumns: ReadonlySet<string>, fallback: SortingState) {
  return createParser<SortingState>({
    parse(value) {
      const [id, direction] = value.split(".");
      if (!id || !allowedColumns.has(id) || (direction !== "asc" && direction !== "desc")) {
        return fallback;
      }
      return [{ id, desc: direction === "desc" }];
    },
    serialize(value) {
      const first = value[0] ?? fallback[0];
      return first ? `${first.id}.${first.desc ? "desc" : "asc"}` : "";
    },
    eq(left, right) {
      return left[0]?.id === right[0]?.id && left[0]?.desc === right[0]?.desc;
    },
  }).withDefault(fallback);
}

export function resolveUpdater<T>(updater: Updater<T>, previous: T): T {
  return typeof updater === "function" ? (updater as (value: T) => T)(previous) : updater;
}

export function sortLabel(label: string, sorted: false | "asc" | "desc") {
  return sorted === "asc" ? `${label} ↑` : sorted === "desc" ? `${label} ↓` : label;
}
