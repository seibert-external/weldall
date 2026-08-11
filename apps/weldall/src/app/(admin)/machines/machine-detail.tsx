"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnyFieldApi } from "@tanstack/react-form";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Switch } from "@astryxdesign/core/Switch";
import {
  TableBody,
  TableCell,
  TableContext,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MachineClientDto } from "@/server/machines/service";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";
import { useOperationToast } from "../../_components/use-operation-toast";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function MachineDetail({ machineId }: { machineId: string | null }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const formId = useId();
  const keyFormId = useId();
  const accessFormId = useId();
  const isNew = machineId === null;
  const operationToast = useOperationToast();
  const [keyToRevoke, setKeyToRevoke] = useState<MachineClientDto["keys"][number] | null>(null);

  const machineQuery = useQuery({
    ...trpc.admin.machineClients.get.queryOptions({ id: machineId ?? "new" }),
    enabled: !isNew,
  });
  const accessOptionsQuery = useQuery(trpc.admin.machineClients.accessOptions.queryOptions());

  const syncMachine = async (machine: MachineClientDto) => {
    queryClient.setQueryData(trpc.admin.machineClients.get.queryKey({ id: machine.id }), machine);
    await queryClient.invalidateQueries(trpc.admin.machineClients.list.queryFilter());
  };

  const createMutation = useMutation(
    trpc.admin.machineClients.create.mutationOptions({
      onSuccess: async (machine) => {
        await syncMachine(machine);
        operationToast.success("Machine registered", "machine-save");
      },
      onError: (error) => operationToast.error("Could not register machine", error, "machine-save"),
    }),
  );
  const updateMutation = useMutation(
    trpc.admin.machineClients.update.mutationOptions({
      onSuccess: async (machine) => {
        await syncMachine(machine);
        operationToast.success("Machine saved", "machine-save");
      },
      onError: (error) => operationToast.error("Could not save machine", error, "machine-save"),
    }),
  );
  const registerKeyMutation = useMutation(
    trpc.admin.machineClients.registerKey.mutationOptions({
      onSuccess: async (machine) => {
        await syncMachine(machine);
        operationToast.success("Public key registered", "machine-key-register");
      },
      onError: (error) =>
        operationToast.error("Could not register public key", error, "machine-key-register"),
    }),
  );
  const revokeKeyMutation = useMutation(
    trpc.admin.machineClients.revokeKey.mutationOptions({
      onSuccess: async (machine) => {
        await syncMachine(machine);
        setKeyToRevoke(null);
        operationToast.success("Public key revoked", "machine-key-revoke");
      },
      onError: (error) =>
        operationToast.error("Could not revoke public key", error, "machine-key-revoke"),
    }),
  );
  const replaceAccessMutation = useMutation(
    trpc.admin.machineClients.replaceAccess.mutationOptions({
      onSuccess: async (machine) => {
        await syncMachine(machine);
        operationToast.success("Machine access saved", "machine-access-save");
      },
      onError: (error) =>
        operationToast.error("Could not save machine access", error, "machine-access-save"),
    }),
  );

  const machineForm = useForm({
    defaultValues: {
      clientId: "",
      name: "",
      enabled: true,
      kid: "",
      publicJwk: "",
      resourceIds: [] as string[],
      scopeIds: [] as string[],
    },
    onSubmit: async ({ value }) => {
      if (machineQuery.data) {
        await updateMutation.mutateAsync({
          id: machineQuery.data.id,
          name: value.name.trim(),
          enabled: value.enabled,
          expectedVersion: machineQuery.data.version,
        });
        return;
      }

      const machine = await createMutation.mutateAsync({
        clientId: value.clientId.trim(),
        name: value.name.trim(),
        key: {
          kid: value.kid.trim(),
          publicJwk: parsePublicJwk(value.publicJwk),
        },
        access: {
          resourceIds: value.resourceIds,
          scopeIds: value.scopeIds,
        },
      });
      router.push(`/machines/${machine.id}`);
    },
  });
  const keyForm = useForm({
    defaultValues: { kid: "", publicJwk: "" },
    onSubmit: async ({ value }) => {
      if (!machineQuery.data) return;
      await registerKeyMutation.mutateAsync({
        clientId: machineQuery.data.id,
        kid: value.kid.trim(),
        publicJwk: parsePublicJwk(value.publicJwk),
      });
      keyForm.reset();
    },
  });
  const accessForm = useForm({
    defaultValues: { resourceIds: [] as string[], scopeIds: [] as string[] },
    onSubmit: async ({ value }) => {
      if (!machineQuery.data) return;
      await replaceAccessMutation.mutateAsync({
        clientId: machineQuery.data.id,
        resourceIds: value.resourceIds,
        scopeIds: value.scopeIds,
        expectedVersion: machineQuery.data.version,
      });
    },
  });

  useEffect(() => {
    if (!machineQuery.data) return;
    machineForm.reset({
      clientId: machineQuery.data.clientId,
      name: machineQuery.data.name,
      enabled: machineQuery.data.enabled,
      kid: "",
      publicJwk: "",
      resourceIds: machineQuery.data.access.resourceIds,
      scopeIds: machineQuery.data.access.scopeIds,
    });
    accessForm.reset({
      resourceIds: machineQuery.data.access.resourceIds,
      scopeIds: machineQuery.data.access.scopeIds,
    });
  }, [accessForm, machineForm, machineQuery.data]);

  if (!isNew && machineQuery.isPending) {
    return <Text color="secondary">Loading machine…</Text>;
  }
  if (machineQuery.error) {
    return (
      <Banner
        container="card"
        description={machineQuery.error.message}
        status="error"
        title="Could not load machine"
      />
    );
  }

  const machine = machineQuery.data;
  const accessOptions = accessOptionsQuery.data;
  const resourceOptions = (accessOptions?.resources ?? []).map((resource) => ({
    value: resource.id,
    label: `${resource.name} — ${resource.resourceIdentifier}${resource.enabled ? "" : " (disabled)"}`,
    disabled: !resource.enabled && !machine?.access.resourceIds.includes(resource.id),
  }));
  const scopeOptions = (accessOptions?.scopes ?? []).map((scope) => ({
    value: scope.id,
    label: scope.key,
  }));

  return (
    <>
      <HerocrumbsActions>
        <Button href="/machines" label="Cancel" variant="secondary" />
        <machineForm.Subscribe selector={(state) => state.canSubmit}>
          {(canSubmit) => (
            <Button
              form={formId}
              isDisabled={
                !canSubmit ||
                (isNew && (accessOptionsQuery.isPending || Boolean(accessOptionsQuery.error)))
              }
              isLoading={createMutation.isPending || updateMutation.isPending}
              label={isNew ? "Register machine" : "Save machine"}
              type="submit"
              variant="primary"
            />
          )}
        </machineForm.Subscribe>
      </HerocrumbsActions>

      <div className="skill-detail-surface">
        <form
          className="admin-dialog-form"
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void machineForm.handleSubmit();
          }}
        >
          <section className="grid gap-4" aria-labelledby="machine-details-title">
            <div className="grid gap-1">
              <h2 className="m-0 text-xl font-semibold" id="machine-details-title">
                {isNew ? "Register machine" : machine?.name}
              </h2>
              <Text color="secondary">
                {machine
                  ? `Version ${machine.version} · Updated ${dateFormatter.format(new Date(machine.updatedAt))}`
                  : "Register a machine client with its initial public key and allowed access."}
              </Text>
            </div>
            <FormLayout>
              <machineForm.Field
                name="clientId"
                validators={{
                  onBlur: ({ value }) => validateClientId(value),
                  onChange: ({ value }) => validateClientId(value),
                  onSubmit: ({ value }) => validateClientId(value),
                }}
              >
                {(field) => (
                  <TextInput
                    isDisabled={!isNew}
                    isRequired
                    label="Client ID"
                    onBlur={field.handleBlur}
                    onChange={field.handleChange}
                    placeholder="expenses-a"
                    {...fieldStatusProps(field)}
                    value={field.state.value}
                    width="100%"
                  />
                )}
              </machineForm.Field>
              <machineForm.Field
                name="name"
                validators={{
                  onBlur: ({ value }) => validateRequiredText(value, "Name", 200),
                  onSubmit: ({ value }) => validateRequiredText(value, "Name", 200),
                }}
              >
                {(field) => (
                  <TextInput
                    isRequired
                    label="Name"
                    onBlur={field.handleBlur}
                    onChange={field.handleChange}
                    placeholder="Expenses A"
                    {...fieldStatusProps(field)}
                    value={field.state.value}
                    width="100%"
                  />
                )}
              </machineForm.Field>
              {!isNew ? (
                <machineForm.Field name="enabled">
                  {(field) => (
                    <Switch
                      description="Deactivation blocks new tokens immediately; existing tokens expire within five minutes."
                      label="Enabled"
                      labelPosition="start"
                      labelSpacing="spread"
                      onChange={field.handleChange}
                      value={field.state.value}
                      width="100%"
                    />
                  )}
                </machineForm.Field>
              ) : null}
            </FormLayout>
          </section>

          {isNew ? (
            <>
              <hr className="border-border m-0 border-0 border-t" />
              <section className="grid gap-4" aria-labelledby="initial-key-title">
                <SectionHeading
                  description="Register an ES256 P-256 public JWK. Weldall never stores private key material."
                  id="initial-key-title"
                  title="Initial public key"
                />
                <FormLayout>
                  <machineForm.Field
                    name="kid"
                    validators={{
                      onBlur: ({ value }) => validateKid(value),
                      onChange: ({ value }) => validateKid(value),
                      onSubmit: ({ value }) => validateKid(value),
                    }}
                  >
                    {(field) => (
                      <TextInput
                        isRequired
                        label="Key ID (kid)"
                        onBlur={field.handleBlur}
                        onChange={field.handleChange}
                        placeholder="expenses-a-2026-01"
                        {...fieldStatusProps(field)}
                        value={field.state.value}
                        width="100%"
                      />
                    )}
                  </machineForm.Field>
                  <machineForm.Field
                    name="publicJwk"
                    validators={{
                      onBlur: ({ value }) => validatePublicJwk(value),
                      onSubmit: ({ value }) => validatePublicJwk(value),
                    }}
                  >
                    {(field) => (
                      <TextArea
                        isRequired
                        label="Public JWK JSON"
                        onBlur={field.handleBlur}
                        onChange={field.handleChange}
                        placeholder={'{"kty":"EC","crv":"P-256","x":"…","y":"…"}'}
                        rows={7}
                        {...fieldStatusProps(field)}
                        value={field.state.value}
                      />
                    )}
                  </machineForm.Field>
                </FormLayout>
              </section>

              <hr className="border-border m-0 border-0 border-t" />
              <section className="grid gap-4" aria-labelledby="initial-access-title">
                <SectionHeading
                  description="Select resources and scopes independently. Requested scopes must be supported by the requested resource."
                  id="initial-access-title"
                  title="Machine access"
                />
                <AccessOptionsError query={accessOptionsQuery} />
                <FormLayout>
                  <machineForm.Field name="resourceIds">
                    {(field) => (
                      <MultiSelector
                        hasClear
                        hasSearch
                        hasSelectAll
                        label="Resources"
                        onChange={field.handleChange}
                        options={resourceOptions}
                        placeholder="Choose resources…"
                        searchPlaceholder="Find resources…"
                        triggerDisplay="badges"
                        value={field.state.value}
                        width="100%"
                      />
                    )}
                  </machineForm.Field>
                  <machineForm.Field name="scopeIds">
                    {(field) => (
                      <MultiSelector
                        hasClear
                        hasSearch
                        hasSelectAll
                        label="Scopes"
                        onChange={field.handleChange}
                        options={scopeOptions}
                        placeholder="Choose scopes…"
                        searchPlaceholder="Find scopes…"
                        triggerDisplay="badges"
                        value={field.state.value}
                        width="100%"
                      />
                    )}
                  </machineForm.Field>
                </FormLayout>
              </section>
            </>
          ) : null}
        </form>

        {!isNew && machine ? (
          <>
            <hr className="border-border m-0 border-0 border-t" />
            <section className="grid gap-4" aria-labelledby="registered-keys-title">
              <SectionHeading
                description="Overlapping active keys allow zero-downtime rotation. Revoke the old key after every caller has switched."
                id="registered-keys-title"
                title="Registered public keys"
              />
              <RegisteredKeysTable
                keys={machine.keys}
                isRevoking={revokeKeyMutation.isPending}
                onRevoke={setKeyToRevoke}
              />
              <form
                className="admin-dialog-form"
                id={keyFormId}
                onSubmit={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void keyForm.handleSubmit();
                }}
              >
                <FormLayout>
                  <keyForm.Field
                    name="kid"
                    validators={{
                      onBlur: ({ value }) => validateKid(value),
                      onChange: ({ value }) => validateKid(value),
                      onSubmit: ({ value }) => validateKid(value),
                    }}
                  >
                    {(field) => (
                      <TextInput
                        isRequired
                        label="New key ID (kid)"
                        onBlur={field.handleBlur}
                        onChange={field.handleChange}
                        placeholder="expenses-a-2026-02"
                        {...fieldStatusProps(field)}
                        value={field.state.value}
                        width="100%"
                      />
                    )}
                  </keyForm.Field>
                  <keyForm.Field
                    name="publicJwk"
                    validators={{
                      onBlur: ({ value }) => validatePublicJwk(value),
                      onSubmit: ({ value }) => validatePublicJwk(value),
                    }}
                  >
                    {(field) => (
                      <TextArea
                        isRequired
                        label="New public JWK JSON"
                        onBlur={field.handleBlur}
                        onChange={field.handleChange}
                        placeholder={'{"kty":"EC","crv":"P-256","x":"…","y":"…"}'}
                        rows={7}
                        {...fieldStatusProps(field)}
                        value={field.state.value}
                      />
                    )}
                  </keyForm.Field>
                </FormLayout>
                <div className="flex justify-end">
                  <keyForm.Subscribe selector={(state) => state.canSubmit}>
                    {(canSubmit) => (
                      <Button
                        form={keyFormId}
                        isDisabled={!canSubmit}
                        isLoading={registerKeyMutation.isPending}
                        label="Register public key"
                        type="submit"
                        variant="secondary"
                      />
                    )}
                  </keyForm.Subscribe>
                </div>
              </form>
            </section>

            <hr className="border-border m-0 border-0 border-t" />
            <section className="grid gap-4" aria-labelledby="machine-access-title">
              <SectionHeading
                description="Select resources and scopes independently. Requested scopes must be supported by the requested resource."
                id="machine-access-title"
                title="Machine access"
              />
              <AccessOptionsError query={accessOptionsQuery} />
              <form
                className="admin-dialog-form"
                id={accessFormId}
                onSubmit={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void accessForm.handleSubmit();
                }}
              >
                <FormLayout>
                  <accessForm.Field name="resourceIds">
                    {(field) => (
                      <MultiSelector
                        hasClear
                        hasSearch
                        hasSelectAll
                        label="Resources"
                        onChange={field.handleChange}
                        options={resourceOptions}
                        placeholder="Choose resources…"
                        searchPlaceholder="Find resources…"
                        triggerDisplay="badges"
                        value={field.state.value}
                        width="100%"
                      />
                    )}
                  </accessForm.Field>
                  <accessForm.Field name="scopeIds">
                    {(field) => (
                      <MultiSelector
                        hasClear
                        hasSearch
                        hasSelectAll
                        label="Scopes"
                        onChange={field.handleChange}
                        options={scopeOptions}
                        placeholder="Choose scopes…"
                        searchPlaceholder="Find scopes…"
                        triggerDisplay="badges"
                        value={field.state.value}
                        width="100%"
                      />
                    )}
                  </accessForm.Field>
                </FormLayout>
                <div className="flex justify-end">
                  <accessForm.Subscribe selector={(state) => state.canSubmit}>
                    {(canSubmit) => (
                      <Button
                        form={accessFormId}
                        isDisabled={
                          !canSubmit ||
                          accessOptionsQuery.isPending ||
                          Boolean(accessOptionsQuery.error)
                        }
                        isLoading={replaceAccessMutation.isPending}
                        label="Save access"
                        type="submit"
                        variant="primary"
                      />
                    )}
                  </accessForm.Subscribe>
                </div>
              </form>
            </section>
          </>
        ) : null}
      </div>

      <AlertDialog
        actionLabel="Revoke public key"
        description={
          keyToRevoke
            ? `Revoke ${keyToRevoke.kid}? Tokens signed with this key will no longer be accepted.`
            : "Revoke this public key?"
        }
        isActionLoading={revokeKeyMutation.isPending}
        isOpen={Boolean(keyToRevoke)}
        onAction={() => {
          if (machine && keyToRevoke) {
            revokeKeyMutation.mutate({ clientId: machine.id, keyId: keyToRevoke.id });
          }
        }}
        onOpenChange={(open) => {
          if (!open && !revokeKeyMutation.isPending) {
            revokeKeyMutation.reset();
            setKeyToRevoke(null);
          }
        }}
        title="Revoke public key?"
      />
    </>
  );
}

function SectionHeading({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description: string;
}) {
  return (
    <div className="grid gap-1">
      <h2 className="m-0 text-xl font-semibold" id={id}>
        {title}
      </h2>
      <Text color="secondary">{description}</Text>
    </div>
  );
}

function AccessOptionsError({ query }: { query: { error: { message: string } | null } }) {
  return query.error ? (
    <Banner
      container="card"
      description={query.error.message}
      status="error"
      title="Could not load access options"
    />
  ) : null;
}

function RegisteredKeysTable({
  keys,
  isRevoking,
  onRevoke,
}: {
  keys: MachineClientDto["keys"];
  isRevoking: boolean;
  onRevoke: (key: MachineClientDto["keys"][number]) => void;
}) {
  return (
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
      <div className="w-full overflow-x-auto" role="group" aria-label="Registered public keys">
        <table className="w-full min-w-[720px] border-collapse text-left">
          <TableHeader>
            <TableRow isHeaderRow>
              <TableHeaderCell scope="col">Key ID</TableHeaderCell>
              <TableHeaderCell scope="col">Status</TableHeaderCell>
              <TableHeaderCell scope="col">Thumbprint</TableHeaderCell>
              <TableHeaderCell scope="col">Registered</TableHeaderCell>
              <TableHeaderCell scope="col" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell>
                  <code className="text-sm">{key.kid}</code>
                </TableCell>
                <TableCell>
                  <Badge
                    label={key.revokedAt ? "Revoked" : "Active"}
                    variant={key.revokedAt ? "purple" : "success"}
                  />
                </TableCell>
                <TableCell>
                  <code className="text-xs">{key.thumbprint}</code>
                </TableCell>
                <TableCell>{dateFormatter.format(new Date(key.createdAt))}</TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    {!key.revokedAt ? (
                      <Button
                        isDisabled={isRevoking}
                        label="Revoke"
                        onClick={() => onRevoke(key)}
                        size="sm"
                        variant="destructive"
                      />
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </table>
      </div>
    </TableContext.Provider>
  );
}

function validateClientId(value: unknown): string | undefined {
  const clientId = String(value).trim();
  if (!clientId) return "Client ID is required.";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(clientId)
    ? undefined
    : "Use 1–128 letters, numbers, dots, dashes, underscores, or colons.";
}

function validateKid(value: unknown): string | undefined {
  const kid = String(value).trim();
  if (!kid) return "Key ID is required.";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(kid)
    ? undefined
    : "Use 1–128 letters, numbers, dots, dashes, underscores, or colons.";
}

function validateRequiredText(value: unknown, label: string, maxLength: number) {
  const text = String(value).trim();
  if (!text) return `${label} is required.`;
  return text.length <= maxLength ? undefined : `${label} must be ${maxLength} characters or less.`;
}

function validatePublicJwk(value: unknown): string | undefined {
  const text = String(value).trim();
  if (!text) return "Public JWK JSON is required.";
  try {
    const jwk = JSON.parse(text) as unknown;
    if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) {
      return "Public JWK must be a JSON object.";
    }
    if ("d" in jwk) return "Paste a public JWK only; private key material is not allowed.";
    if (!("kty" in jwk) || jwk.kty !== "EC" || !("crv" in jwk) || jwk.crv !== "P-256") {
      return "Public JWK must use an ES256 P-256 key (kty EC, crv P-256).";
    }
    if (!("x" in jwk) || typeof jwk.x !== "string" || !("y" in jwk) || typeof jwk.y !== "string") {
      return "Public JWK must include string x and y coordinates.";
    }
    return undefined;
  } catch {
    return "Public JWK must be valid JSON.";
  }
}

function parsePublicJwk(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function fieldStatusProps(field: AnyFieldApi) {
  const messages = field.state.meta.errors
    .map(errorMessage)
    .filter((message): message is string => Boolean(message));
  return field.state.meta.isValid || messages.length === 0
    ? {}
    : { status: { type: "error" as const, message: messages.join(", ") } };
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return typeof error.message === "string" ? error.message : undefined;
  }
  return undefined;
}
