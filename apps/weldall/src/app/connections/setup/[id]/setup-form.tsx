"use client";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import type { getAuthorizationAttempt } from "@/server/connectors/core/connections";
import type { ScopeDescriptor } from "@/server/connectors/providers/google/setup";

/** Shared rendering knows no provider scope IDs; descriptions and grouping come from the connector. */
/** Lets an owner choose optional OAuth scopes within the administrator-approved connector policy. */
export function ScopeChoices({
  scopes,
  selected,
  onChange,
}: {
  scopes: ScopeDescriptor[];
  selected: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <>
      {[...new Set(scopes.map((s) => s.group))].map((group) => (
        <fieldset key={group} className="my-4">
          <legend>{group}</legend>
          {scopes
            .filter((s) => s.group === group)
            .map((s) => (
              <label key={s.id} className="my-3 block">
                <input
                  type="checkbox"
                  checked={s.required || selected.includes(s.id)}
                  disabled={s.required}
                  onChange={(e) =>
                    onChange(
                      e.target.checked ? [...selected, s.id] : selected.filter((id) => id !== s.id),
                    )
                  }
                />{" "}
                {s.label}
                {s.required ? " (required)" : " (optional)"}
                <span className="block text-sm">{s.description}</span>
              </label>
            ))}
        </fieldset>
      ))}
    </>
  );
}
/** Drives the browser step that confirms scopes before redirecting to provider authorization. */
export function SetupForm({ id }: { id: string }) {
  const [selected, setSelected] = useState<string[] | null>(null);
  const query = useQuery({
    queryKey: ["connection-setup", id],
    retry: false,
    queryFn: async () => {
      const response = await fetch(`/api/connectors/setup/${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error_description);
      return value as Awaited<ReturnType<typeof getAuthorizationAttempt>>;
    },
  });
  const submit = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/connectors/setup/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-weldall-csrf": "1" },
        body: JSON.stringify({ selection: { scopes: selected ?? query.data?.selection?.scopes } }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error_description);
      window.location.assign(result.url);
    },
  });
  if (query.isPending) return <p>Loading connection setup…</p>;
  if (query.error)
    return (
      <>
        <Banner status="error" title="Setup unavailable" description={query.error.message} />
        <p>
          <a href="/login" target="_blank" rel="noreferrer">
            Sign in to Weldall
          </a>{" "}
          as the initiating CLI user, then reload this page.
        </p>
      </>
    );
  const attempt = query.data!;
  if (attempt.status !== "SETUP")
    return <p>Authorization status: {attempt.status}. Return to the CLI.</p>;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit.mutate();
      }}
    >
      <h1>Connect your {attempt.connector.name} account</h1>
      <p>Choose what this connection may access. Select at least one API permission.</p>
      <ScopeChoices
        scopes={attempt.scopes}
        selected={selected ?? attempt.selection?.scopes ?? []}
        onChange={setSelected}
      />
      <p>
        Broad scopes permit every operation Google authorizes with them. Google must grant exactly
        the requested scopes; reduced or expanded grants are rejected. Reconnect changes take effect
        only after successful authorization; unchecking a box does not revoke Google's underlying
        grant.
      </p>
      {submit.error && (
        <Banner status="error" title="Cannot continue" description={submit.error.message} />
      )}
      <Button
        type="submit"
        label="Continue to Google"
        isLoading={submit.isPending}
        isDisabled={submit.isPending}
      />
    </form>
  );
}
