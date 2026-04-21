# Chat history

Code: `app/backend/src/api/chats.ts`,
`app/frontend/src/{App.tsx, components/ChatsList.tsx, lib/sessions.ts}`.

## Storage layout

All chats live under the user's home directory, partitioned by workspace
hash so different projects keep their histories separate:

```text
~/.build-agents/chats/
└── <workspaceHash>/             ← sha256(workspace abs path) truncated
    ├── index.json               ← array of SessionMeta (cheap to read)
    └── <sessionId>.json         ← full ChatSession (turns + events)
```

`workspaceHash` is computed in `chats.ts → workspaceHash(ws)`. Don't reuse
the raw path as a folder name — colons, spaces, and unicode break too easily.

### Why split index from sessions?

The sidebar only needs a lightweight metadata list (`id`, `title`, `mode`,
`updatedAt`, `turnCount`). Loading every session JSON to render that would
make the sidebar O(n × payload). Reading `index.json` once is O(1) bytes.
Full sessions are loaded lazily when the user clicks one.

### Atomic writes

Always write via `atomicWrite(target, contents)`:

1. write to `target + ".tmp"`;
2. `fs.renameSync(tmp, target)`.

This avoids corrupting `index.json` if the process dies mid-write (the OS
guarantees rename atomicity within the same filesystem).

## Type contracts

```ts
interface ChatTurn {
  id: string;
  task: string;
  mode?: "ask" | "agent";
  events: unknown[];                 // raw SSE events captured during the run
  status: "idle" | "running" | "done" | "error" | "stopped";
  startedAt: number;
  endedAt?: number;
}

interface ChatSession {
  id: string;
  title: string;
  workspace: string;
  mode?: "ask" | "agent";
  createdAt: number;
  updatedAt: number;
  turns: ChatTurn[];
}

interface SessionMeta {                // what the index stores
  id: string;
  title: string;
  workspace: string;
  mode?: "ask" | "agent";
  createdAt: number;
  updatedAt: number;
  turnCount: number;
}
```

If you change `ChatSession`, also update `metaFromSession` in `App.tsx` so
the index stays in sync.

## Endpoints

See [`api.md`](api.md) → "Chats". Quick recap:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/chats` | sidebar list |
| GET / PUT / PATCH / DELETE | `/chats/:id` | full session lifecycle |
| GET | `/chats/search?q=...` | full-text search across all sessions in workspace |
| GET | `/chats/export` | bundled JSON download |
| POST | `/chats/import` | bundle import (re-IDs on collision) |

`/chats/search` parses each session and pulls snippets from the meaningful
fields (`turn.task`, `turn.final`, and event `text/message/content/output`)
— **never** dump raw JSON into the snippet, the UI shows it directly.

## Frontend persistence behavior

`App.tsx` does the heavy lifting:

- **Lazy load**: `chatList` (metadata) is fetched immediately when
  `workspace` changes; `activeSession` is loaded only for the active id.
  A small `sessionCacheRef: Map<id, ChatSession>` avoids re-fetching when
  the user toggles between recent sessions.
- **Debounced save**: `scheduleSave(session, 350ms)` coalesces high-frequency
  updates (LLM token streams) into one PUT every ~350 ms.
- **Best-effort flush on unload**: a `beforeunload` handler calls
  `navigator.sendBeacon('/api/chats/<id>?workspace=...', JSON)` so the last
  in-flight delta lands even if the user closes the tab.
- **Optimistic UI**: the sidebar list updates instantly; the PUT is
  fire-and-forget with a `console.warn` on failure.

## Search UX

`ChatsList.tsx`:

- 200 ms debounced input (`q` state).
- Client-side title filter shows immediately.
- Backend full-text search call returns snippets which are rendered
  beneath each hit row.

## Export / import

- **Export** is a real download via `<a href={api.exportChatsUrl(ws)}>` —
  don't `fetch` it and re-create a blob; the route already sets
  `Content-Disposition`.
- **Import** uses a hidden `<input type="file">`. The file is parsed in
  the browser then POSTed as `{ sessions: [...] }`; the backend re-IDs
  any session whose id collides with an existing one in the workspace.

## One-time migration from `localStorage`

Older builds stored sessions under `localStorage["build-agents.sessions.v1"]`.
`migrateLegacyChatsOnce(ws)` runs on first workspace load and:

1. checks the flag `build-agents.sessions.migrated.v1`;
2. parses the legacy blob;
3. POSTs matching-workspace sessions to `/chats/import`;
4. removes the legacy key and sets the flag.

Don't strip this — users upgrading from old builds rely on it.
