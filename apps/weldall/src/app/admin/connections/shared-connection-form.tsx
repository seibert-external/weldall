"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { ScopeChecklist } from "../../_components/scope-checklist";
import { useTRPC } from "@/trpc/react";
import type { ConnectionRow } from "./connection-view";

const warning =
  "Token permissions are managed in Atlassian, not Weldall. Some tools require OAuth; API-key calls may require explicit cloudId arguments. Revoke keys in Atlassian administration: disabling or deleting here only blocks Weldall access.";

export function SharedConnectionForm({
  connection,
  onSaved,
}: {
  connection?: ConnectionRow;
  onSaved?: () => void;
}) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const configuration = useQuery(trpc.admin.managed.configuration.queryOptions());
  const scopes = useQuery(trpc.admin.scopes.options.queryOptions());
  const connectors =
    configuration.data?.connectors.filter(
      (row) => row.config.enabled && row.staticProvisioning && row.config.type === "atlassian-mcp",
    ) ?? [];
  const [connectorId, setConnectorId] = useState("");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [useScopes, setUseScopes] = useState(connection?.useScopes ?? []);
  const [cloudIds, setCloudIds] = useState("");
  const saved = async () => {
    setApiKey("");
    await Promise.all([
      client.invalidateQueries({ queryKey: trpc.admin.managed.connections.queryKey() }),
      client.invalidateQueries({ queryKey: trpc.admin.managed.connection.queryKey() }),
    ]);
    onSaved?.();
  };
  const create = useMutation(
    trpc.admin.managed.createSharedConnection.mutationOptions({
      gcTime: 0,
      onMutate: () => setCredentialError(null),
      onError: (error) => setCredentialError(error.message),
      onSuccess: saved,
      onSettled: () => {
        setApiKey("");
        create.reset();
      },
    }),
  );
  const access = useMutation(
    trpc.admin.managed.updateSharedAccess.mutationOptions({ onSuccess: saved }),
  );
  const rotate = useMutation(
    trpc.admin.managed.rotateSharedCredential.mutationOptions({
      gcTime: 0,
      onMutate: () => setCredentialError(null),
      onError: (error) => setCredentialError(error.message),
      onSuccess: saved,
      onSettled: () => {
        setApiKey("");
        rotate.reset();
      },
    }),
  );
  const activation = useMutation(
    trpc.admin.managed.setSharedConnectionEnabled.mutationOptions({ onSuccess: saved }),
  );
  const busy = create.isPending || access.isPending || rotate.isPending || activation.isPending;
  const error =
    create.error ??
    access.error ??
    rotate.error ??
    activation.error ??
    configuration.error ??
    scopes.error;
  return (
    <section
      className="grid gap-4"
      aria-label={connection ? "Manage shared connection" : "Add shared connection"}
    >
      <Banner status="warning" title="Atlassian service account API key" description={warning} />
      {!connection ? (
        <>
          <Selector
            hasClear
            label="Connector"
            value={connectorId || null}
            options={connectors.map((row) => ({ value: row.id, label: row.config.name }))}
            onChange={(id) => setConnectorId(id ?? "")}
          />
          <TextInput
            label="Connection identifier (not the API token)"
            placeholder="e.g. jira-team-bot"
            isRequired
            value={key}
            onChange={setKey}
          />
          <Text color="secondary">
            A unique, permanent name used by apps and SDKs to select this connection. This is not a
            secret.
          </Text>
          <TextInput label="Display name" isRequired value={name} onChange={setName} />
          <TextInput
            label="Configured cloud IDs (comma-separated, optional)"
            value={cloudIds}
            onChange={setCloudIds}
          />
        </>
      ) : null}
      <Text color="secondary">
        Weldall use scopes control who can use this connection, not the token’s Atlassian
        permissions.
      </Text>
      <ScopeChecklist
        value={useScopes}
        onChange={setUseScopes}
        scopes={(scopes.data ?? []).filter((scope) => !scope.isSystem)}
        isLoading={scopes.isPending}
        error={useScopes.length ? undefined : "Select at least one Weldall use scope."}
      />
      {connection ? (
        <Button
          label="Save use scopes"
          isDisabled={busy || !useScopes.length}
          onClick={() =>
            access.mutate({
              id: connection.id,
              version: connection.version,
              useScopeKeys: useScopes,
            })
          }
        />
      ) : null}
      <TextInput
        label={connection ? "New Atlassian API token (secret)" : "Atlassian API token (secret)"}
        type="password"
        value={apiKey}
        onChange={setApiKey}
      />
      {connection ? (
        <div className="flex gap-2">
          <Button
            label="Rotate API key"
            isDisabled={busy || !apiKey}
            onClick={() => {
              rotate.mutate({
                id: connection.id,
                version: connection.version,
                providerInput: { apiKey },
              });
              setApiKey("");
            }}
          />
          <Button
            label={connection.status === "DISABLED" ? "Enable connection" : "Disable connection"}
            variant={connection.status === "DISABLED" ? "primary" : "destructive"}
            isDisabled={busy || !["READY", "DISABLED"].includes(connection.status)}
            onClick={() =>
              activation.mutate({
                id: connection.id,
                version: connection.version,
                enabled: connection.status === "DISABLED",
              })
            }
          />
        </div>
      ) : (
        <Button
          label="Create shared connection"
          isDisabled={busy || !connectorId || !key || !name || !apiKey || !useScopes.length}
          onClick={() => {
            create.mutate({
              connectorId,
              key,
              name,
              useScopeKeys: useScopes,
              providerInput: {
                kind: "service-account-api-key",
                apiKey,
                cloudIds: cloudIds
                  .split(",")
                  .map((id) => id.trim())
                  .filter(Boolean),
              },
            });
            setApiKey("");
          }}
        />
      )}
      {error || credentialError ? (
        <Banner
          status="error"
          title="Shared connection could not be saved"
          description={credentialError ?? error?.message ?? "Please reload and retry."}
        />
      ) : null}
    </section>
  );
}
