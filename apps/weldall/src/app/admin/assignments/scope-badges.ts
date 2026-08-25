"use client";

import { createElement } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { sortScopeKeys } from "./sort-scope-keys";

export function ScopeBadges({ scopes }: { scopes: readonly string[] }) {
  return createElement(
    "div",
    { className: "flex w-max flex-nowrap gap-1 whitespace-nowrap" },
    sortScopeKeys(scopes).map((scope) =>
      createElement(Badge, {
        key: scope,
        label: scope,
        variant: scope === "weldall:administer" ? "purple" : "neutral",
      }),
    ),
  );
}
