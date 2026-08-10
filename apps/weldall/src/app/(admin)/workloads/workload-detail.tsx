"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/react";
import { HerocrumbsActions } from "../../_components/herocrumbs";

export function WorkloadDetail({ workloadId }: { workloadId: string | null }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const isNew = workloadId === null;
  const workload = useQuery({
    ...trpc.admin.workloadClients.get.queryOptions({ id: workloadId ?? "new" }),
    enabled: !isNew,
  });
  const resourceOptions = useQuery(trpc.admin.workloadClients.resourceOptions.queryOptions());
  const [clientId, setClientId] = useState("");
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [kid, setKid] = useState("");
  const [publicJwk, setPublicJwk] = useState("");
  const [notBefore, setNotBefore] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!workload.data) return;
    setClientId(workload.data.clientId);
    setName(workload.data.name);
    setEnabled(workload.data.enabled);
  }, [workload.data]);

  const invalidate = async () => queryClient.invalidateQueries();
  const create = useMutation(
    trpc.admin.workloadClients.create.mutationOptions({
      onSuccess: async (created) => {
        await invalidate();
        router.push(`/workloads/${created.id}`);
      },
    }),
  );
  const update = useMutation(
    trpc.admin.workloadClients.update.mutationOptions({ onSuccess: invalidate }),
  );
  const registerKey = useMutation(
    trpc.admin.workloadClients.registerKey.mutationOptions({
      onSuccess: async () => {
        setKid("");
        setPublicJwk("");
        setNotBefore("");
        setExpiresAt("");
        await invalidate();
      },
    }),
  );
  const revokeKey = useMutation(
    trpc.admin.workloadClients.revokeKey.mutationOptions({ onSuccess: invalidate }),
  );
  const replaceGrant = useMutation(
    trpc.admin.workloadClients.replaceGrant.mutationOptions({
      onSuccess: async () => {
        setScopeIds([]);
        await invalidate();
      },
    }),
  );

  const selectedResource = resourceOptions.data?.find((resource) => resource.id === resourceId);
  const error =
    localError ??
    create.error?.message ??
    update.error?.message ??
    registerKey.error?.message ??
    revokeKey.error?.message ??
    replaceGrant.error?.message ??
    workload.error?.message ??
    resourceOptions.error?.message;
  const pending =
    create.isPending ||
    update.isPending ||
    registerKey.isPending ||
    revokeKey.isPending ||
    replaceGrant.isPending;

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
  const keyDates = () => ({
    ...(notBefore ? { notBefore: new Date(notBefore).toISOString() } : {}),
    ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
  });
  const submit = async () => {
    setLocalError(null);
    if (isNew) {
      const jwk = parseJwk();
      if (!jwk) return;
      await create.mutateAsync({
        clientId: clientId.trim(),
        name: name.trim(),
        key: { kid: kid.trim(), publicJwk: jwk, ...keyDates() },
        grants: resourceId ? [{ resourceId, scopeIds }] : [],
      });
      return;
    }
    if (!workload.data) return;
    await update.mutateAsync({
      id: workload.data.id,
      name: name.trim(),
      enabled,
      expectedVersion: workload.data.version,
    });
  };
  const rotate = async () => {
    if (!workload.data) return;
    setLocalError(null);
    const jwk = parseJwk();
    if (!jwk) return;
    await registerKey.mutateAsync({
      clientId: workload.data.id,
      kid: kid.trim(),
      publicJwk: jwk,
      ...keyDates(),
    });
  };
  const saveGrant = async () => {
    if (!workload.data || !resourceId) return;
    const current = workload.data.grants.find((grant) => grant.resourceId === resourceId);
    await replaceGrant.mutateAsync({
      clientId: workload.data.id,
      resourceId,
      scopeIds,
      expectedVersion: current?.version ?? null,
    });
  };

  if (!isNew && workload.isPending) return <Text color="secondary">Loading workload…</Text>;
  return (
    <>
      <HerocrumbsActions>
        <Button href="/workloads" label="Back" variant="secondary" />
        <Button
          isDisabled={pending}
          label={isNew ? "Register workload" : "Save workload"}
          onClick={() => void submit()}
          variant="primary"
        />
      </HerocrumbsActions>
      {error ? (
        <Banner
          container="card"
          status="error"
          title="Workload operation failed"
          description={error}
        />
      ) : null}
      <section className="grid gap-4 rounded-md border p-5">
        <div>
          <h2 className="m-0 text-xl font-semibold">
            {isNew ? "Register workload client" : workload.data?.name}
          </h2>
          <Text color="secondary">
            Workloads authenticate with registered public keys. Weldall never stores private key
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
        notBefore={notBefore}
        expiresAt={expiresAt}
        setKid={setKid}
        setPublicJwk={setPublicJwk}
        setNotBefore={setNotBefore}
        setExpiresAt={setExpiresAt}
        {...(!isNew ? { onRegister: rotate } : {})}
        pending={pending}
      />

      {!isNew && workload.data ? (
        <section className="grid gap-3 rounded-md border p-5">
          <h2 className="m-0 text-xl font-semibold">Registered keys</h2>
          {workload.data.keys.map((key) => (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              key={key.id}
            >
              <div className="grid gap-1">
                <div className="flex items-center gap-2">
                  <code>{key.kid}</code>
                  <Badge
                    label={key.revokedAt ? "Revoked" : "Active/dated"}
                    variant={key.revokedAt ? "purple" : "neutral"}
                  />
                </div>
                <Text color="secondary">
                  Thumbprint {key.thumbprint} · Active {new Date(key.notBefore).toLocaleString()} ·
                  Expires {key.expiresAt ? new Date(key.expiresAt).toLocaleString() : "never"}
                </Text>
              </div>
              {!key.revokedAt ? (
                <Button
                  isDisabled={pending}
                  label="Revoke"
                  onClick={() => revokeKey.mutate({ clientId: workload.data!.id, keyId: key.id })}
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
          <h2 className="m-0 text-xl font-semibold">Explicit resource grant</h2>
          <Text color="secondary">
            A registered resource or scope grants nothing until it is selected here.
          </Text>
        </div>
        <label className="grid gap-1 text-sm font-medium">
          Resource
          <select
            className="rounded-md border bg-transparent p-2"
            onChange={(event) => {
              const nextResourceId = event.target.value;
              setResourceId(nextResourceId);
              setScopeIds(
                workload.data?.grants.find((grant) => grant.resourceId === nextResourceId)
                  ?.scopeIds ?? [],
              );
            }}
            value={resourceId}
          >
            <option value="">No resource</option>
            {resourceOptions.data?.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name} — {resource.resourceIdentifier}
              </option>
            ))}
          </select>
        </label>
        {selectedResource ? (
          <div className="grid gap-2">
            <span className="text-sm font-medium">Granted scopes</span>
            {selectedResource.scopes.map((scope) => (
              <label className="flex items-center gap-2" key={scope.id}>
                <input
                  checked={scopeIds.includes(scope.id)}
                  onChange={(event) =>
                    setScopeIds((current) =>
                      event.target.checked
                        ? [...current, scope.id]
                        : current.filter((value) => value !== scope.id),
                    )
                  }
                  type="checkbox"
                />
                {scope.key}
              </label>
            ))}
          </div>
        ) : null}
        {!isNew ? (
          <Button
            isDisabled={!resourceId || pending}
            label={scopeIds.length ? "Replace grant" : "Revoke grant"}
            onClick={() => void saveGrant()}
            variant={scopeIds.length ? "primary" : "destructive"}
          />
        ) : null}
        {!isNew && workload.data?.grants.length ? (
          <div className="grid gap-2">
            {workload.data.grants.map((grant) => (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                key={grant.id}
              >
                <div>
                  <strong>{grant.resourceName}</strong>{" "}
                  <Badge
                    label={grant.enabled ? "Granted" : "Revoked"}
                    variant={grant.enabled ? "neutral" : "purple"}
                  />
                  <div className="mt-1 text-sm">{grant.scopeKeys.join(", ") || "No scopes"}</div>
                </div>
                {grant.enabled ? (
                  <Button
                    isDisabled={pending}
                    label="Revoke grant"
                    onClick={() =>
                      replaceGrant.mutate({
                        clientId: workload.data!.id,
                        resourceId: grant.resourceId,
                        scopeIds: [],
                        expectedVersion: grant.version,
                      })
                    }
                    size="sm"
                    variant="destructive"
                  />
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </>
  );
}

function KeyEditor(props: {
  kid: string;
  publicJwk: string;
  notBefore: string;
  expiresAt: string;
  setKid: (value: string) => void;
  setPublicJwk: (value: string) => void;
  setNotBefore: (value: string) => void;
  setExpiresAt: (value: string) => void;
  onRegister?: () => Promise<void>;
  pending: boolean;
}) {
  const dateType = useMemo(() => "datetime-local" as const, []);
  return (
    <section className="grid gap-4 rounded-md border p-5">
      <div>
        <h2 className="m-0 text-xl font-semibold">
          {props.onRegister ? "Rotate key" : "Initial public key"}
        </h2>
        <Text color="secondary">
          Register an ES256 P-256 public JWK. Rotation supports overlapping activation windows.
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
      <div className="grid gap-3 md:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium">
          Active from
          <input
            className="rounded-md border bg-transparent p-2"
            onChange={(event) => props.setNotBefore(event.target.value)}
            type={dateType}
            value={props.notBefore}
          />
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Expires (optional)
          <input
            className="rounded-md border bg-transparent p-2"
            onChange={(event) => props.setExpiresAt(event.target.value)}
            type={dateType}
            value={props.expiresAt}
          />
        </label>
      </div>
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
