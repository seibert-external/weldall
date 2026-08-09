"use client";

import { createElement } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { sortScopeKeys } from "./sort-scope-keys";

export function ScopeBadges({ scopes }: { scopes: readonly string[] }) {
  return createElement(
    "div",
    { className: "flex max-w-[44rem] flex-wrap gap-1" },
    sortScopeKeys(scopes).map((scope) =>
      createElement(Badge, {
        key: scope,
        label: scope,
        variant: scope === "weldall:administer" ? "purple" : "neutral",
      }),
    ),
  );
}
