# Pig Agents

> © 2026 DEV BETA., JSC. All rights reserved.

A **real** AI coding system: thin React UI + autonomous agent backend. Built per `BUILD_AGENT.md`.

Not a demo. The agent reads/writes real files, runs real commands, and validates real builds.

## What's inside

### Backend (`app/backend`, Node.js + TypeScript, Express + WS)

- **Agent loop** with strict ReAct format (`THOUGHT` / `ACTION` / `FINAL`) and iteration cap
- **Tool system**: `read_file`, `list_files`, `search_code`, `glob`, `run_command`, `write_patch`, `create_file`, `web_search`, `web_fetch`, and a full `browser_*` family (`navigate`, `get_text`, `get_html`, `click`, `fill`, `wait_for`, `eval`) that drives the embedded Playwright Chromium shown in the Browser panel
- **Approval gate**: every shell command goes through a per-workspace policy modal (Allow once / Allow always / Deny / Auto-approve all). `web_*` and `browser_*` calls share a separate "Auto-allow web tools" toggle in Settings.
- **Patch engine**: `SEARCH` / `REPLACE` blocks with uniqueness checks + unified-diff output
- **Relevance engine**: scores files by keyword, filename, and import hints
- **Validator**: auto-runs `typecheck` / `lint` / `test` / `build` after patches
- **LLM client**: OpenAI + any OpenAI-compatible local server (Ollama, vLLM, …)
- **File API**: list / read / write / create / delete (sandboxed to workspace)
- **Terminal**: REST `POST /terminal` + interactive `WS /terminal/ws` (uses `node-pty` if available, falls back to `child_process`)

### Frontend (`app/frontend`, React + Vite + TypeScript)

- code-server-like layout: title bar, activity bar, sidebar, editor+tabs, bottom panel, chat panel, status bar
- **FileTree**: lazy recursive expansion, new file / new folder, right-click delete
- **Editor**: Monaco with language detection and Ctrl/Cmd+S to save
- **Terminal**: xterm.js wired to backend WS
- **Chat**: streams agent events (SSE), shows thoughts / actions / observations / final
- **DiffViewer**: rendered unified diffs for every patch the agent applies

## Getting started

```bash
npm install
npm run dev
```

This starts:

- Backend on `http://localhost:8787`
- Frontend on `http://localhost:5174` (proxies `/api/*` — same prefix as production — plus `/terminal/ws`, `/fs/watch`)

Open <http://localhost:5174>.

### Configure the LLM

Edit `app/.env` (auto-loaded by the backend):

```env
LLM_PROVIDER=openai          # or "local"
OPENAI_API_KEY=sk-...

# When LLM_PROVIDER=local, point to any OpenAI-compatible server:
BASE_URL=http://localhost:11434/v1
MODEL=qwen2.5-coder

MAX_CONTEXT_FILES=5
MAX_ITERATIONS=5

PORT=8787
WORKSPACE_ROOT=               # optional: pin starting workspace
ALLOWED_WORKSPACE_ROOT=       # optional: restrict "Open Folder" boundary

# Optional: max size for merged project rules (see below)
PROJECT_RULES_MAX_CHARS=16000
```

### Pick your workspace

In the title bar, type an absolute path and press Enter (or click **Open Folder**).
The agent and all file/terminal operations are scoped to that directory.

### Project rules (per workspace)

The agent **appends Markdown rules** from the **opened folder** into the system prompt under **PROJECT RULES** — same idea as Cursor’s project rules.

| Location | Purpose |
| -------- | ------- |
| **`<workspace>/.pig/rules/**/*.md`** (and `.mdc`) | **Primary**: put your team’s conventions here (nested folders OK). |
| **`<workspace>/.cursor/rules/**`** | **Optional**: reuse existing Cursor rule files without moving them. |

Rules are loaded in order (`.pig/rules` first, then `.cursor/rules`); duplicate paths are skipped. Only **`.md`** and **`.mdc`** files are included. Total merged text is capped by **`PROJECT_RULES_MAX_CHARS`** (default **16000**); if logs say rules were truncated, raise that variable in `app/.env`.

If neither tree exists, the agent still runs — there are simply no extra project rules.

## API surface

| Method | Path                        | Purpose                                 |
| ------ | --------------------------- | --------------------------------------- |
| GET    | `/health`                   | liveness                                |
| GET    | `/workspace`                | current workspace path                  |
| POST   | `/workspace`                | switch workspace                        |
| GET    | `/files?dir=.`              | list directory                          |
| GET    | `/file?path=...`            | read file contents                      |
| POST   | `/file`                     | write file contents                     |
| POST   | `/entries`                  | create file/dir                         |
| DELETE | `/entries?path=...`         | delete file/dir                         |
| GET    | `/search?query=...`         | full-text search                        |
| POST   | `/terminal`                 | one-shot shell command                  |
| WS     | `/terminal/ws`              | interactive terminal                    |
| POST   | `/agent/run`                | run agent (JSON response)               |
| POST   | `/agent/run?stream=1`       | run agent (SSE stream of events)        |
| POST   | `/agent/approvals/:askId`   | answer a `policy_ask` event (`allow_once` / `allow_always` / `deny`) |
| GET    | `/policy`                   | read per-workspace approval policy      |
| POST   | `/policy/auto-approve`      | toggle YOLO command auto-approve        |
| POST   | `/policy/auto-approve-web`  | toggle auto-allow for `web_*` / `browser_*` tools |
| GET    | `/browser/status`           | playwright installed? browser running?  |
| POST   | `/browser/install`          | `npx playwright install chromium` (progress over WS) |
| POST   | `/browser/start` · `/browser/stop` · `/browser/navigate` | drive the embedded Chromium |
| WS     | `/browser/ws`               | screencast frames + page events         |

## Build

```bash
npm run build      # builds backend (tsc) and frontend (vite)
npm run start      # runs the compiled backend
```

## Safety

- All filesystem access is constrained to the active workspace
- A blocklist prevents destructive shell commands (`rm -rf /`, `mkfs`, `dd`, fork bombs, `shutdown`/`reboot`)
- `run_command` enforces a timeout and output cap
- `ALLOWED_WORKSPACE_ROOT` can pin "Open Folder" to a parent directory

## Notes

- `node-pty` is an optional dependency. If your environment lacks a build toolchain, the terminal automatically falls back to `child_process` so the system still runs.
- The agent uses SSE for streaming; no WebSocket needed for the chat panel.
