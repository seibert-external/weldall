"use client";

import { useCallback, useEffect } from "react";
import { Icon } from "@astryxdesign/core/Icon";
import { useToast } from "@astryxdesign/core/Toast";

const QUEUED_TOAST_KEY = "weldall-operation-toast";

interface QueuedToast {
  body: string;
  uniqueID: string;
}

export function useOperationToast() {
  const showToast = useToast();

  const success = useCallback(
    (body: string, uniqueID: string) => {
      showToast({
        body: (
          <span className="flex items-center gap-2">
            <Icon color="success" icon="success" size="sm" />
            <span>{body}</span>
          </span>
        ),
        uniqueID,
        collisionBehavior: "overwrite",
      });
      promoteToastAboveDialog();
    },
    [showToast],
  );

  const error = useCallback(
    (fallback: string, cause: unknown, uniqueID: string) => {
      const detail = errorMessage(cause);
      showToast({
        body: detail ? `${fallback}: ${detail}` : fallback,
        type: "error",
        uniqueID,
        collisionBehavior: "overwrite",
      });
      promoteToastAboveDialog();
    },
    [showToast],
  );

  return { success, error };
}

export function queueOperationSuccess(body: string, uniqueID: string) {
  window.sessionStorage.setItem(
    QUEUED_TOAST_KEY,
    JSON.stringify({ body, uniqueID } satisfies QueuedToast),
  );
}

export function QueuedOperationToast() {
  const { success } = useOperationToast();

  useEffect(() => {
    const queued = window.sessionStorage.getItem(QUEUED_TOAST_KEY);
    if (!queued) return;

    window.sessionStorage.removeItem(QUEUED_TOAST_KEY);
    try {
      const toast = JSON.parse(queued) as Partial<QueuedToast>;
      if (typeof toast.body === "string" && typeof toast.uniqueID === "string") {
        success(toast.body, toast.uniqueID);
      }
    } catch {
      // Ignore malformed browser state from older deployments.
    }
  }, [success]);

  return null;
}

function promoteToastAboveDialog() {
  if (!document.querySelector("dialog[open]")) return;

  const viewport = document.querySelector<HTMLElement>('[aria-label="Notifications"][popover]');
  if (
    !viewport ||
    typeof viewport.hidePopover !== "function" ||
    typeof viewport.showPopover !== "function"
  ) {
    return;
  }

  try {
    // Native top-layer elements are stacked by insertion order. The toast viewport
    // mounts before dialogs, so reinsert it when a modal operation shows a toast.
    if (viewport.matches(":popover-open")) viewport.hidePopover();
    viewport.showPopover();
  } catch {
    // Keep the toast functional in browsers without complete Popover API support.
  }
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return typeof error.message === "string" ? error.message : undefined;
  }
  return undefined;
}
