# Chat thread persistence (Prisma + assistant-ui thread list)

## Goal

Persist Weldall chat conversations per user and add the thread-list sidebar UI from the assistant-ui landing page (list of past conversations, switch/rename/archive/delete, new thread, deep-linkable per-thread URLs). Replace the current stateless `/chat` (single ephemeral conversation) with persisted, resumable threads — while keeping the existing model/tool loop and the custom tool UIs working.

## Background / current state

The chat is fully stateless today. Read these before planning:

- **Server route:** `apps/weldall/src/app/api/chat/route.ts` — `POST /api/chat` runs `streamText` (Vercel AI SDK `ai@7`) with `createChatTools(...)` from `apps/weldall/src/server/ai/tools.ts`. It streams via `createUIMessageStreamResponse`/`toUIMessageStream`, enforces auth (`auth.api.getSession`), browser-origin checks, message validation (`validateChatMessages`), and request logging (`withRequestLogging`). **Each turn already posts the full message history** (stateless loop) — persistence can layer on top without changing the model loop.
- **Client:** `apps/weldall/src/app/assistant.tsx` — `useChat` (`@ai-sdk/react`) + `AssistantChatTransport` + `useAISDKRuntime` (`@assistant-ui/ai-sdk`), plus `RegisterToolUIs` which registers per-tool renderers via `aui.tools.setToolUI(..., { standalone: true })`.
- **Thread UI:** `apps/weldall/src/components/assistant-ui/elements/thread.aui.tsx` (custom; reasoning is hidden, tool calls render as standalone cards).
- **Tool UIs:** `apps/weldall/src/components/assistant-ui/elements/tool-uis.tsx` (`searchSkills`, `getSkill`, `weldallRequest`).
- **DB:** `packages/db/prisma/schema.prisma` (Prisma + Postgres; `ChatSettings` model already exists for the chat model config). Seed/dev data lives in `packages/db/prisma/seed.dev.ts`.
- **Auth:** server-side sessions via `auth.api.getSession({ headers })`; per-user isolation must use the authenticated `session.user.id`.

## Deliverables

### 1. Persistence model (Prisma)

Add models (naming aligned with existing schema style), e.g.:

- `ChatThread`: `id` (cuid), `userId`, `title` (nullable, auto-generated), `archivedAt` (nullable), `lastMessageAt`, timestamps. Index on `(userId, lastMessageAt desc)`.
- `ChatMessage`: `id`, `threadId`, `role`, `parts` (JSON — store the UI-stream message parts exactly as the client sends/receives them), `createdAt`. Index on `(threadId, createdAt asc)`.

Store the assistant/user messages as `UIMessage`-shaped parts (the same shape `useChat` manages) so history can be re-seeded verbatim. Do **not** store secrets; the chat API key stays in `ChatSettings` only.

### 2. Remote thread list adapter + API

assistant-ui exposes `useRemoteThreadListRuntime({ runtimeHook, adapter, threadId, onThreadIdChange })` from `@assistant-ui/react`, where `adapter: RemoteThreadListAdapter` is the contract to implement (`@assistant-ui/core`, `src/runtimes/remote-thread-list/types.ts`):

- `list(params)` → `{ threads, nextCursor? }` (paginated, `RemoteThreadListResponse`)
- `initialize(threadId)` → `{ remoteId }` (create a thread lazily on first message)
- `fetch(threadId)` → `RemoteThreadMetadata`
- `rename(remoteId, title)`, `archive(remoteId)`, `unarchive(remoteId)`, `delete(remoteId)`
- `generateTitle(remoteId, messages)` → `AssistantStream` (can return a static/streaming title)
- optional `updateCustom`, `unstable_Provider` / `unstable_useAdapters` (per-thread history adapter injection — see note below)

Implement this adapter in the client as a fetch wrapper over new server routes, e.g.:

- `GET /api/chat/threads` (list, paginated, per user)
- `POST /api/chat/threads` (create/initialize)
- `GET /api/chat/threads/[threadId]` (thread + messages)
- `PATCH /api/chat/threads/[threadId]` (rename / archive / unarchive)
- `DELETE /api/chat/threads/[threadId]`
- `POST /api/chat/threads/[threadId]/title` (generate title)

All routes: auth via `auth.api.getSession`, origin/CSRF checks, request logging — mirror `route.ts` exactly. Keep authorization server-side (per-user ownership check on every route; a user must never read/write another user's thread).

### 3. Runtime + routing

- Replace `useAISDKRuntime(chat)` with `useRemoteThreadListRuntime` wrapping the AI SDK runtime (`runtimeHook`), keeping `RegisterToolUIs` and the `sendAutomaticallyWhen` behavior intact.
- `threadId` / `onThreadIdChange` bound to the URL (`/chat` for new, `/chat/[threadId]` for existing) so threads are deep-linkable.
- **Per-thread history:** messages must load per thread. The canonical hook is not publicly exported from `@assistant-ui/ai-sdk@0.0.3` (verified: `useExternalHistory` is internal-only), so implement history loading via the documented adapter surface instead: the `RemoteThreadListAdapter` history contract (`ThreadHistoryAdapter`, injected per thread via `unstable_useAdapters`/`unstable_Provider`) or by seeding `useChat` with `initialMessages` + `threadId` on every thread switch. The current stateless `/api/chat` POST stays the model loop; persistence is storage + reseed.

### 4. Sidebar UI (assistant-ui main-page look)

- Render a thread list with `ThreadListPrimitive` / `ThreadListItemPrimitive` / `ThreadListItemMorePrimitive` (already exported by `@assistant-ui/react@0.15.17`): list of past conversations with title + relative last-message time, active-thread highlight, new-thread action, and rename/archive/delete in the row's "more" menu.
- Integrate into the chat layout beside `Thread` (`thread.aui.tsx`); keep the existing composer/welcome/scroll behavior and the custom tool cards.

## Constraints & notes

- **Verify the runtime entry point first:** in `@assistant-ui/react@0.15.17`, `useRemoteThreadListRuntime` lives under `legacy-runtime/runtime-cores/...` while `useCloudThreadListRuntime` is the current one in `@assistant-ui/core/react`. Check the installed package's docs/types before committing to an API; if a resource-client based equivalent exists for self-hosted lists, prefer it and note the trade-off.
- **Do not change the model/tool loop** — `weldallRequest` auto-approval, tool UIs, and hidden reasoning must keep working.
- **Do not remove or weaken the server-side guards** in `tools.ts` `execute()` (skill availability, scope membership, documented-URL check).
- Follow existing repo patterns: `AGENTS.md` guards (do not touch the three e2e guards; no local e2e run — the production build is required for e2e and is CI-only), Prisma migrations via the repo's migration flow, tRPC/route style, observability (`withRequestLogging`), and TypeScript declarative style.

## Acceptance criteria

- A signed-in user's conversations persist across page reloads and browser sessions; reloading `/chat/[threadId]` restores the full message history and the tool-call cards render from history.
- The sidebar lists only that user's threads (fresh title or auto-generated), supports new-thread, switching, rename, archive, and delete; archived threads are hidden from the default list.
- Two users cannot see or mutate each other's threads (server-enforced, not just hidden UI).
- The stateless model loop is unchanged: new turns still work exactly as before, and tool calls/approval/results stream identically.
- Unit/integration tests cover the thread routes (auth, ownership, CRUD, pagination) and the adapter's request/response shapes. Lint, Prettier, and `tsc --noEmit` are clean (the repo has 22 pre-existing typecheck errors in admin pages — do not introduce new ones). No e2e run locally.

## Out of scope

- Assistant Cloud hosting; Vercel `ai/agent` framework; changing the chat model provider; multi-user collaboration/typing indicators.
