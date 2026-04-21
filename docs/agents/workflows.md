# Workflows (recipes)

Concrete, copy-pasteable steps for the most common changes. Each recipe
ends with a verification section so you don't ship blind.

---

## Recipe 1 — Add a backend HTTP route

1. Pick the right router file:
   - file ops, agent, terminal → `api/routes.ts`
   - folder picker → `api/fs.ts`
   - chat history → `api/chats.ts`
   - settings → `api/settings.ts`
   - diff revert → `api/diff.ts`
   - new domain → create `api/<name>.ts` and `app.use(<name>Router)` in
     `server.ts`.
2. Sketch the route with explicit input validation:
   ```ts
   router.post("/foo", async (req, res) => {
     try {
       const path = String(req.body?.path || "");
       if (!path) return res.status(400).json({ error: "path required" });
       const result = await doFoo(safeJoin(path));
       res.json({ ok: true, result });
     } catch (err) {
       res.status(400).json({ error: (err as Error).message });
     }
   });
   ```
3. Add a typed wrapper in `app/frontend/src/lib/api.ts`:
   ```ts
   foo: (path: string): Promise<{ ok: true; result: string }> =>
     fetch(`${BASE}/foo`, {
       method: "POST",
       headers: { "Content-Type": "application/json" },
       body: JSON.stringify({ path }),
     }).then(jsonOrThrow),
   ```
4. **Document** the new endpoint in [`api.md`](api.md).
5. **Verify** via `curl -s -X POST http://localhost:8787/foo -H 'content-type: application/json' -d '{"path":"…"}'`
   then through the UI consumer.

---

## Recipe 2 — Add an agent tool

1. Implement the capability in `tools/<name>.ts` as a pure async function.
2. Wire it in `agent/executor.ts`:
   ```ts
   case "my_tool": {
     const arg = String((input as { arg?: unknown }).arg || "");
     if (!arg) return { ok: false, summary: "my_tool: arg required" };
     const out = await myTool(arg);
     return { ok: true, summary: `my_tool: ${out.summary}` };
   }
   ```
3. **Advertise it** in `llm/prompt.ts` by appending to the tools list with
   the exact JSON shape the executor expects. The model will not call a
   tool it doesn't see in the prompt.
4. If the tool spawns processes, also log via `recordAgentCommand(...)` so
   it shows in the AGENT RUNS sidebar.
5. **Verify**: pose a task in Agent mode that should invoke it; watch the
   chat panel for a matching `ACTION` event and a sane `OBSERVATION`.

---

## Recipe 3 — Add a sidebar / activity-bar view

1. Pick a `view` id (e.g. `"git"`) and add the activity bar button in
   `App.tsx`.
2. Render the panel inside the sidebar Panel, gated on `workspace`:
   ```tsx
   {!workspace ? <WsEmpty onPick={() => setPickerOpen(true)} /> : (
     view === "git" ? <GitPanel /> : ...rest
   )}
   ```
3. Add styles in `styles.css` next to existing sidebar rules; reuse vars.
4. If the panel needs server data, **don't** `fetch` directly — go through
   `lib/api.ts`.
5. **Verify**: open with no workspace → empty state shows; pick folder →
   panel renders; switch view → state preserved (or reset, document which).

---

## Recipe 4 — Persist a new piece of chat / session state

1. Add the field to `ChatSession` (or `ChatTurn`) in
   `app/backend/src/api/chats.ts`. Make it `?optional` so old files load.
2. If it should appear in the sidebar list, add it to `SessionMeta` and
   update `metaFromSession` in `App.tsx`.
3. The frontend's existing `scheduleSave(session, 350)` will pick up the
   new field on the next mutation. No schema migration needed for additive
   fields.
4. If the field is **derived**, recompute on every save instead of trusting
   stale data on disk.
5. **Verify**: mutate via UI; reload page; field round-trips correctly.

---

## Recipe 5 — Show a diff inline / in a tab

You almost never need to write this from scratch — `DiffEditorView` already
handles it. To open one:

```ts
const id = `diff:${diffItem.id}:${diffItem.path}`;
setTabs((tabs) => [...tabs, { id, kind: "diff", path: diffItem.path, diffId: diffItem.id }]);
setActiveTabId(id);
```

If you need a new variant (e.g. compare two arbitrary files), add a new
`kind: "diffPair"` entry to the `OpenTab` union, branch in the editor area
render, and reuse `<DiffEditor />` from `@monaco-editor/react`.

---

## Recipe 6 — Debug a stuck agent run

1. Open the chat session — does the streaming caret pulse? If yes, the LLM
   is still generating; if no, suspect a network / parser issue.
2. Look at the **AGENT RUNS** sidebar for the latest `run_command` and
   click it; the captured stdout/stderr is usually the smoking gun.
3. Check the backend terminal for `agent run failed` log lines.
4. Trigger via curl to bypass the UI:
   ```bash
   curl -N -X POST http://localhost:8787/agent/run \
     -H 'content-type: application/json' \
     -d '{"task":"echo hi","mode":"agent"}'
   ```
   Watch the SSE event stream raw. `error` / `aborted` events tell you
   whether the runner died or the client cut.
5. If it's a parser loop, set `MAX_ITERATIONS=2` in `app/.env` to fail fast
   while iterating on the prompt.

---

## Recipe 7 — Reset everything to a clean state

```bash
# Backend / frontend processes
pkill -f 'tsx watch'
pkill -f 'vite'

# Node modules + lockfile (rare)
rm -rf node_modules app/backend/node_modules app/frontend/node_modules
npm install

# Wipe per-user state (chat history, etc.)
rm -rf ~/.build-agents

# In the browser DevTools console, clear app-specific localStorage:
#   Object.keys(localStorage).filter(k => k.startsWith('build-agents') || k.startsWith('react-resizable-panels')).forEach(k => localStorage.removeItem(k))
```

The next `npm run dev` will boot with the workspace picker open and an
empty chat history.
