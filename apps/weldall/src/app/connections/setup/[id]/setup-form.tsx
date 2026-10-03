"use client";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Link } from "@astryxdesign/core/Link";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Link2 } from "lucide-react";
import type { getAuthorizationAttempt } from "@/server/connectors/core/connections";
import type { ScopeDescriptor } from "@/server/connectors/display";

const providerLogos = {
  google: { label: "Google", src: "/assets/images/connectors/google.svg" },
  atlassian: { label: "Atlassian", src: "/assets/images/connectors/atlassian.svg" },
} as const;

function ConnectionBrand({ providerType }: { providerType: string }) {
  const provider = providerLogos[providerType as keyof typeof providerLogos];
  if (!provider) return null;
  return (
    <div className="flex items-center justify-center gap-4">
      <img
        src="/assets/images/weldall.png"
        alt="Weldall"
        width={182}
        height={51}
        className="block h-auto w-40"
      />
      <Link2 aria-hidden="true" className="text-secondary shrink-0" size={24} />
      <img
        src={provider.src}
        alt={provider.label}
        width={48}
        height={48}
        className="h-12 w-12 shrink-0 object-contain"
      />
    </div>
  );
}

/** Shared rendering knows no provider scope IDs; descriptions and grouping come from the connector. */
/** Lets an owner choose optional OAuth scopes within the administrator-approved connector policy. */
export function ScopeChoices({
  scopes,
  selected,
  onChange,
  isExpanded,
  onExpandedChange,
}: {
  scopes: ScopeDescriptor[];
  selected: string[];
  onChange: (value: string[]) => void;
  isExpanded?: boolean;
  onExpandedChange?: (value: boolean) => void;
}) {
  const grantedCount = scopes.filter(
    (scope) => scope.required || selected.includes(scope.id),
  ).length;
  return (
    <Collapsible
      className="border-y border-[var(--color-border)] py-4"
      trigger={
        <Text color="secondary">
          You will be granting {grantedCount} out of {scopes.length} permissions
        </Text>
      }
      defaultIsOpen={false}
      {...(isExpanded === undefined ? {} : { isOpen: isExpanded })}
      {...(onExpandedChange ? { onOpenChange: onExpandedChange } : {})}
    >
      <div className="mt-4">
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
                        onChange(
                          checked ? [...selected, s.id] : selected.filter((id) => id !== s.id),
                        )
                      }
                    />
                  ))}
              </VStack>
            </fieldset>
          ))}
        </VStack>
      </div>
    </Collapsible>
  );
}
/** Drives the browser step that confirms scopes before redirecting to provider authorization. */
export function SetupForm({ id }: { id: string }) {
  const [selected, setSelected] = useState<string[] | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [areScopesExpanded, setAreScopesExpanded] = useState(false);
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
        body: JSON.stringify({
          selection: {
            ...query.data?.selection,
            ...choices,
            scopes: selected ?? query.data?.selection?.scopes,
          },
        }),
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
    <>
      <ConnectionBrand providerType={attempt.connector.providerType} />
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
          {attempt.choices?.map((choice) => (
            <label key={choice.key} className="flex flex-col gap-2">
              <Text type="label">{choice.label}</Text>
              <select
                required
                value={choices[choice.key] ?? String(attempt.selection?.[choice.key] ?? "")}
                onChange={(event) =>
                  setChoices((prior) => ({ ...prior, [choice.key]: event.target.value }))
                }
                className="rounded border p-2"
              >
                {choice.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <Text color="secondary">{choice.description}</Text>
            </label>
          ))}
          <ScopeChoices
            scopes={attempt.scopes}
            selected={selected ?? attempt.selection?.scopes ?? []}
            onChange={setSelected}
            isExpanded={areScopesExpanded}
            onExpandedChange={setAreScopesExpanded}
          />
          {submit.error && (
            <Banner status="error" title="Cannot continue" description={submit.error.message} />
          )}
          <HStack gap={2} hAlign="end">
            <Button
              type="button"
              label="Configure access"
              variant="secondary"
              onClick={() => setAreScopesExpanded(true)}
            />
            <Button
              type="submit"
              label="Continue"
              variant="primary"
              isLoading={submit.isPending}
              isDisabled={submit.isPending}
            />
          </HStack>
        </VStack>
      </form>
    </>
  );
}
