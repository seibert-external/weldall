"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import type { FC } from "react";

export const ChatThreadList: FC = () => (
  <aside className="bg-muted/30 border-border flex h-48 w-full shrink-0 flex-col border-b md:h-full md:w-72 md:border-r md:border-b-0">
    <div className="flex items-center justify-between px-3 py-3">
      <h1 className="px-1 text-sm font-semibold">Conversations</h1>
      <ThreadListPrimitive.New asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="New conversation">
          <MessageSquarePlusIcon className="size-4" />
        </Button>
      </ThreadListPrimitive.New>
    </div>

    <ThreadListPrimitive.Root className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
      <div className="space-y-1">
        <ThreadListPrimitive.Items>{() => <ChatThreadListItem />}</ThreadListPrimitive.Items>
      </div>
      <ThreadListPrimitive.LoadMore asChild>
        <Button variant="ghost" size="sm" className="mt-2 w-full text-xs">
          Load more
        </Button>
      </ThreadListPrimitive.LoadMore>

      <ArchivedThreads />
    </ThreadListPrimitive.Root>
  </aside>
);

const ArchivedThreads: FC = () => {
  const count = useAuiState((state) => state.threads.archivedThreadIds.length);
  if (count === 0) return null;
  return (
    <details className="mt-4 border-t pt-3">
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer px-2 text-xs font-medium">
        Archived ({count})
      </summary>
      <div className="mt-2 space-y-1">
        <ThreadListPrimitive.Items archived>
          {() => <ChatThreadListItem archived />}
        </ThreadListPrimitive.Items>
      </div>
    </details>
  );
};

const ChatThreadListItem: FC<{ archived?: boolean }> = ({ archived = false }) => {
  const lastMessageAt = useAuiState((state) => state.threadListItem.lastMessageAt);

  return (
    <ThreadListItemPrimitive.Root
      className={cn(
        "group hover:bg-muted relative flex min-w-0 items-center rounded-lg text-sm transition-colors",
        "data-[active=true]:bg-accent data-[active=true]:text-accent-foreground",
      )}
    >
      <ThreadListItemPrimitive.Trigger className="min-w-0 flex-1 px-2.5 py-2 text-left">
        <span className="block truncate font-medium">
          <ThreadListItemPrimitive.Title fallback="New chat" />
        </span>
        <span className="text-muted-foreground mt-0.5 block truncate text-xs">
          {formatRelativeTime(lastMessageAt)}
        </span>
      </ThreadListItemPrimitive.Trigger>
      <ThreadItemMenu archived={archived} />
    </ThreadListItemPrimitive.Root>
  );
};

const ThreadItemMenu: FC<{ archived: boolean }> = ({ archived }) => {
  const aui = useAui();
  const title = useAuiState((state) => state.threadListItem.title ?? "New chat");
  const rename = () => {
    const nextTitle = window.prompt("Rename conversation", title)?.trim();
    if (nextTitle && nextTitle !== title) void aui.threadListItem.rename(nextTitle);
  };

  return (
    <ThreadListItemMorePrimitive.Root>
      <ThreadListItemMorePrimitive.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="mr-1 size-7 shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100 data-[state=open]:opacity-100"
          aria-label="Conversation actions"
        >
          <MoreHorizontalIcon className="size-4" />
        </Button>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        side="right"
        align="start"
        sideOffset={6}
        className="bg-popover text-popover-foreground z-50 min-w-40 rounded-xl border p-1.5 shadow-md"
      >
        {!archived && (
          <ThreadListItemMorePrimitive.Item
            onSelect={rename}
            className="hover:bg-accent focus:bg-accent flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none"
          >
            <PencilIcon className="size-4" /> Rename
          </ThreadListItemMorePrimitive.Item>
        )}
        {archived ? (
          <ThreadListItemPrimitive.Unarchive asChild>
            <ThreadListItemMorePrimitive.Item className="hover:bg-accent focus:bg-accent flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none">
              <ArchiveRestoreIcon className="size-4" /> Unarchive
            </ThreadListItemMorePrimitive.Item>
          </ThreadListItemPrimitive.Unarchive>
        ) : (
          <ThreadListItemPrimitive.Archive asChild>
            <ThreadListItemMorePrimitive.Item className="hover:bg-accent focus:bg-accent flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none">
              <ArchiveIcon className="size-4" /> Archive
            </ThreadListItemMorePrimitive.Item>
          </ThreadListItemPrimitive.Archive>
        )}
        <ThreadListItemMorePrimitive.Separator className="bg-border my-1 h-px" />
        <ThreadListItemPrimitive.Delete asChild>
          <ThreadListItemMorePrimitive.Item className="text-destructive focus:bg-destructive/10 flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none">
            <Trash2Icon className="size-4" /> Delete
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Delete>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};

function formatRelativeTime(value: Date | undefined): string {
  if (!value) return "Just now";
  const seconds = Math.round((value.getTime() - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return formatter.format(months, "month");
  return formatter.format(Math.round(months / 12), "year");
}
