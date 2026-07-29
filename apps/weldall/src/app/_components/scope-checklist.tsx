"use client";

import { useId, useMemo, useState } from "react";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";

interface ScopeChecklistOption {
  id: string;
  key: string;
  description: string;
}

export function ScopeChecklist({
  error,
  isLoading = false,
  onChange,
  scopes,
  value,
}: {
  error?: string | undefined;
  isLoading?: boolean;
  onChange: (scopeKeys: string[]) => void;
  scopes: ScopeChecklistOption[];
  value: string[];
}) {
  const titleId = useId();
  const [search, setSearch] = useState("");
  const selected = useMemo(() => new Set(value), [value]);
  const filteredScopes = useMemo(() => {
    const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return scopes;
    return scopes.filter((scope) => {
      const candidate = `${scope.key} ${scope.description}`.toLocaleLowerCase();
      return terms.every((term) => candidate.includes(term));
    });
  }, [scopes, search]);

  return (
    <section className="grid gap-3" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h3 className="m-0 text-base font-semibold" id={titleId}>
            Scopes
          </h3>
          <Text color="secondary">
            {selected.size} of {scopes.length} selected
          </Text>
        </div>
        <TextInput
          hasClear
          isLabelHidden
          label="Find scopes"
          onChange={setSearch}
          placeholder="Find scopes…"
          startIcon="search"
          value={search}
          width={280}
        />
      </div>

      {isLoading ? (
        <Text color="secondary">Loading scopes…</Text>
      ) : filteredScopes.length > 0 ? (
        <div className="border-border divide-border grid divide-y overflow-hidden rounded-lg border">
          {filteredScopes.map((scope) => (
            <div className="p-3" key={scope.id}>
              <CheckboxInput
                description={scope.description}
                label={scope.key}
                onChange={(checked) => {
                  onChange(
                    checked
                      ? [...new Set([...value, scope.key])].sort()
                      : value.filter((key) => key !== scope.key),
                  );
                }}
                value={selected.has(scope.key)}
                width="100%"
              />
            </div>
          ))}
        </div>
      ) : (
        <Text color="secondary">No scopes match this search.</Text>
      )}
      {error ? (
        <span className="text-sm text-[var(--color-text-danger)]" role="alert">
          {error}
        </span>
      ) : null}
    </section>
  );
}
