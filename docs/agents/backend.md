# Backend

Express + TypeScript, ESM modules, started by `tsx watch src/server.ts`.
Compiled output goes to `app/backend/dist/` via `tsc`.

## Module map

```text
app/backend/src/
├── server.ts               Express bootstrap, WS upgrade, .env loader
├── api/
│   ├── routes.ts           main REST + agent SSE routes
│   ├── fs.ts               folder browser used by the FolderPicker modal
│   ├── chats.ts            chat history (list/get/put/patch/delete/search/export/import)
│   ├── settings.ts         GET/POST app/.env-backed settings
│   └── diff.ts             POST /diff/revert (reverse-apply an applied patch)
├── agent/
│   ├── runner.ts           orchestrates the ReAct loop, emits SSE events
│   ├── executor.ts         dispatches a parsed action to a tool
│   ├── parser.ts           parses LLM output into THOUGHT/ACTION/FINAL
│   └── commandLog.ts       in-memory ring buffer + EventEmitter for SSE
├── llm/
│   ├── client.ts           OpenAI-compatible HTTP client (chat completions)
│   └── prompt.ts           system prompt enforcing ReAct format
├── tools/
│   ├── file.ts             listFiles/readFile/writeFile/createEntry/
│   │                       deleteEntry/copyEntry/searchCode/fileTree
│   ├── command.ts          one-shot shell exec with blocklist + timeout
│   ├── terminal.ts         createPty (node-pty if installed, else `script`)
│   └── patch.ts            SEARCH/REPLACE patch application + diff output
├── relevance/
│   └── search.ts           rank files by query keywords / filename / imports
├── validation/
│   └── validator.ts        run typecheck/lint/test/build hooks after a patch
└── utils/
    ├── logger.ts           tiny console logger
    └── workspace.ts        getWorkspace / setWorkspace / safeJoin / toRel
```

## Conventions specific to the backend

- **ESM**: `package.json` has `"type": "module"`. Imports must include the
  `.js` extension even for `.ts` source — that's how `tsx` and the compiled
  output stay consistent. Example: `import { foo } from "./bar.js";`.
- **Errors → 4xx**: routes catch and return
  `res.status(400).json({ error: (err as Error).message })`. Reserve 5xx for
  truly unexpected backend bugs (the agent runner uses 500).
- **Workspace-relative paths only** in API responses. Convert with `toRel`
  before sending. Accept relative paths in requests and resolve via
  `safeJoin`.
- **No global mutable state** outside three documented places:
  `utils/workspace.ts` (`currentWorkspace`), `agent/commandLog.ts` (ring +
  bus), and Express middleware/routers.
- **SSE rules**:
  - set `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
    `X-Accel-Buffering: no`, then `res.flushHeaders?.()`;
  - emit a keep-alive comment (`": keepalive\n\n"`) every 25 s on
    long-lived streams;
  - clean up subscribers on `res.on("close", ...)`.

## Adding a new HTTP route

1. Pick a router. Group by domain — chats live in `chats.ts`, file ops in
   `routes.ts` (because they're paired with the agent), folder picker in
   `fs.ts`. If the new feature is a new domain, create a new router.
2. Use `safeJoin` for any path coming from the client.
3. Validate inputs explicitly:
   ```ts
   const p = String(req.body?.path || "");
   if (!p) return res.status(400).json({ error: "path required" });
   ```
4. Mirror the route in `app/frontend/src/lib/api.ts` so the UI gets a typed
   wrapper.
5. If the response shape is non-trivial, also export a TS interface from
   `lib/api.ts` and use it in components.
6. Register the router in `server.ts` (`app.use(...)`) — order matters only
   when paths overlap (more specific first).

## Adding a new agent tool

1. Implement the underlying capability in `tools/`. Keep it independent of
   Express (pure function returning a result or throwing).
2. Add a case in `agent/executor.ts` that:
   - validates `input` shape;
   - calls the tool;
   - returns a string-friendly observation (the LLM will see it).
   - if the tool spawns a process, also call
     `recordAgentCommand(...)` from `agent/commandLog.ts` so it appears in
     the AGENT RUNS sidebar.
3. Document the tool in `llm/prompt.ts` so the model knows it exists.
   Without a prompt update the agent will not call it.
4. If the tool can mutate the workspace, hook it into `validation/validator.ts`
   if appropriate.

See [`docs/agents/agent-loop.md`](agent-loop.md) for prompt + parser details.

## Patch engine cheatsheet

`tools/patch.ts` accepts `SEARCH`/`REPLACE` blocks and:

1. asserts the search string is unique within the file (otherwise the LLM
   may target the wrong occurrence);
2. applies the replacement;
3. returns a unified diff so the UI can render it and the user can revert.

The reverse direction (`api/diff.ts → POST /diff/revert`) reconstructs the
original by inverting the unified diff.

## Process / port management

- The dev script uses `concurrently`. To kill leftover processes from a
  crashed dev session: `pkill -f 'tsx watch' ; pkill -f 'vite'`.
- The terminal file inventory under
  `/home/hcode/.cursor/projects/home-hcode-build-agents/terminals/` shows
  what's running before you start anything yourself.
