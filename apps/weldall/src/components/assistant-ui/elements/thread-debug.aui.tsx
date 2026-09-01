"use client";

import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { useAui, useAuiState } from "@assistant-ui/react";
import { BracesIcon, CheckIcon, CopyIcon, DownloadIcon, FileJsonIcon } from "lucide-react";
import { useState, type FC } from "react";

import { fetchChatThreadDetail, type ChatThreadWireDetail } from "@/app/chat/chat-thread-adapter";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";

/**
 * Thread-level debugging toolbar. Sits in the top-right of the chat viewport
 * and lets the user download the whole conversation — either as a readable
 * Markdown transcript or as the raw stored JSON payload (every message's id,
 * parentId, role, parts and createdAt). Hidden until a thread exists so there
 * is nothing to download on the welcome screen.
 */
export const ThreadDownloadActions: FC = () => {
  const threadId = useAuiState((state) => state.threadListItem.remoteId);
  if (!threadId) return null;

  return (
    <div className="absolute right-3 top-3 z-20 flex items-center gap-1">
      <TooltipIconButton
        tooltip="Download whole history as Markdown"
        variant="outline"
        className="bg-background/90 shadow-xs backdrop-blur"
        aria-label="Download conversation as Markdown"
        onClick={() => void downloadThread(threadId, "markdown")}
      >
        <DownloadIcon className="size-4" />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="Download whole history as raw JSON"
        variant="outline"
        className="bg-background/90 shadow-xs backdrop-blur"
        aria-label="Download conversation as JSON"
        onClick={() => void downloadThread(threadId, "json")}
      >
        <FileJsonIcon className="size-4" />
      </TooltipIconButton>
    </div>
  );
};

type ThreadExportFormat = "markdown" | "json";

async function downloadThread(threadId: string, format: ThreadExportFormat): Promise<void> {
  try {
    const detail = await fetchChatThreadDetail(threadId);
    const content =
      format === "json" ? JSON.stringify(detail, null, 2) : buildThreadMarkdown(detail);
    downloadTextFile(
      `chat-${slugify(detail.title ?? threadId)}.${format === "json" ? "json" : "md"}`,
      content,
      format === "json" ? "application/json" : "text/markdown",
    );
  } catch (error) {
    console.error("Failed to download chat history:", error);
  }
}

function buildThreadMarkdown(detail: ChatThreadWireDetail): string {
  const messages = detail.messages
    .map((message) => {
      const body = message.parts
        .map((part) => renderMarkdownPart(part as Record<string, unknown>))
        .filter(Boolean)
        .join("\n\n");
      if (!body) return "";
      const role = message.role === "user" ? "You" : "Weldall";
      const when = new Date(message.createdAt).toLocaleString();
      return `## ${role} — ${when}\n\n${body}`;
    })
    .filter(Boolean)
    .join("\n\n---\n\n");

  const title = detail.title ?? "Untitled conversation";
  const generated = new Date().toLocaleString();
  return [
    `# ${title}`,
    "",
    `Exported from Weldall chat on ${generated} · ${detail.messages.length} messages.`,
    "",
    messages || "_No messages yet._",
    "",
  ].join("\n");
}

function renderMarkdownPart(part: Record<string, unknown>): string {
  switch (part.type) {
    case "text":
      return String(part.text ?? "");
    case "reasoning":
      return String(part.text ?? "")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "step-start":
      return "";
    default: {
      if (typeof part.type === "string" && part.type.startsWith("tool-")) {
        const toolName = part.type.slice("tool-".length);
        const blocks = [`**Tool: ${toolName}**`];
        if (part.input !== undefined) {
          blocks.push("```json", safeJson(part.input), "```");
        }
        if (part.state === "output-error") {
          blocks.push(`**Error:** ${String(part.errorText ?? "")}`);
        } else if (part.output !== undefined) {
          blocks.push("```json", safeJson(part.output), "```");
        }
        return blocks.join("\n\n");
      }
      return ["```json", safeJson(part), "```"].join("\n");
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "conversation";
}

function downloadTextFile(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Lazily captures the current message's full state (`getState()`) when the
 * trigger fires, so streaming updates never re-render the message bubble. The
 * captured JSON is shown in a modal with a copy button.
 */
export function useRawMessageInspector() {
  const aui = useAui();
  const [rawJson, setRawJson] = useState<string | null>(null);
  const open = () => setRawJson(safeJson(aui.message.getState()));
  const close = () => setRawJson(null);
  return { rawJson, open, close };
}

export const RawMessageInspectorDialog: FC<{
  rawJson: string | null;
  onClose: () => void;
}> = ({ rawJson, onClose }) => {
  if (!rawJson) return null;

  return (
    <Dialog
      isOpen
      purpose="info"
      width="min(760px, calc(100vw - 32px))"
      maxHeight="calc(100vh - 32px)"
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <Layout
        header={
          <DialogHeader
            hasDivider
            onOpenChange={onClose}
            title="Raw message"
            subtitle="Debug view of the full message state (id, role, parts, timestamps, branches)."
          />
        }
        content={
          <LayoutContent>
            <pre className="overflow-auto whitespace-pre-wrap text-xs leading-5">{rawJson}</pre>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <div className="flex items-center justify-end gap-2">
              <CopyJsonButton text={rawJson} />
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </div>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
};

const CopyJsonButton: FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <Button variant="secondary" onClick={() => void copy()}>
      {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
};

/** Icon-button trigger used in the user message action bar. */
export const RawMessageInspectorButton: FC = () => {
  const { rawJson, open, close } = useRawMessageInspector();
  return (
    <>
      <TooltipIconButton
        tooltip="Inspect raw message"
        onClick={open}
        aria-label="Inspect raw message"
      >
        <BracesIcon className="size-4" />
      </TooltipIconButton>
      <RawMessageInspectorDialog rawJson={rawJson} onClose={close} />
    </>
  );
};
