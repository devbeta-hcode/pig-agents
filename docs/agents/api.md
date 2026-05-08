# HTTP / SSE / WS reference

All endpoints live under the backend port (default `8787`). The frontend
proxies them as `/api/*`. SSE endpoints are marked **SSE**, WebSocket is
marked **WS**. Bodies are JSON unless noted.

## Health & workspace

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | `{ ok: true, ts }` liveness |
| GET | `/workspace` | `{ workspace }` current absolute path |
| POST | `/workspace` | body `{ path }` switch workspace; checks `ALLOWED_WORKSPACE_ROOT` |

## Files & search

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/files?dir=.` | list directory (workspace-relative) |
| GET | `/file?path=...` | read file content |
| POST | `/file` | body `{ path, content }` write file |
| POST | `/entries` | body `{ path, kind: "file" \| "dir" }` create |
| POST | `/entries/copy` | body `{ from, to }` copy file/dir; auto-suffixes `" copy"` on collision; returns `{ ok, path }` |
| DELETE | `/entries?path=...` | recursive delete |
| POST | `/fs/rename` | body `{ from, to }` rename / move |
| GET | `/fs/home` | `{ home, roots }` for the FolderPicker |
| GET | `/fs/browse?path=...&hidden=0\|1` | absolute-path directory listing for the FolderPicker |
| GET | `/search?query=...` | full-text code search across workspace |

## Terminal

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/terminal` | body `{ cmd }` one-shot exec; returns `{ stdout, stderr, exitCode, durationMs, truncated }` |
| WS | `/terminal/ws?cols=&rows=` | interactive PTY (or `script` fallback) |

WS protocol (JSON frames):

```ts
// client → server
{ type: "input", data: "ls\n" }
{ type: "resize", cols: 100, rows: 30 }

// server → client
{ type: "data", data: "<chunk>" }
{ type: "exit", exitCode: 0 }
```

## Agent

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/agent/run` | body `{ task, mode? }` (`mode` = `"ask"` or `"agent"`); returns full result JSON |
| POST | `/agent/run?stream=1` | **SSE**: events `log`, `iter_start`, `token`, `thought`, `tool_payload_streaming` (optional `tool`), `action` (optional `actionKey`), `tool_disk_settled` (`actionKey`, `ok` — write tools finished on disk before stream ends), `observation`, `final`, `error`, `aborted`, `done` |

Client cancels by closing the `EventSource` / aborting the `fetch`; the
backend listens to `res.on("close")` and aborts the underlying
`AbortController` so the in-flight LLM call is dropped.

## Agent command log (AGENT RUNS)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/agent/commands` | `{ runs }` snapshot of last 100 |
| GET | `/agent/commands/stream` | **SSE**: `hello` (snapshot), `run`, `delete`, `clear` |
| GET | `/agent/commands/:id` | full detail incl. stdout / stderr |
| DELETE | `/agent/commands` | clear all → `{ ok, removed }` |
| DELETE | `/agent/commands/:id` | remove one → `{ ok, id }` or 404 |

## Diff revert

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/diff/revert` | body `{ diff }` reverse-applies every hunk of a unified diff returned by `write_patch` (hunks are processed last-to-first so line numbers stay valid) |
| POST | `/diff/revert-hunk` | body `{ diff, hunkIndex }` reverts just one hunk (0-based, matching backend hunk order). Used by the editor's per-hunk Undo button |

## Chats (backend-backed history)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/chats?workspace=...` | list session metadata for a workspace |
| GET | `/chats/:id?workspace=...` | full session (turns + events) |
| PUT | `/chats/:id?workspace=...` | create / overwrite full session |
| PATCH | `/chats/:id?workspace=...` | body `{ title?, mode? }` metadata update |
| DELETE | `/chats/:id?workspace=...` | delete session |
| GET | `/chats/search?workspace=...&q=...` | full-text search; returns `{ hits }` with snippets |
| GET | `/chats/export?workspace=...` | downloads `build-agents-chats-<wsHash>.json` |
| POST | `/chats/import?workspace=...` | body `{ sessions: [...] }`; new IDs on collision |

> **Route order matters**: `chats.ts` registers `/chats/search`,
> `/chats/export`, `/chats/import` **before** `/chats/:id` so the param
> route doesn't swallow them.

## Settings

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/settings` | returns `.env` values; sensitive fields are returned masked |
| POST | `/settings` | body subset of `SettingsPayload`; persists to `app/.env` |

If a request omits the API key the backend keeps the existing one (don't
unintentionally clear it from the UI).
