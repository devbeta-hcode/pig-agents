# AGENTS.md

> Primary entry point for any AI coding agent (Cursor, Codex, Cline, OpenAI
> Codex CLI, Claude Code, …) working on this repo. Read this **first**, then
> dive into the focused docs under `docs/agents/` only when you need them.

---

## 1. What this project is

**Pig Agents — Cursor-lite.** A real, runnable IDE-like web app that pairs:

- a **thin React UI** (file tree, Monaco editor, xterm terminal, chat panel,
  diff viewer); and
- an **autonomous agent backend** that reads/writes real files, runs real
  shell commands, applies unified-diff patches, and validates them.

It is **not** a demo. The agent operates on a real workspace directory, and
every UI affordance is wired through real backend APIs.

See [`README.md`](README.md) for end-user setup. This file is for agents.

---

## 2. Repo map (TL;DR)

```text
.
├── AGENTS.md                  ← you are here
├── README.md                  ← end-user docs
├── BUILD_AGENT.md             ← original product brief (reference only)
├── package.json               ← npm workspaces root
├── app/
│   ├── .env                   ← LLM provider, model, ports, workspace pin
│   ├── backend/               ← Node.js + TypeScript + Express + WS
│   │   └── src/
│   │       ├── server.ts          entrypoint
│   │       ├── api/               HTTP routes (REST + SSE)
│   │       │   ├── routes.ts      core: files, agent, agent-commands
│   │       │   ├── fs.ts          folder browser (`/fs/*`)
│   │       │   ├── chats.ts       backend chat history
│   │       │   ├── settings.ts    .env-backed settings panel
│   │       │   └── diff.ts        revert applied patches
│   │       ├── agent/             ReAct loop
│   │       │   ├── runner.ts      orchestrator (LLM ↔ tools)
│   │       │   ├── executor.ts    tool dispatch
│   │       │   ├── parser.ts      ReAct response parser
│   │       │   └── commandLog.ts  in-memory log of agent shell runs
│   │       ├── llm/               LLM client + system prompt
│   │       ├── tools/             file, command, terminal (PTY), patch
│   │       ├── relevance/         pick top-N relevant files for context
│   │       ├── validation/        typecheck/lint/test/build hooks
│   │       └── utils/             logger, workspace path helpers
│   └── frontend/              ← React + Vite + TypeScript + Monaco
│       └── src/
│           ├── App.tsx            top-level layout + state
│           ├── components/        FileTree, Chat, Editor, Terminals, …
│           ├── lib/api.ts         typed REST/SSE/WS client
│           └── lib/sessions.ts    chat session helpers
└── docs/agents/               ← deep-dive docs (you only need these
                                  when working on a specific subsystem)
```

Detailed inventory: [`docs/agents/architecture.md`](docs/agents/architecture.md)

---

## 3. Run / build / test

This is an npm workspaces monorepo. Always run scripts from the **repo root**.

```bash
npm install        # once

npm run dev        # starts backend (8787) + frontend (5174) together
npm run dev:backend
npm run dev:frontend

npm run build      # tsc (backend) + vite build (frontend)
npm run start      # serve compiled backend
```

The backend auto-loads `app/.env`. Frontend dev server proxies `/api/*` and
`/terminal/ws` to the backend.

There is **no** unit test suite yet; verification is manual + via the in-app
agent. When you change behavior, exercise it in the running app (the user
typically has the dev server up — check `terminals/` files before starting
your own).

---

## 4. Non-negotiable rules

These are user-stated preferences. Do **not** regress them.

1. **Workspace must default to "no folder opened"** on first run. The
   user explicitly picks a folder via the picker; selection is remembered in
   `localStorage` under `build-agents.ws.confirmed.v1`. Do not auto-load any
   workspace before the user confirms one. See `App.tsx`.
2. **Chat history lives on the backend**, not in `localStorage`. Storage:
   `~/.build-agents/chats/<workspaceHash>/{index.json, <sessionId>.json}`.
   Use atomic writes. Debounce client-side saves.
   See [`docs/agents/chat-history.md`](docs/agents/chat-history.md).
3. **Agent shell runs are first-class.** Every `run_command` invocation is
   recorded to an in-memory ring buffer and surfaced under "AGENT RUNS" in
   the terminal sidebar, with live SSE updates. Don't bypass the log.
4. **Two chat modes**: **Ask** (chat-only, manual apply) and **Agent** (auto
   tool use). The user can switch via the composer footer; both must keep
   working.
5. **Diffs are reviewable, not silent.** When the agent edits files, the
   `DiffViewer` lists each touched file; clicking opens a side-by-side
   `DiffEditorView`. The active editor also shows inline highlights and a
   PENDING banner with **Keep / Undo** actions for the most recent diff.
6. **Tool calls cite real files.** Never fabricate paths. Use `list_files`
   first when unsure. The agent is sandboxed to the active workspace by
   `safeJoin` — escaping it raises an error, not a fallback.
7. **Comments explain *why*, not *what*.** No narration like
   `// increment counter`. Only document non-obvious intent, trade-offs,
   constraints. See [`docs/agents/conventions.md`](docs/agents/conventions.md).
8. **Don't commit secrets.** `app/.env` is git-ignored. Settings UI masks
   API keys. If you touch settings code, preserve the masking.

---

## 5. Where to look for what

| You want to … | Read |
| --- | --- |
| Pick up where the previous session left off | [`docs/agents/session-handoff.md`](docs/agents/session-handoff.md) |
| Understand the high-level architecture | [`docs/agents/architecture.md`](docs/agents/architecture.md) |
| Add a backend route or tool | [`docs/agents/backend.md`](docs/agents/backend.md), [`docs/agents/api.md`](docs/agents/api.md) |
| Add a UI panel or wire a frontend feature | [`docs/agents/frontend.md`](docs/agents/frontend.md) |
| Change the agent's prompt / tool catalogue / loop | [`docs/agents/agent-loop.md`](docs/agents/agent-loop.md) |
| Touch chat persistence / search / export | [`docs/agents/chat-history.md`](docs/agents/chat-history.md) |
| Recipes for common tasks (add a tool, add a route, …) | [`docs/agents/workflows.md`](docs/agents/workflows.md) |
| Code style, comments, error handling | [`docs/agents/conventions.md`](docs/agents/conventions.md) |
| Hit a known issue (port in use, LLM stall, PTY) | [`docs/agents/troubleshooting.md`](docs/agents/troubleshooting.md) |

---

## 6. Workflow expectations for agents

1. **Plan visibly.** For non-trivial work, maintain a TODO list and check
   items off as you complete them.
2. **Edit, don't recreate.** Always prefer modifying existing files over
   creating parallel ones.
3. **After edits, run the linter.** Use the IDE's linter check on the files
   you touched and fix anything you introduced (don't chase pre-existing
   issues unless they block).
4. **Verify in the running app** when the change is user-facing. Use the
   browser MCP (already wired) or curl. Don't assume — observe.
5. **Update docs when you change contracts.** If you add an endpoint, add a
   row in [`docs/agents/api.md`](docs/agents/api.md). If you change an
   invariant in §4 above, update §4.
6. **Speak the user's language in chat.** This user writes in Vietnamese;
   mirror that when summarizing for them. Code, comments, identifiers, and
   docs in this repo stay in English.
7. **End-of-session ritual (mandatory).** Before you tell the user
   "done" on any non-trivial task, append a bullet to the
   [`docs/agents/session-handoff.md`](docs/agents/session-handoff.md)
   "Last session" list summarising what changed, then bump the
   `Last updated:` date at the top. This is what keeps the next session's
   handoff honest. A change is "non-trivial" if it touches code, adds an
   endpoint, alters a contract, or shifts a user-facing behavior — pure
   chat answers don't need an entry.

---

## 7. Project status snapshot

Implemented and known-working:

- Folder picker (no auto-open default) · explorer w/ copy/cut/paste & rename
- Monaco editor with tabs, dirty state, Ctrl/Cmd+S, inline pending-diff
  highlights, selection → "Add to Chat" floating action
- Chat panel: Ask/Agent modes, slash commands, model dropdown, file mention
  chips with individual remove, drag-files-into-chat, code-block Apply,
  streaming agent thinking, regenerate / copy / stop · shared SVG chevrons
  (`ChevronExpand` / `PlayTriangle`) for disclosures and small affordances
- Composer: `MentionInput` auto-grow; avoid spurious empty-state scrollbar
  (overflow hidden until max height — see `MentionInput.tsx` + `styles.css`)
- Backend chat history with debounced save, full-text search, export/import
- ReAct agent loop with tools: `read_file`, `list_files`, `search_code`,
  `run_command`, `write_patch` · runner guardrails for lazy / premature /
  shallow-scaffold `FINAL` (see `docs/agents/agent-loop.md`)
- Patch engine (SEARCH/REPLACE → unified diff), revertible
- Terminal panel: VSCode-style header + sidebar, multiple PTY shells,
  AGENT RUNS section with SSE live updates, per-run dismiss + clear all
- Settings modal with masked API key

Not yet implemented (fair game):

- Automated test suite
- Multi-workspace concurrent sessions
- Embedding-based relevance / semantic search
- AST-aware patches (ts-morph)

---

If anything in this file conflicts with what you observe in the code, the
**code wins** — and you should update this file as part of your change.
