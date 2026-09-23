"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { useTRPC } from "@/trpc/react";
import { scopeCatalog } from "@/server/connectors/scopes";
import type { ConnectorConfig, KeyConfig } from "@/server/connectors/contracts";
import type { listConfiguration } from "@/server/connectors/configuration";

type Configuration = Awaited<ReturnType<typeof listConfiguration>>;
const newKey: KeyConfig = {
  key: "",
  name: "",
  activeVersion: "1",
  versions: { "1": { source: { type: "env", name: "" } } },
};
const newConnector: ConnectorConfig = {
  key: "",
  name: "",
  type: "google",
  enabled: false,
  encryptionKey: "",
  clientId: "",
  enabledApis: ["gmail", "calendar"],
  allowedScopes: [],
  defaultScopes: [],
};
export function ManagedConfiguration() {
  const trpc = useTRPC();
  const cache = useQueryClient();
  const query = useQuery(trpc.admin.managed.configuration.queryOptions());
  const [key, setKey] = useState<Configuration["keys"][number] | "new" | null>(null);
  const [connector, setConnector] = useState<Configuration["connectors"][number] | "new" | null>(
    null,
  );
  const refresh = () => {
    setKey(null);
    setConnector(null);
    void cache.invalidateQueries({ queryKey: trpc.admin.managed.configuration.queryKey() });
  };
  return (
    <>
      <p>
        Configuration is stored in PostgreSQL. IaC-managed objects remain editable here; the next
        approved apply restores manifest values. Key material belongs in deployment secrets, never
        in these forms.
      </p>
      {query.error && (
        <Banner
          status="error"
          title="Configuration unavailable"
          description={query.error.message}
        />
      )}
      <h2>Encryption keys</h2>
      <Button label="Add encryption key" onClick={() => setKey("new")} />
      <ul>
        {query.data?.keys.map((k) => (
          <li key={k.id}>
            <Button
              variant="secondary"
              label={`${k.config.name} (${k.config.key}) — active ${k.config.activeVersion} — ${k.available ? "available" : "unavailable"}${k.managed ? " — IaC" : ""}`}
              onClick={() => setKey(k)}
            />
          </li>
        ))}
      </ul>
      {key && (
        <KeyEditor
          key={key === "new" ? "new" : `${key.id}:${key.version}`}
          row={key === "new" ? null : key}
          done={refresh}
        />
      )}
      <h2>Google connectors</h2>
      <Button label="Add connector" onClick={() => setConnector("new")} />
      <ul>
        {query.data?.connectors.map((c) => (
          <li key={c.id}>
            <Button
              variant="secondary"
              label={`${c.config.name} — ${c.config.enabled ? "enabled" : "disabled"} — secret ${c.secretConfigured ? "configured" : "missing"}${c.managed ? " — IaC" : ""}`}
              onClick={() => setConnector(c)}
            />
          </li>
        ))}
      </ul>
      {connector && (
        <ConnectorEditor
          key={connector === "new" ? "new" : `${connector.id}:${connector.version}`}
          row={connector === "new" ? null : connector}
          keys={query.data?.keys ?? []}
          done={refresh}
        />
      )}
      <a href="/admin/connections">Inspect managed connections</a>
    </>
  );
}
function KeyEditor({ row, done }: { row: Configuration["keys"][number] | null; done: () => void }) {
  const trpc = useTRPC();
  const [value, setValue] = useState<KeyConfig>(row?.config ?? structuredClone(newKey));
  const [version, setVersion] = useState("");
  const save = useMutation(trpc.admin.managed.saveKey.mutationOptions({ onSuccess: done }));
  const remove = useMutation(trpc.admin.managed.deleteKey.mutationOptions({ onSuccess: done }));
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          ...(row ? { id: row.id } : {}),
          version: row?.version ?? null,
          config: value,
        });
      }}
    >
      <h3>{row ? "Edit" : "Create"} encryption key</h3>
      <label className="block">
        Key{" "}
        <input
          required
          disabled={Boolean(row)}
          value={value.key}
          onChange={(e) => setValue({ ...value, key: e.target.value })}
        />
      </label>
      <label className="block">
        Name{" "}
        <input
          required
          value={value.name}
          onChange={(e) => setValue({ ...value, name: e.target.value })}
        />
      </label>
      <label className="block">
        Active version{" "}
        <select
          value={value.activeVersion}
          onChange={(e) => setValue({ ...value, activeVersion: e.target.value })}
        >
          {Object.keys(value.versions).map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      {Object.entries(value.versions).map(([v, entry]) => (
        <label className="block" key={v}>
          Version {v}: approved environment variable{" "}
          <input
            required
            disabled={Boolean(row?.config.versions[v])}
            value={entry.source.name}
            onChange={(e) =>
              setValue({
                ...value,
                versions: {
                  ...value.versions,
                  [v]: { source: { type: "env", name: e.target.value } },
                },
              })
            }
          />
        </label>
      ))}
      <label>
        New version <input value={version} onChange={(e) => setVersion(e.target.value)} />
      </label>
      <Button
        type="button"
        label="Register version in form"
        isDisabled={!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(version) || version in value.versions}
        onClick={() => {
          setValue({
            ...value,
            versions: { ...value.versions, [version]: { source: { type: "env", name: "" } } },
          });
          setVersion("");
        }}
      />
      <p>
        Provision the same random key on every instance first. Activating a version does not
        re-encrypt existing values. Retain historical versions and backup key material.
      </p>
      {(save.error || remove.error) && (
        <Banner
          status="error"
          title="Key operation failed"
          description={(save.error ?? remove.error)!.message}
        />
      )}
      <Button type="submit" label="Save key" isDisabled={save.isPending || remove.isPending} />
      {row && (
        <Button
          type="button"
          label="Delete unused key"
          isDisabled={save.isPending || remove.isPending}
          onClick={() => {
            if (
              confirm(
                "Delete this unused key definition? Backups still require separately retained historical mappings and material.",
              )
            )
              remove.mutate({ id: row.id, version: row.version });
          }}
        />
      )}
    </form>
  );
}
function ConnectorEditor({
  row,
  keys,
  done,
}: {
  row: Configuration["connectors"][number] | null;
  keys: Configuration["keys"];
  done: () => void;
}) {
  const trpc = useTRPC();
  const [value, setValue] = useState<ConnectorConfig>(row?.config ?? structuredClone(newConnector));
  const [secret, setSecret] = useState("");
  const save = useMutation(trpc.admin.managed.saveConnector.mutationOptions({ onSuccess: done }));
  const provision = useMutation(
    trpc.admin.managed.secret.mutationOptions({
      onSuccess: () => {
        setSecret("");
        done();
      },
    }),
  );
  const rotate = useMutation(trpc.admin.managed.reencrypt.mutationOptions({ onSuccess: done }));
  const remove = useMutation(
    trpc.admin.managed.deleteConnector.mutationOptions({ onSuccess: done }),
  );
  const busy = save.isPending || provision.isPending || rotate.isPending || remove.isPending;
  const error = save.error ?? provision.error ?? rotate.error ?? remove.error;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          ...(row ? { id: row.id } : {}),
          version: row?.version ?? null,
          config: value,
        });
      }}
    >
      <h3>{row ? "Edit" : "Create"} Google connector</h3>
      <label className="block">
        Key{" "}
        <input
          required
          disabled={Boolean(row)}
          value={value.key}
          onChange={(e) => setValue({ ...value, key: e.target.value })}
        />
      </label>
      <label className="block">
        Name{" "}
        <input
          required
          value={value.name}
          onChange={(e) => setValue({ ...value, name: e.target.value })}
        />
      </label>
      <label className="block">
        OAuth client ID{" "}
        <input
          required
          value={value.clientId}
          onChange={(e) => setValue({ ...value, clientId: e.target.value })}
        />
      </label>
      <label className="block">
        Encryption key{" "}
        <select
          required
          value={value.encryptionKey}
          onChange={(e) => setValue({ ...value, encryptionKey: e.target.value })}
        >
          <option value="">Choose a key</option>
          {keys.map((k) => (
            <option key={k.id} value={k.config.key}>
              {k.config.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <input
          type="checkbox"
          disabled={!row?.secretConfigured}
          checked={value.enabled}
          onChange={(e) => setValue({ ...value, enabled: e.target.checked })}
        />{" "}
        Enabled (requires provisioned client secret)
      </label>
      {(["gmail", "calendar"] as const).map((api) => (
        <label className="block" key={api}>
          <input
            type="checkbox"
            checked={value.enabledApis.includes(api)}
            onChange={(e) => {
              const enabledApis = e.target.checked
                ? [...value.enabledApis, api]
                : value.enabledApis.filter((a) => a !== api);
              const allowedScopes = value.allowedScopes.filter((s) =>
                enabledApis.includes(
                  scopeCatalog.find((d) => d.id === s)!.group.toLowerCase() as "gmail" | "calendar",
                ),
              );
              setValue({
                ...value,
                enabledApis,
                allowedScopes,
                defaultScopes: value.defaultScopes.filter((s) => allowedScopes.includes(s)),
              });
            }}
          />{" "}
          {api}
        </label>
      ))}
      <fieldset>
        <legend>Allowed permissions and explicit defaults</legend>
        {scopeCatalog
          .filter(
            (s) =>
              !s.required &&
              value.enabledApis.includes(s.group.toLowerCase() as "gmail" | "calendar"),
          )
          .map((s) => (
            <div key={s.id} className="my-3">
              <label>
                <input
                  type="checkbox"
                  checked={value.allowedScopes.includes(s.id)}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      allowedScopes: e.target.checked
                        ? [...value.allowedScopes, s.id]
                        : value.allowedScopes.filter((id) => id !== s.id),
                      defaultScopes: value.defaultScopes.filter((id) => id !== s.id),
                    })
                  }
                />{" "}
                Allow {s.label}
              </label>{" "}
              <label>
                <input
                  type="checkbox"
                  disabled={!value.allowedScopes.includes(s.id)}
                  checked={value.defaultScopes.includes(s.id)}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      defaultScopes: e.target.checked
                        ? [...value.defaultScopes, s.id]
                        : value.defaultScopes.filter((id) => id !== s.id),
                    })
                  }
                />{" "}
                Selected by default
              </label>
              <p>{s.description}</p>
            </div>
          ))}
      </fieldset>
      {error && (
        <Banner status="error" title="Connector operation failed" description={error.message} />
      )}
      <Button type="submit" label="Save connector" isDisabled={busy} />
      {row && (
        <>
          <label className="block">
            Write-only client secret{" "}
            <input
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          <Button
            type="button"
            label="Provision secret"
            isDisabled={busy || !secret}
            onClick={() => provision.mutate({ id: row.id, version: row.version, secret })}
          />
          <Button
            type="button"
            label="Re-encrypt existing values"
            isDisabled={busy}
            onClick={() => {
              if (
                confirm(
                  "Synchronously re-encrypt this connector's stored values using its saved key selection? All changes roll back on failure.",
                )
              )
                rotate.mutate({ id: row.id, version: row.version });
            }}
          />
          <Button
            type="button"
            label="Delete unused connector"
            isDisabled={busy}
            onClick={() => {
              if (
                confirm(
                  "Delete this connector? Connections and authorizations must be removed first.",
                )
              )
                remove.mutate({ id: row.id, version: row.version });
            }}
          />
        </>
      )}
    </form>
  );
}
