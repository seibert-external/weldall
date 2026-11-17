"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { TextInput } from "@astryxdesign/core/TextInput";
import { FileInput } from "@astryxdesign/core/FileInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { Switch } from "@astryxdesign/core/Switch";
import { ScopeChecklist } from "../../_components/scope-checklist";
import { useTRPC } from "@/trpc/react";
import type { ConnectionRow } from "./connection-view";

const warning =
  "Token permissions are managed in Atlassian, not Weldall. Some tools require OAuth; API-key calls may require explicit cloudId arguments. Revoke keys in Atlassian administration: disabling or deleting here only blocks Weldall access.";
const githubWarning =
  "The App's permissions are managed in GitHub, not Weldall. Weldall keeps the key on the server and mints short-lived tokens for one repository at a time. Revoke keys in the App settings on GitHub: disabling or deleting here only blocks Weldall access.";

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
  const connectors = configuration.data?.connectors.filter((row) => row.staticProvisioning) ?? [];
  const [connectorId, setConnectorId] = useState("");
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const isGitHubApp =
    connectors.find((row) => row.id === (connection?.connectorId ?? connectorId))?.config.type ===
    "github-app";
  const credentialLabel = isGitHubApp ? "private key" : "API key";
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [useScopes, setUseScopes] = useState(connection?.useScopes ?? []);
  const [cloudIds, setCloudIds] = useState("");
  const saved = async () => {
    setApiKey("");
    setKeyFile(null);
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
      <Banner
        status="warning"
        title={isGitHubApp ? "GitHub App private key" : "Atlassian service account API key"}
        description={isGitHubApp ? githubWarning : warning}
      />
      <Text color="secondary">
        IaC manages public configuration only and may reset public UI changes. Provisioning a
        credential does not enable a disabled connection.
      </Text>
      {connection && !connection.hasCredential ? (
        <Banner
          status="warning"
          title="Disabled — credential missing"
          description={`Provision the ${credentialLabel} here, then explicitly enable the connection.`}
        />
      ) : null}
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
          {isGitHubApp ? null : (
            <TextInput
              label="Configured cloud IDs (comma-separated, optional)"
              value={cloudIds}
              onChange={setCloudIds}
            />
          )}
        </>
      ) : null}
      <Text color="secondary">
        {isGitHubApp
          ? "Weldall use scopes control who can use this connection, not the App’s GitHub permissions."
          : "Weldall use scopes control who can use this connection, not the token’s Atlassian permissions."}
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
      {isGitHubApp ? (
        <FileInput
          label={connection ? "New GitHub App private key (.pem)" : "GitHub App private key (.pem)"}
          accept=".pem"
          maxSize={16 * 1024}
          value={keyFile}
          onChange={(file) => {
            const selected = Array.isArray(file) ? (file[0] ?? null) : file;
            setKeyFile(selected);
            setApiKey("");
            void selected?.text().then(setApiKey);
          }}
        />
      ) : (
        <TextInput
          label={connection ? "New Atlassian API token (secret)" : "Atlassian API token (secret)"}
          type="password"
          value={apiKey}
          onChange={setApiKey}
        />
      )}
      {connection ? (
        <div className="flex gap-2">
          <Button
            label={`${connection.hasCredential ? "Rotate" : "Provision"} ${credentialLabel}`}
            isDisabled={busy || !apiKey}
            onClick={() => {
              rotate.mutate({
                id: connection.id,
                version: connection.version,
                providerInput: isGitHubApp ? { privateKey: apiKey } : { apiKey },
              });
              setApiKey("");
              setKeyFile(null);
            }}
          />
          <Button
            label={!connection.enabled ? "Enable connection" : "Disable connection"}
            variant={!connection.enabled ? "primary" : "destructive"}
            isDisabled={busy || (!connection.enabled && !connection.hasCredential)}
            onClick={() =>
              activation.mutate({
                id: connection.id,
                version: connection.version,
                enabled: !connection.enabled,
              })
            }
          />
        </div>
      ) : (
        <>
          <Switch
            label="Enabled"
            value={enabled}
            onChange={setEnabled}
            description="Leave disabled to create without a credential."
          />
          <Button
            label="Create shared connection"
            isDisabled={
              busy || !connectorId || !key || !name || (enabled && !apiKey) || !useScopes.length
            }
            onClick={() => {
              create.mutate({
                connectorId,
                key,
                name,
                enabled,
                useScopeKeys: useScopes,
                providerInput: isGitHubApp
                  ? { kind: "github-app-private-key", ...(apiKey ? { privateKey: apiKey } : {}) }
                  : {
                      kind: "service-account-api-key",
                      ...(apiKey ? { apiKey } : {}),
                      cloudIds: cloudIds
                        .split(",")
                        .map((id) => id.trim())
                        .filter(Boolean),
                    },
              });
              setApiKey("");
              setKeyFile(null);
            }}
          />
        </>
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
