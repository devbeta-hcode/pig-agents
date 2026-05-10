# Agent loop

Code: `app/backend/src/agent/{runner,executor,parser,commandLog}.ts`,
`app/backend/src/llm/{prompt,client}.ts`.

## Modes

| Mode | Behavior |
| --- | --- |
| `ask` | Single LLM call. Pure markdown reply. **No tool calls, no file writes, no shell.** Used when the user wants to discuss or get a code suggestion to apply manually. |
| `agent` | Full ReAct loop: THOUGHT → ACTION/FINAL, up to `MAX_ITERATIONS`. Can read files, search, run commands, write patches. |

The mode is selected by the `Chat.tsx` composer footer pill and posted as
`{ mode: "ask" | "agent" }` to `POST /agent/run`. Default is `agent`.

## ReAct format (strict)

The system prompt forces **one short THOUGHT line** (token-efficient — no long
planning essays), then **one or more `ACTION` JSON blocks** (parallel tools when
independent) or a single `FINAL`:

```text
THOUGHT:
<one line, ~25 words max — next step only>

ACTION:
{ "type": "<tool_name>", "input": <object> }

— additional `ACTION` lines allowed in the same turn when independent —

— OR —

FINAL:
<short final summary for the user>
```

`agent/parser.ts` parses this. If parsing fails, the runner pushes a
"please re-emit using the strict format" message and tries again (still
counted toward `MAX_ITERATIONS`). Three consecutive parse failures will
exhaust the iteration budget and end with `FINAL: Iteration limit reached`.

## Tools

Catalogue advertised in `llm/prompt.ts` (and the compact mirror in
`llm/prompt-compact.ts`):

| Tool | Input | Effect |
| --- | --- | --- |
| `codebase_map` | `{ "max_depth": 5 }` | full tree + manifest excerpts; rarely needed (a depth-3 tree is already in context) |
| `read_file` | `{ "path": "rel/path" }` | returns file contents (per-run cache dedupes repeats) |
| `list_files` | `{ "dir": "rel/dir" }` | lists entries in dir |
| `search_code` | `{ "query": "text" }` | full-text search across workspace |
| `glob` | `{ "pattern": "**/*.ts" }` | filename glob |
| `run_command` | `{ "cmd": "shell command" }` | **smart execution** \u2014 see below. Gated by the workspace approval policy. |
| `write_patch` | `{ "patches": "FILE: \u2026\nSEARCH\n<old>\nREPLACE\n<new>\nEND" }` | applies SEARCH/REPLACE patches; returns unified diffs |
| `create_file` | `{ "path", "content" }` | overwrite a file with verbatim `content` (no SEARCH/REPLACE) |
| `web_search` | `{ "query" }` | DuckDuckGo HTML scrape \u2014 returns top results `{title,url,snippet}`. Approval gated. |
| `web_fetch` | `{ "url", "maxChars?" }` | raw HTTP(S) fetch + HTML\u2192text strip. Refuses loopback / RFC1918 hosts. Approval gated. |
| `browser_navigate` | `{ "url" }` | drive the embedded Playwright Chromium (Browser panel). Auto-launches on first call. Approval gated. |
| `browser_get_text` | `{ "selector?", "maxChars?" }` | visible text (`innerText`) of page or selector subtree |
| `browser_get_html` | `{ "selector?", "maxChars?" }` | outer HTML of page or selector |
| `browser_click` | `{ "selector", "timeoutMs?" }` | click first matching element (CSS or Playwright `text=...`) |
| `browser_fill` | `{ "selector", "value" }` | type into `<input>` / `<textarea>` |
| `browser_wait_for` | `{ "selector", "state?", "timeoutMs?" }` | wait for selector before reading |
| `browser_eval` | `{ "js" }` | evaluate JS in the page; result JSON-stringified. Escape hatch. |

### Approval gate

`run_command`, all `web_*`, and all `browser_*` calls go through
`utils/policy.ts` + `utils/approvals.ts`:

- The runner emits a `policy_ask` SSE event with `kind: "command" |
  "web_fetch" | "web_search" | "browser"` and a human-readable
  `cmd`/description.
- The frontend's `CommandApprovalModal` lets the user **Allow once**,
  **Allow always** (commands only \u2014 stores a glob in
  `<workspace>/.pig-agents/policy.json`), **Deny**, or **Auto-approve all**
  (commands only).
- Web / browser approvals are bypassed when `policy.autoApproveWeb` is on
  (Settings \u2192 "Auto-allow web tools"). The shell deny-list still
  applies to `run_command` regardless.

### Smart command execution (`tools/smartCommand.ts`)

The `run_command` tool uses intelligent detection to handle both short
commands and long-running processes:

- **Pattern detection**: Recognizes dev servers (`npm run dev`, `yarn start`,
  `vite`, `uvicorn`, `flask run`, etc.) via regex patterns
- **Ready signals**: Monitors output for phrases like "listening on port",
  "compiled successfully", "ready in", "server started"
- **Failure detection**: Catches immediate errors (EADDRINUSE, syntax errors,
  module not found) and returns quickly
- **Background mode**: Long-running processes run detached; agent gets
  immediate feedback and can continue with other tasks
- **Timeouts**: 30s for normal commands, 15s ready-timeout for long-running

Result modes:
- `completed` — command finished normally (exit code in result)
- `background` — long-running process started, still running
- `failed` — early failure detected (error pattern matched)
- `timeout` — command did not complete in time

To **add a tool**, see [`backend.md`](backend.md) → "Adding a new agent tool".
Both `executor.ts` and `prompt.ts` must be updated; if you only update one,
the model either won't call the tool or will call something that doesn't
exist.

## Loop diagram

```text
runAgent({ task, mode })
  │
  ├─ rankRelevant(task, MAX_CONTEXT_FILES)        ← relevance/search.ts
  │
  ├─ if mode === "ask":
  │     emit iter_start
  │     chat([ASK_SYSTEM_PROMPT, askMessage(task, files)])
  │     emit final, return
  │
  └─ for i in 1..MAX_ITERATIONS:
        emit iter_start
        chat([SYSTEM_PROMPT, contextMessage(task, files, history)])
        parseAgentResponse(raw)
          ├─ error  → push "re-emit" hint, continue
          ├─ final  → may bounce once (guardrails) or emit final, return
          └─ action → emit action
                       executeTool(type, input)   ← agent/executor.ts
                                  │
                                  └─ run_command tool also calls
                                     recordAgentCommand({ cmd, cwd, … })
                                     so the AGENT RUNS sidebar updates.
                       emit observation
                       push (assistant, raw) and (user, observation) to history
```

## Streaming events (SSE)

`POST /agent/run?stream=1` emits these named events:

| Event | Payload (subset) |
| --- | --- |
| `log` | `{ level, message }` |
| `iter_start` | `{ iteration }` |
| `token` | `{ iteration, delta }` (per-LLM-token streaming) |
| `thought` | `{ iteration, thought }` |
| `action` | `{ iteration, tool, input }` |
| `policy_ask` | `{ askId, cmd, suggestedAllow, kind: "command" \| "web_fetch" \| "web_search" \| "browser" }` \u2014 frontend renders the approval modal and POSTs `/agent/approvals/:askId` |
| `policy_decision` | `{ decision, cmd, kind, originalCmd?, reason? }` \u2014 emitted after the user answers (or auto-allow fires) |
| `observation` | `{ iteration, ok, summary, diffs? }` |
| `final` | `{ result }` |
| `error` | `{ message }` |
| `aborted` | `{ message }` |
| `done` | `{ iterations, result, diffs }` (terminal) |

`aborted` is emitted when the client disconnects or the user clicks **Stop**
(the route layer aborts the underlying `AbortController`).

## Command log (AGENT RUNS)

`agent/commandLog.ts` keeps the last **100** `run_command` invocations in a
ring buffer with an `EventEmitter` for SSE fan-out:

- `recordAgentCommand(run)` — push (called by `executor.ts`).
- `listAgentCommands()` — newest-first snapshot.
- `getAgentCommand(id)` — full stdout/stderr.
- `deleteAgentCommand(id)` — remove a single entry, emits `delete` SSE.
- `clearAgentCommands()` — wipe all, emits `clear`.

Endpoints:

```text
GET    /agent/commands              ← snapshot
GET    /agent/commands/stream       ← SSE: hello, run, delete, clear
GET    /agent/commands/:id          ← full detail
DELETE /agent/commands              ← clear all
DELETE /agent/commands/:id          ← remove one (UI's ✕ button)
```

The frontend's `Terminals.tsx` AGENT RUNS section calls `streamAgentCommands`
to stay live and uses `deleteAgentCommand` for the ✕ button so dismissed
runs don't reappear after F5.

## Iteration & file budget

- `MAX_ITERATIONS` (default **20** if unset) — hard cap on the loop. Override
  in `app/.env` (`MAX_ITERATIONS=…`).
- `MAX_CONTEXT_FILES` (default `5`) — top-N files attached to the model's
  context. Selection is keyword + filename + import-graph based; see
  `relevance/search.ts`.

When iterations run out without `FINAL`, the runner emits a final result of
`"Iteration limit reached without FINAL."` so the UI doesn't hang.

## Runner guardrails (agent mode only)

All logic is in `app/backend/src/agent/runner.ts` (helpers near the top).

| Situation | Behavior |
| --- | --- |
| **Lazy FINAL** — `FINAL` contains a substantial fenced code block but no `write_patch` has run yet | Re-prompt **once** (`nudgeUsed`): demand a real `write_patch`, then `FINAL`. |
| **Premature FINAL** — `THOUGHT` names concrete paths/edits, `FINAL` is a short platitude (e.g. “Task completed”), **no** tools ran | Re-prompt **once** (`prematureFinalNudgeUsed`): demand `ACTION` before `FINAL`. |
| **Shallow scaffold** — task looks like a multi-file project (`looksLikeScaffoldTask`) but `write_patch` count ≤ 1 | Re-prompt **once** (`scaffoldNudgeUsed`): keep building. |

These are **separate flags** so one bounce does not block a different kind of
nudge. The system prompt in `llm/prompt.ts` reinforces: never emit FINAL-only
“done” if no `ACTION` ran in that turn, and adds reasoning/tool-discipline
hints (evidence-based THOUGHT, list_files/search_code before guessing paths,
retry logic after failed observations, language mirroring for FINAL).

`thoughtPromisesConcreteWork` also treats common Vietnamese “upgrade / optimize /
improve” phrasings as concrete-work signals for the premature-FINAL nudge.
