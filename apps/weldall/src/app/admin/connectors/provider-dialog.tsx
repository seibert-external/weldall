"use client";
import { useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Button } from "@astryxdesign/core/Button";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { VStack } from "@astryxdesign/core/Stack";
import type { listManagedConnectorConfiguration } from "@/server/connectors/configuration";
import type { listScopeOptions } from "@/server/admin/service";
import { AtlassianConnectorDialog } from "./providers/atlassian-dialog";

// Brand marks from Simple Icons (https://simpleicons.org), bundled locally.
function GoogleLogo() {
  return (
    <svg aria-hidden="true" width={20} height={20} viewBox="0 0 24 24" fill="#4285F4">
      <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
    </svg>
  );
}
function AtlassianLogo() {
  return (
    <svg aria-hidden="true" width={20} height={20} viewBox="0 0 24 24" fill="#0052CC">
      <path d="M7.12 11.084a.683.683 0 00-1.16.126L.075 22.974a.703.703 0 00.63 1.018h8.19a.678.678 0 00.63-.39c1.767-3.65.696-9.203-2.406-12.52zM11.434.386a15.515 15.515 0 00-.906 15.317l3.95 7.9a.703.703 0 00.628.388h8.19a.703.703 0 00.63-1.017L12.63.38a.664.664 0 00-1.196.006z" />
    </svg>
  );
}

type Row = Awaited<ReturnType<typeof listManagedConnectorConfiguration>>["connectors"][number];
export interface ConnectorDialogProps {
  connector: Row | null;
  scopeOptions: Awaited<ReturnType<typeof listScopeOptions>>;
  onClose: () => void;
  onDelete: (connector: Row) => void;
  onSaved: () => Promise<void>;
}
/** UI registration boundary: lifecycle and tables never interpret provider policy. */
export function ConnectorDialog({
  googleDialog: GoogleDialog,
  ...props
}: ConnectorDialogProps & {
  googleDialog: typeof import("./configuration-page").GoogleConnectorDialog;
}) {
  const [type, setType] = useState(props.connector?.config.type);
  if (type === "google")
    return (
      <GoogleDialog
        {...props}
        connector={
          props.connector?.config.type === "google"
            ? { ...props.connector, config: props.connector.config }
            : null
        }
      />
    );
  if (type === "atlassian")
    return (
      <AtlassianConnectorDialog
        {...props}
        connector={
          props.connector?.config.type === "atlassian"
            ? { ...props.connector, config: props.connector.config }
            : null
        }
      />
    );
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      purpose="form"
    >
      <Layout
        header={
          <DialogHeader
            title="Choose connector provider"
            onOpenChange={(open) => {
              if (!open) props.onClose();
            }}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={3} hAlign="stretch">
              <Button
                label="Google Workspace"
                icon={<GoogleLogo />}
                onClick={() => setType("google")}
              />
              <Button
                label="Atlassian Cloud"
                icon={<AtlassianLogo />}
                onClick={() => setType("atlassian")}
              />
            </VStack>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
