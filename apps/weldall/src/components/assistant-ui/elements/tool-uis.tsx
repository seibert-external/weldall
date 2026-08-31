"use client";

import { memo, type ReactNode } from "react";
import {
  AlertTriangleIcon,
  BookOpenIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  GlobeIcon,
  LoaderCircleIcon,
  SearchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ToolCallMessagePartComponent, ToolCallMessagePartProps } from "@assistant-ui/react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

type ToolPartStatus = ToolCallMessagePartProps["status"];

/** Result shape when a tool fails; the SDK reports errors as `{ error }`. */
type ToolErrorResult = { error?: unknown };

function isErrorResult(value: unknown): value is ToolErrorResult {
  return value != null && typeof value === "object" && "error" in value;
}

function errorText(result: unknown): string | undefined {
  if (!isErrorResult(result)) return undefined;
  const { error } = result;
  return typeof error === "string" ? error : JSON.stringify(error);
}

function ToolError({ result, status }: { result: unknown; status?: ToolPartStatus }) {
  const message =
    errorText(result) ??
    (status?.type === "incomplete" && status.reason === "error"
      ? (() => {
          const raw = (status as { error?: unknown }).error;
          return typeof raw === "string" ? raw : undefined;
        })()
      : undefined);
  if (!message) return null;
  return <p className="text-destructive text-xs">{message}</p>;
}

// ---------------------------------------------------------------------------
// Shared shell: a collapsible, shadow-free card. The header carries a status
// icon and an inline summary; details live in the collapsible body.
// ---------------------------------------------------------------------------

function ToolCard({
  icon,
  label,
  summary,
  status,
  defaultOpen = false,
  children,
}: {
  icon: ReactNode;
  label: string;
  summary?: ReactNode;
  status?: ToolPartStatus;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const isRunning = status == null || status.type === "running";
  const isError = status?.type === "incomplete";

  return (
    <Collapsible
      data-slot="aui_tool-ui-card"
      defaultOpen={defaultOpen}
      className="border-border/60 bg-card my-2 flex flex-col rounded-lg border"
    >
      <CollapsibleTrigger
        data-slot="aui_tool-ui-trigger"
        className="group/trigger hover:bg-muted/40 flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors"
      >
        {isRunning ? (
          <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : isError ? (
          <XCircleIcon className="size-4 shrink-0 text-destructive" />
        ) : (
          <span className="text-muted-foreground shrink-0">{icon}</span>
        )}
        <span className="font-medium whitespace-nowrap">{label}</span>
        {summary != null && (
          <span className="text-muted-foreground min-w-0 truncate">{summary}</span>
        )}
        <ChevronDownIcon
          data-slot="aui_tool-ui-chevron"
          className="text-muted-foreground ml-auto size-4 shrink-0 -rotate-90 transition-transform duration-200 group-data-open/trigger:rotate-0"
        />
      </CollapsibleTrigger>
      <CollapsibleContent data-slot="aui_tool-ui-content" className="overflow-hidden">
        <div className="flex flex-col gap-2 border-t border-border/60 px-3 py-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// searchSkills
// ---------------------------------------------------------------------------

type SearchSkillsArgs = { query?: string; limit?: number };
type SearchSkillsResult = {
  skills: Array<{
    slug: string;
    title: string;
    preview?: string;
    available: boolean;
    missingScopes?: string[];
    tags?: string[];
  }>;
  warnings?: string[];
};

const SearchSkillsToolUI: ToolCallMessagePartComponent = memo(function SearchSkillsToolUI({
  args,
  result,
  status,
}) {
  const { query } = (args ?? {}) as SearchSkillsArgs;
  const isRunning = status == null || status.type === "running";
  const failed = !isRunning && isErrorResult(result);
  const { skills = [], warnings = [] } = (failed
    ? {}
    : (result ?? {})) as Partial<SearchSkillsResult>;

  const summary = isRunning
    ? "searching…"
    : failed
      ? "failed"
      : skills.length === 1
        ? "found 1 skill"
        : `found ${skills.length} skills`;

  return (
    <ToolCard
      icon={<SearchIcon className="size-4" />}
      label="Searched skills"
      summary={query != null && query !== "" ? `${summary} · “${query}”` : summary}
      status={status}
    >
      {isRunning ? (
        <p className="text-muted-foreground text-xs">Searching the skill catalog…</p>
      ) : failed ? (
        <ToolError result={result} status={status} />
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {skills.length === 0 && (
            <li className="text-muted-foreground py-1 text-xs">No matching skills.</li>
          )}
          {skills.map((skill) => (
            <li key={skill.slug} className="flex items-start justify-between gap-3 py-1.5">
              <div className="min-w-0">
                <p className="truncate font-medium">{skill.title}</p>
                {skill.preview != null && skill.preview !== "" && (
                  <p className="text-muted-foreground line-clamp-1 text-xs">{skill.preview}</p>
                )}
              </div>
              {skill.available ? (
                <span className="flex shrink-0 items-center gap-1 text-xs whitespace-nowrap">
                  <CheckCircle2Icon className="size-3.5 text-emerald-500" />
                  {skill.slug}
                </span>
              ) : (
                <span className="flex shrink-0 items-center gap-1 text-xs whitespace-nowrap text-amber-600">
                  <AlertTriangleIcon className="size-3.5" />
                  missing scopes
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {!isRunning && !failed && warnings.length > 0 && (
        <p className="text-amber-600 text-xs">{warnings.join(" ")}</p>
      )}
    </ToolCard>
  );
});

// ---------------------------------------------------------------------------
// getSkill
// ---------------------------------------------------------------------------

type GetSkillResult = {
  slug: string;
  title: string;
  available: boolean;
  missingScopes?: string[];
  requiredScopes?: string[];
  resources?: Array<{ key: string; name: string }>;
  document?: string;
  truncated?: boolean;
};

const GetSkillToolUI: ToolCallMessagePartComponent = memo(function GetSkillToolUI({
  result,
  status,
}) {
  const isRunning = status == null || status.type === "running";
  const failed = !isRunning && isErrorResult(result);
  const r = failed ? undefined : (result as GetSkillResult | undefined);
  const resources = r?.resources ?? [];

  const summary = isRunning
    ? "loading…"
    : failed
      ? "failed"
      : r?.title
        ? `loaded “${r.title}”`
        : r
          ? `loaded ${r.slug}`
          : "loaded";

  return (
    <ToolCard
      icon={<BookOpenIcon className="size-4" />}
      label="Loaded skill"
      summary={summary}
      status={status}
    >
      {isRunning ? (
        <p className="text-muted-foreground text-xs">Loading skill…</p>
      ) : failed ? (
        <ToolError result={result} status={status} />
      ) : r === undefined ? (
        <p className="text-muted-foreground text-xs">Loading skill…</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{r.title || r.slug}</span>
            {r.available ? (
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600">
                available
              </span>
            ) : (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600">
                unavailable
              </span>
            )}
          </div>
          {r.missingScopes != null && r.missingScopes.length > 0 && (
            <p className="text-amber-600 text-xs">Missing scopes: {r.missingScopes.join(", ")}</p>
          )}
          {resources.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {resources.map((resource) => (
                <span
                  key={resource.key}
                  className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs"
                >
                  {resource.name}
                </span>
              ))}
            </div>
          )}
          {typeof r.document === "string" && r.document !== "" && (
            <p className="text-muted-foreground line-clamp-3 text-xs whitespace-pre-wrap">
              {r.document.slice(0, 240)}
              {r.document.length > 240 || r.truncated ? "…" : ""}
            </p>
          )}
        </div>
      )}
    </ToolCard>
  );
});

// ---------------------------------------------------------------------------
// weldallRequest
// ---------------------------------------------------------------------------

type WeldallRequestArgs = {
  skillSlug?: string;
  url?: string;
  method?: "GET" | "POST";
  scopes?: string[];
};
type WeldallRequestResult = {
  resource: { key: string; name: string };
  url: string;
  method: "GET" | "POST";
  status: number;
  ok: boolean;
  data: unknown;
  responseBytes: number;
};

const WeldallRequestToolUI: ToolCallMessagePartComponent = memo(function WeldallRequestToolUI({
  args,
  result,
  status,
}) {
  const a = args as WeldallRequestArgs | undefined;
  const isRunning = status == null || status.type === "running";
  const failed = !isRunning && isErrorResult(result);
  const r = failed ? undefined : (result as WeldallRequestResult | undefined);
  const method = a?.method ?? r?.method ?? "GET";

  const dataPreview =
    typeof r?.data === "string"
      ? r.data
      : r?.data !== undefined
        ? JSON.stringify(r.data, null, 2)
        : "";

  const summary = isRunning
    ? "requesting…"
    : failed
      ? "failed"
      : r
        ? `${r.resource?.name ?? "Unknown resource"} · ${r.status ?? "–"} ${r.ok === true ? "ok" : "failed"}`
        : "requesting…";

  return (
    <ToolCard
      icon={<GlobeIcon className="size-4" />}
      label={method === "POST" ? "Sent request" : "Fetched data"}
      summary={summary}
      status={status}
    >
      {isRunning ? (
        <p className="text-muted-foreground text-xs">Executing request…</p>
      ) : failed ? (
        <ToolError result={result} status={status} />
      ) : r === undefined ? (
        <p className="text-muted-foreground text-xs">Executing request…</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-xs font-semibold",
                method === "POST"
                  ? "bg-amber-500/10 text-amber-600"
                  : "bg-sky-500/10 text-sky-600",
              )}
            >
              {method}
            </span>
            <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
              {r.url ?? ""}
            </span>
            <span
              className={cn(
                "ml-auto shrink-0 text-xs",
                r.ok === true ? "text-emerald-600" : "text-destructive",
              )}
            >
              {r.status ?? "–"}
            </span>
          </div>
          {a?.scopes != null && a.scopes.length > 0 && (
            <p className="text-muted-foreground text-xs">Scopes: {a.scopes.join(", ")}</p>
          )}
          <p className="text-muted-foreground text-xs">{r.responseBytes ?? 0} bytes</p>
          {dataPreview !== "" && (
            <pre className="bg-muted/50 text-foreground/90 max-h-40 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap">
              {dataPreview.slice(0, 800)}
              {dataPreview.length > 800 ? "…" : ""}
            </pre>
          )}
        </div>
      )}
    </ToolCard>
  );
});

export { SearchSkillsToolUI, GetSkillToolUI, WeldallRequestToolUI };
