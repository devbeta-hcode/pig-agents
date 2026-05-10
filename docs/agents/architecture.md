# Architecture

A two-process app: a TypeScript backend exposing REST + SSE + WS, and a
React/Vite frontend that talks to it.

```text
┌────────────────────────────────────────────────────────────────────┐
│  Browser (http://localhost:5174)                                   │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────────────┐ │
│  │  FileTree    │  │  Editor       │  │  Chat (Ask / Agent)      │ │
│  │  + ContextMenu│  │  + DiffEditor│  │  + DiffViewer + composer │ │
│  └──────┬───────┘  └──────┬────────┘  └──────────────┬───────────┘ │
│         │                 │                          │             │
│  ┌──────┴─────────────────┴──────────────────────────┴───────────┐ │
│  │  Terminals (xterm) ── shells + AGENT RUNS sidebar (SSE)       │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────┬──────────────────────────────────────────┘
                          │  fetch / EventSource / WebSocket
                          ▼
┌────────────────────────────────────────────────────────────────────┐
│  Backend (http://localhost:8787)                                   │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────────────────────┐  │
│  │  api/        │ │  agent/      │ │  tools/                    │  │
│  │  routes.ts   │ │  runner.ts   │ │  file.ts  command.ts       │  │
│  │  fs.ts       │ │  executor.ts │ │  patch.ts terminal.ts (PTY)│  │
│  │  chats.ts    │ │  parser.ts   │ │  smartCommand.ts  web.ts   │  │
│  │  diff.ts     │ │  commandLog  │ │                            │  │
│  │  settings.ts │ └──────┬───────┘ └────────────────────────────┘  │
│  │  browser.ts  │        │                                         │
│  └──────────────┘        │ uses                                    │
│                          │                                         │
│  ┌───────────────────────┴───────────────────────────────────────┐ │
│  │  llm/client.ts ── OpenAI-compatible HTTP client               │ │
│  │  llm/prompt.ts ── ReAct system prompt                         │ │
│  │  browser/session.ts ── Playwright Chromium (shared with UI)   │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  utils/workspace.ts  → safeJoin, getWorkspace, setWorkspace        │
│  utils/policy.ts     → per-workspace approval policy + allow-list  │
│  utils/approvals.ts  → policy_ask ↔ /agent/approvals/:askId bridge │
│  validation/validator.ts → typecheck/lint/test/build hooks         │
└────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
                   Active workspace (real filesystem)
```

## Process model

- **Single backend process** (`tsx watch src/server.ts` in dev,
  `node dist/server.js` in prod) on `PORT` (default `8787`).
- **Single Vite dev server** for the frontend on `5174`. Vite's proxy config
  forwards `/api/*` → `http://localhost:8787` and `/terminal/ws` → the
  backend WS path.
- One PTY (or `script` fallback) per interactive terminal connection.
- One in-memory ring buffer (max 100 entries) for agent-initiated shell
  commands; persists only for the life of the backend process.

## Data stores

| Where | What | Lifetime |
| --- | --- | --- |
| `app/.env` | LLM provider, model, ports, workspace pin | persistent |
| `~/.build-agents/chats/<wsHash>/` | chat sessions per workspace | persistent |
| In-memory ring (backend) | last 100 agent shell runs | process lifetime |
| `localStorage` (browser) | `build-agents.ws.confirmed.v1` flag, panel sizes | persistent per browser |

There is no SQL database. File-on-disk is the source of truth for chats.

## Workspace sandbox

### Project rules (per repo)

Markdown in **`<workspace>/.pig/rules/`** (and optionally `.cursor/rules/`) is
read at the start of each Ask/Agent run and appended to the system prompt as
**PROJECT RULES**, so conventions stack, naming, and “never touch X” live in
git next to the project. Implementation: `utils/projectRules.ts`.

Every file/command/agent operation goes through `utils/workspace.ts`:

- `getWorkspace()` returns the currently selected absolute path.
- `safeJoin(rel)` joins against the workspace root and **throws** if the
  resolved path escapes it (prevents `../../etc/passwd` style abuse).
- `setWorkspace(p)` validates the path is a directory and (if
  `ALLOWED_WORKSPACE_ROOT` is set) is contained inside it.

If `WORKSPACE_ROOT` is unset, `resolveInitial()` walks up from `process.cwd()`
to find a `.git/` ancestor or a `package.json` that isn't the backend's own.
**The frontend ignores this auto-resolution until the user explicitly
confirms a folder** (see `App.tsx` — flag `build-agents.ws.confirmed.v1`).

## Real-time channels

| Stream | Transport | What it carries |
| --- | --- | --- |
| Agent run | SSE (`POST /agent/run?stream=1`) | `step`, `thought`, `action`, `observation`, `final`, `error`, `done` |
| Agent commands | SSE (`GET /agent/commands/stream`) | `hello` (snapshot), `run`, `delete`, `clear` |
| Terminal | WebSocket (`/terminal/ws`) | binary-ish PTY data both directions |

Everything else is plain JSON over `fetch`.

## Configuration matrix

| Env var | Effect |
| --- | --- |
| `LLM_PROVIDER` | `openai` or `local` (any OpenAI-compatible base URL) |
| `OPENAI_API_KEY` | required when `LLM_PROVIDER=openai` |
| `BASE_URL` | OpenAI-compatible endpoint when `LLM_PROVIDER=local` |
| `MODEL` | model name to send |
| `MAX_CONTEXT_FILES` | top-N relevant files attached to context |
| `MAX_ITERATIONS` | hard cap on the ReAct loop |
| `PROJECT_RULES_MAX_CHARS` | max characters for concatenated `.pig/rules` + `.cursor/rules` (default `16000`) |
| `PORT` | backend port |
| `WORKSPACE_ROOT` | optional pinned starting workspace (still requires UI confirmation) |
| `ALLOWED_WORKSPACE_ROOT` | optional jail for `Open Folder` |
