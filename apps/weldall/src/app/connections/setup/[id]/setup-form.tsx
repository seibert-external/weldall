"use client";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Link } from "@astryxdesign/core/Link";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { getAuthorizationAttempt } from "@/server/connectors/core/connections";
import type { ScopeDescriptor } from "@/server/connectors/display";

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
    <VStack gap={4} hAlign="stretch">
      {[...new Set(scopes.map((s) => s.group))].map((group) => (
        <fieldset key={group}>
          <legend className="mb-3">
            <Text type="label">{group}</Text>
          </legend>
          <VStack gap={3} hAlign="stretch">
            {scopes
              .filter((s) => s.group === group)
              .map((s) => (
                <CheckboxInput
                  key={s.id}
                  label={s.label}
                  description={s.description}
                  value={s.required || selected.includes(s.id)}
                  isDisabled={s.required}
                  isRequired={s.required}
                  isOptional={!s.required}
                  width="100%"
                  onChange={(checked) =>
                    onChange(checked ? [...selected, s.id] : selected.filter((id) => id !== s.id))
                  }
                />
              ))}
          </VStack>
        </fieldset>
      ))}
    </VStack>
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
  if (query.isPending) return <Text color="secondary">Loading connection setup…</Text>;
  if (query.error)
    return (
      <VStack gap={3} hAlign="stretch">
        <Banner status="error" title="Setup unavailable" description={query.error.message} />
        <Text as="p" color="secondary">
          <Link href="/login" isExternalLink>
            Sign in to Weldall
          </Link>{" "}
          as the initiating CLI user, then reload this page.
        </Text>
      </VStack>
    );
  const attempt = query.data!;
  if (attempt.status !== "SETUP")
    return <Text as="p">Authorization status: {attempt.status}. Return to the CLI.</Text>;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit.mutate();
      }}
    >
      <VStack gap={5} hAlign="stretch">
        <VStack gap={2} hAlign="stretch">
          <Text as="p" className="mt-4">
            You are about to connect an account to {attempt.connector.name} in Weldall CLI.
          </Text>
        </VStack>
        <ScopeChoices
          scopes={attempt.scopes}
          selected={selected ?? attempt.selection?.scopes ?? []}
          onChange={setSelected}
        />
        <Text as="p">
          You can disconnect the account or change the permissions via Weldall CLI. Just ask your
          agent.
        </Text>
        {submit.error && (
          <Banner status="error" title="Cannot continue" description={submit.error.message} />
        )}
        <Button
          type="submit"
          label="Continue to provider"
          isLoading={submit.isPending}
          isDisabled={submit.isPending}
        />
      </VStack>
    </form>
  );
}
