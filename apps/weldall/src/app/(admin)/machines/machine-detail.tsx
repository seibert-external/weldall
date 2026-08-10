"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";

export function MachineDetail({ machineId }: { machineId: string | null }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const isNew = machineId === null;
  const machine = useQuery({
    ...trpc.admin.machineClients.get.queryOptions({ id: machineId ?? "new" }),
    enabled: !isNew,
  });
  const accessOptions = useQuery(trpc.admin.machineClients.accessOptions.queryOptions());
  const [clientId, setClientId] = useState("");
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [kid, setKid] = useState("");
  const [publicJwk, setPublicJwk] = useState("");
  const [resourceIds, setResourceIds] = useState<string[]>([]);
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const serverClientId = machine.data?.clientId;
  const serverName = machine.data?.name;
  const serverEnabled = machine.data?.enabled;
  const serverResourceIds = machine.data
    ? JSON.stringify([...machine.data.access.resourceIds].sort())
    : undefined;
  const serverScopeIds = machine.data
    ? JSON.stringify([...machine.data.access.scopeIds].sort())
    : undefined;

  useEffect(() => {
    if (serverClientId === undefined || serverName === undefined || serverEnabled === undefined)
      return;
    setClientId(serverClientId);
    setName(serverName);
    setEnabled(serverEnabled);
  }, [serverClientId, serverName, serverEnabled]);

  useEffect(() => {
    if (serverResourceIds === undefined || serverScopeIds === undefined) return;
    setResourceIds(JSON.parse(serverResourceIds) as string[]);
    setScopeIds(JSON.parse(serverScopeIds) as string[]);
  }, [serverResourceIds, serverScopeIds]);

  const invalidate = async () => queryClient.invalidateQueries();
  const create = useMutation(
    trpc.admin.machineClients.create.mutationOptions({
      onSuccess: async (created) => {
        await invalidate();
        router.push(`/machines/${created.id}`);
      },
    }),
  );
  const update = useMutation(
    trpc.admin.machineClients.update.mutationOptions({ onSuccess: invalidate }),
  );
  const registerKey = useMutation(
    trpc.admin.machineClients.registerKey.mutationOptions({
      onSuccess: async () => {
        setKid("");
        setPublicJwk("");
        await invalidate();
      },
    }),
  );
  const revokeKey = useMutation(
    trpc.admin.machineClients.revokeKey.mutationOptions({ onSuccess: invalidate }),
  );
  const replaceAccess = useMutation(
    trpc.admin.machineClients.replaceAccess.mutationOptions({ onSuccess: invalidate }),
  );

  const error =
    localError ??
    create.error?.message ??
    update.error?.message ??
    registerKey.error?.message ??
    revokeKey.error?.message ??
    replaceAccess.error?.message ??
    machine.error?.message ??
    accessOptions.error?.message;
  const pending =
    create.isPending ||
    update.isPending ||
    registerKey.isPending ||
    revokeKey.isPending ||
    replaceAccess.isPending;

  const parseJwk = () => {
    try {
      const value = JSON.parse(publicJwk) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      setLocalError("Public JWK must be a JSON object. Never paste a private JWK containing d.");
      return null;
    }
  };
  const submit = async () => {
    setLocalError(null);
    if (isNew) {
      const jwk = parseJwk();
      if (!jwk) return;
      await create.mutateAsync({
        clientId: clientId.trim(),
        name: name.trim(),
        key: { kid: kid.trim(), publicJwk: jwk },
        access: { resourceIds, scopeIds },
      });
      return;
    }
    if (!machine.data) return;
    await update.mutateAsync({
      id: machine.data.id,
      name: name.trim(),
      enabled,
      expectedVersion: machine.data.version,
    });
  };
  const rotate = async () => {
    if (!machine.data) return;
    setLocalError(null);
    const jwk = parseJwk();
    if (!jwk) return;
    await registerKey.mutateAsync({
      clientId: machine.data.id,
      kid: kid.trim(),
      publicJwk: jwk,
    });
  };
  const saveAccess = async () => {
    if (!machine.data) return;
    await replaceAccess.mutateAsync({
      clientId: machine.data.id,
      resourceIds,
      scopeIds,
      expectedVersion: machine.data.version,
    });
  };

  if (!isNew && machine.isPending) return <Text color="secondary">Loading machine…</Text>;
  return (
    <>
      <HerocrumbsActions>
        <Button href="/machines" label="Back" variant="secondary" />
        <Button
          isDisabled={pending}
          label={isNew ? "Register machine" : "Save machine"}
          onClick={() => void submit()}
          variant="primary"
        />
      </HerocrumbsActions>
      {error ? (
        <Banner
          container="card"
          status="error"
          title="Machine operation failed"
          description={error}
        />
      ) : null}
      <section className="grid gap-4 rounded-md border p-5">
        <div>
          <h2 className="m-0 text-xl font-semibold">
            {isNew ? "Register machine client" : machine.data?.name}
          </h2>
          <Text color="secondary">
            Machines authenticate with registered public keys. Weldall never stores private key
            material.
          </Text>
        </div>
        <TextInput
          isDisabled={!isNew}
          isRequired
          label="Client ID"
          onChange={setClientId}
          placeholder="expenses-a"
          value={clientId}
          width="100%"
        />
        <TextInput
          isRequired
          label="Name"
          onChange={setName}
          placeholder="Expenses A"
          value={name}
          width="100%"
        />
        {!isNew ? (
          <Switch
            description="Deactivation blocks new tokens immediately; existing tokens expire within five minutes."
            label="Enabled"
            labelPosition="start"
            labelSpacing="spread"
            onChange={setEnabled}
            value={enabled}
            width="100%"
          />
        ) : null}
      </section>

      <KeyEditor
        kid={kid}
        publicJwk={publicJwk}
        setKid={setKid}
        setPublicJwk={setPublicJwk}
        {...(!isNew ? { onRegister: rotate } : {})}
        pending={pending}
      />

      {!isNew && machine.data ? (
        <section className="grid gap-3 rounded-md border p-5">
          <h2 className="m-0 text-xl font-semibold">Registered keys</h2>
          {machine.data.keys.map((key) => (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              key={key.id}
            >
              <div className="grid gap-1">
                <div className="flex items-center gap-2">
                  <code>{key.kid}</code>
                  <Badge
                    label={key.revokedAt ? "Revoked" : "Active"}
                    variant={key.revokedAt ? "purple" : "neutral"}
                  />
                </div>
                <Text color="secondary">
                  Thumbprint {key.thumbprint} · Registered{" "}
                  {new Date(key.createdAt).toLocaleString()}
                </Text>
              </div>
              {!key.revokedAt ? (
                <Button
                  isDisabled={pending}
                  label="Revoke"
                  onClick={() => revokeKey.mutate({ clientId: machine.data!.id, keyId: key.id })}
                  size="sm"
                  variant="destructive"
                />
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <section className="grid gap-4 rounded-md border p-5">
        <div>
          <h2 className="m-0 text-xl font-semibold">Machine access</h2>
          <Text color="secondary">
            Select resources and scopes independently. A token is issued only when the requested
            resource supports every requested scope.
          </Text>
        </div>
        <MultiSelector
          hasClear
          hasSearch
          hasSelectAll
          label="Resources"
          onChange={setResourceIds}
          options={(accessOptions.data?.resources ?? []).map((resource) => ({
            value: resource.id,
            label: `${resource.name} — ${resource.resourceIdentifier}${resource.enabled ? "" : " (disabled)"}`,
            disabled: !resource.enabled && !resourceIds.includes(resource.id),
          }))}
          placeholder="Choose resources…"
          searchPlaceholder="Find resources…"
          triggerDisplay="badges"
          value={resourceIds}
          width="100%"
        />
        <MultiSelector
          hasClear
          hasSearch
          hasSelectAll
          label="Scopes"
          onChange={setScopeIds}
          options={(accessOptions.data?.scopes ?? []).map((scope) => ({
            value: scope.id,
            label: scope.key,
          }))}
          placeholder="Choose scopes…"
          searchPlaceholder="Find scopes…"
          triggerDisplay="badges"
          value={scopeIds}
          width="100%"
        />
        {!isNew ? (
          <Button
            isDisabled={pending}
            label="Save access"
            onClick={() => void saveAccess()}
            variant="primary"
          />
        ) : null}
      </section>
    </>
  );
}

function KeyEditor(props: {
  kid: string;
  publicJwk: string;
  setKid: (value: string) => void;
  setPublicJwk: (value: string) => void;
  onRegister?: () => Promise<void>;
  pending: boolean;
}) {
  return (
    <section className="grid gap-4 rounded-md border p-5">
      <div>
        <h2 className="m-0 text-xl font-semibold">
          {props.onRegister ? "Rotate key" : "Initial public key"}
        </h2>
        <Text color="secondary">
          Register an ES256 P-256 public JWK. New keys are active immediately, and overlapping keys
          support rotation until the old key is revoked.
        </Text>
      </div>
      <TextInput
        isRequired
        label="Key ID (kid)"
        onChange={props.setKid}
        placeholder="expenses-a-2026-01"
        value={props.kid}
        width="100%"
      />
      <TextArea
        isRequired
        label="Public JWK JSON"
        onChange={props.setPublicJwk}
        placeholder='{"kty":"EC","crv":"P-256","x":"…","y":"…"}'
        rows={5}
        value={props.publicJwk}
      />
      {props.onRegister ? (
        <Button
          isDisabled={props.pending}
          label="Register overlapping key"
          onClick={() => void props.onRegister!()}
          variant="secondary"
        />
      ) : null}
    </section>
  );
}
