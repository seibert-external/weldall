"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { useTRPC } from "@/trpc/react";
export function ConnectionsTable() {
  const trpc = useTRPC(),
    cache = useQueryClient();
  const query = useQuery(trpc.admin.managed.connections.queryOptions());
  const refresh = () =>
    cache.invalidateQueries({ queryKey: trpc.admin.managed.connections.queryKey() });
  const disconnect = useMutation(
    trpc.admin.managed.disconnect.mutationOptions({ onSuccess: refresh }),
  );
  const remove = useMutation(
    trpc.admin.managed.deleteConnection.mutationOptions({ onSuccess: refresh }),
  );
  const discardCredentials = useMutation(
    trpc.admin.managed.discardConnection.mutationOptions({ onSuccess: refresh }),
  );
  const attempts = useQuery(trpc.admin.managed.authorizations.queryOptions());
  const refreshAttempts = () =>
    cache.invalidateQueries({ queryKey: trpc.admin.managed.authorizations.queryKey() });
  const cancel = useMutation(
    trpc.admin.managed.cancelAuthorization.mutationOptions({ onSuccess: refreshAttempts }),
  );
  const discard = useMutation(
    trpc.admin.managed.discardAuthorization.mutationOptions({ onSuccess: refreshAttempts }),
  );
  const error =
    query.error ??
    disconnect.error ??
    remove.error ??
    discardCredentials.error ??
    attempts.error ??
    cancel.error ??
    discard.error;
  return (
    <>
      <p>
        Administrators can inspect and disconnect accounts, not use them. Google revocation may
        affect other authorizations for the same account/client. Already-dispatched requests cannot
        be recalled.
      </p>
      {error && (
        <Banner status="error" title="Connection operation failed" description={error.message} />
      )}
      <table className="w-full text-left">
        <thead>
          <tr>
            <th>Connection / owner</th>
            <th>Permissions</th>
            <th>Health / usage</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {query.data?.map((c) => (
            <tr key={c.id}>
              <td>
                {c.name}
                <br />
                {c.accountName}
                <br />
                <code>{c.ownerId}</code>
                <br />
                {c.connectorKey}
              </td>
              <td>
                <details>
                  <summary>Selected / granted permissions</summary>
                  <p>Selected: {c.selectedScopes.join(", ")}</p>
                  <p>Granted: {c.grantedScopes.join(", ")}</p>
                </details>
                <p>Effective: {c.capabilities.join(", ") || "None"}</p>
              </td>
              <td>
                {c.status}
                {!c.connectorEnabled && " (connector disabled)"}
                <p>{c.revocationError}</p>
                <p>
                  {c.requestCount} dispatches; last used{" "}
                  {c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : "never"}
                </p>
              </td>
              <td>
                <Button
                  label={c.status === "REVOCATION_PENDING" ? "Retry revocation" : "Disconnect"}
                  isDisabled={disconnect.isPending || c.status === "DISCONNECTED"}
                  onClick={() => {
                    if (
                      confirm(
                        "Block this connection and revoke the Google account/client grant? This may affect other connections using that grant.",
                      )
                    )
                      disconnect.mutate({ id: c.id });
                  }}
                />
                <Button
                  label="Terminal cleanup"
                  isDisabled={
                    discardCredentials.isPending ||
                    disconnect.isPending ||
                    c.status !== "REVOCATION_PENDING"
                  }
                  onClick={() => {
                    if (
                      confirm(
                        "Provider revocation is UNCONFIRMED. Permanently discard this connection's retry credentials? Revoke the grant in Google account settings first. This only disconnects Weldall and records the unresolved provider outcome.",
                      )
                    )
                      discardCredentials.mutate({
                        id: c.id,
                        version: c.version,
                        acknowledgement: "provider-revocation-unconfirmed",
                      });
                  }}
                />
                <Button
                  label="Delete"
                  isDisabled={remove.isPending || c.status !== "DISCONNECTED"}
                  onClick={() => {
                    if (confirm("Delete disconnected connection metadata?"))
                      remove.mutate({ id: c.id });
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Showing up to 200 most recent connections.</p>
      <h2>Authorization attempts</h2>
      <p>
        Expired interrupted exchanges may have created a Google grant even if no credentials were
        persisted. Revoke it in Google account settings. Terminal cleanup discards retained retry
        material and does not confirm revocation.
      </p>
      <ul>
        {attempts.data?.map((a) => (
          <li key={a.id}>
            {a.name} ({a.connector.key}, owner {a.ownerId}): {a.status}, expires{" "}
            {new Date(a.expiresAt).toLocaleString()}{" "}
            <Button
              label="Cancel / retry revocation"
              isDisabled={cancel.isPending || a.status === "COMPLETED"}
              onClick={() => {
                if (
                  confirm(
                    "Cancel this attempt and revoke any retained Google grant? Other authorizations for the same account/client may be affected.",
                  )
                )
                  cancel.mutate({ id: a.id });
              }}
            />
            <Button
              label="Terminal cleanup"
              isDisabled={
                discard.isPending || new Date(a.expiresAt).getTime() + 30_000 > Date.now()
              }
              onClick={() => {
                if (
                  confirm(
                    "Provider revocation is UNCONFIRMED. Discard this expired attempt and its encrypted retry material? This cannot revoke a lost Google grant. Revoke it in Google account settings first.",
                  )
                )
                  discard.mutate({ id: a.id, acknowledgement: "provider-revocation-unconfirmed" });
              }}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
