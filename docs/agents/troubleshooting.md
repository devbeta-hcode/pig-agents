# Troubleshooting

Symptoms first, fixes second. If your problem isn't here, add it after you
fix it.

## Backend won't start: `EADDRINUSE :8787`

Another backend is already bound (often a leftover `tsx watch` from a
previous crashed dev session).

```bash
lsof -i :8787       # find the pid
pkill -f 'tsx watch'
# or, more surgical:
kill -9 <pid>
```

If you really need a different port: set `PORT` in `app/.env` and update
the Vite proxy in `app/frontend/vite.config.ts` to match.

## Frontend can't reach `/api/*`

Check three things in order:

1. Backend is up — `curl http://localhost:8787/health` should return `{"ok":true,...}`.
2. Vite proxy config still points at the same port.
3. Browser isn't on a stale Service Worker (we don't ship one — but
   browser extensions sometimes inject one). Hard reload.

## Terminal panel just shows "Failed to attach"

`node-pty` failed to load (usually because the build toolchain isn't
present). The backend automatically falls back to the `script` command on
Linux/macOS. If `script` is also unavailable, install it:

```bash
sudo apt install bsdmainutils    # provides `script` on Debian/Ubuntu
```

There is no Windows fallback — use WSL.

## Agent immediately replies "Iteration limit reached without FINAL."

The model is producing output the parser can't read. Check `agent/parser.ts`
expectations:

- Exactly one `THOUGHT:` block, then exactly one `ACTION:` (with valid
  JSON) or `FINAL:` block. No prose before/after.
- Open `agent/parser.ts` and add a `console.log(raw)` to see what the model
  actually emitted.
- If the model is right and the parser is too strict, fix the parser.
- If the model keeps misbehaving, tighten the system prompt in
  `llm/prompt.ts`. Local models often need stronger framing than GPT-4.

## Agent runs but nothing appears in AGENT RUNS sidebar

Either the model isn't calling `run_command`, or the executor isn't
recording. Quick check:

```bash
curl -s http://localhost:8787/agent/commands | jq
```

If the runs are present in that JSON but not the UI, the SSE subscription
is stuck — open DevTools → Network → EventStream and confirm
`/agent/commands/stream` is connected and receiving events. Reconnect by
toggling the Terminals panel.

## Chat history doesn't persist across reloads

1. Confirm the backend wrote files:
   ```bash
   ls -la ~/.build-agents/chats/
   ```
2. Check browser DevTools → Network → `/api/chats?workspace=...` returns
   200 with a populated `sessions` array.
3. If `sessions` is empty but the directory has JSON files, the workspace
   hash differs. The hash is keyed off the **absolute** workspace path, so
   `/home/me/proj` and `/home/me/proj/` are *different* hashes. Check
   `getWorkspace()` returns the canonical path.

## "Open Folder" rejects every path with "outside allowed root"

`ALLOWED_WORKSPACE_ROOT` is set in `app/.env`. Either widen / unset it, or
pick a folder under it.

## I picked a folder but the FileTree is empty

It probably opened — look at the empty state. Check that you didn't pick a
file by mistake (the picker only allows directories, but symlinks can
confuse it). Try the absolute-path input field in the picker.

## `npm run dev` doesn't start the frontend (port 5174 unreachable)

Vite picks the next free port automatically. Look at the frontend log line
in the concurrently output — it'll tell you the actual URL.

## I broke the layout sizes, can't see the chat panel

Click **⟲ Reset layout** in the title bar. It clears
`react-resizable-panels:*` keys and reloads. If the title bar itself is
gone, run this in DevTools console:

```js
Object.keys(localStorage)
  .filter(k => k.startsWith('react-resizable-panels'))
  .forEach(k => localStorage.removeItem(k));
location.reload();
```

## LLM call hangs / never streams a token

- For `LLM_PROVIDER=local`: confirm `BASE_URL` is reachable
  (`curl <BASE_URL>/models`). vLLM/Ollama need to be running independently.
- For `openai`: verify the API key (`curl https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"`).
- The user can click **Stop** in the chat composer to abort a stuck run;
  if abort doesn't work either, the SSE connection is wedged — refresh the
  page (the backend's `res.on("close")` will clean up).

## Patches apply but don't show in the DiffViewer

`agent/runner.ts` accumulates `outcome.diffs` from each `write_patch`. The
SSE `done` event includes `{ diffs }`. The frontend `Chat.tsx` lifts those
into the App's `diffs` state, which `DiffViewer` reads.

Failure modes:

- `executor.ts` returned the patch text but didn't put it in `outcome.diffs`.
- Frontend dropped the `done` event because the SSE was closed early — see
  AGENT RUNS sidebar above.

## Settings save reports success but nothing changed

The backend masks API keys on read. If a request omits the API key field,
the backend keeps the existing one — that's intentional. Make sure the
field you intended to change is actually included in the POST body.

## Provider returns `413` / TPM / “Request too large”

Some tiers cap **tokens per minute (TPM)** per request.

**Default behavior** keeps **full-sized** relevance previews and compact context
(strong agent quality). To save tokens when your provider is strict:

1. Set **`LLM_CONTEXT_BUDGET=tight`** in `app/.env` — smaller file previews,
   shorter history slices, and enables default hard caps (~14k total / ~9k user
   chars unless overridden).

2. Optionally set explicit caps:

   - **`LLM_MAX_PROMPT_CHARS`** — max characters for **system + user** combined.
   - **`LLM_MAX_USER_MESSAGE_CHARS`** — max characters for the **user context** blob.

3. Reduce **`MAX_CONTEXT_FILES`**, start a **new chat** for very long threads,
   or upgrade the provider tier.

## Match Cursor-like agent quality (defaults vs tuning)

With **no** `LLM_CONTEXT_BUDGET=tight` and **no** `LLM_MAX_*` caps: the runner uses
full compact context (deep file previews, **up to 8** recent turns per request,
full system prompt except one-line replies like “continue”).

- **`LLM_DISABLE_MINIMAL_PROMPT=1`** — never swap to the ultra-short minimal
  system prompt (even for “ok” / “continue”).
- **`PROMPT_MODE`** — `minimal` → `economical` → `balanced` → `detailed` → `verbose`
  (fewest → most tokens). Legacy `compact` is treated as `balanced`. Set in Settings or `app/.env`.
  **Ultra-frugal** also turns on tighter context caps (same idea as `LLM_CONTEXT_BUDGET=tight`) and a lower per-request **`max_tokens`** so low-TPM hosts (e.g. Groq on-demand) fit under the limit.
- **`LLM_MAX_TOKENS`** — global override for completion budget (64–8192); wins over per-mode defaults.
- **HTTP 429** — the client waits for the provider’s suggested delay (e.g. Groq’s “try again in Xs”) and retries automatically a few times.
- **`run_command` / shell** — commands run via async `spawn` with stdin ignored (no stdin deadlock). Stdout/stderr are drained on a **serialized async queue** with periodic **`setImmediate`** yields so huge output does not starve HTTP handlers.

## Project rules missing or truncated

Rules live in **`<opened-folder>/.pig/rules/**/*.md`** (optional **`.cursor/rules`**
reuse). They are appended to the system prompt as **PROJECT RULES**. If logs say
rules were truncated, raise **`PROJECT_RULES_MAX_CHARS`** in `app/.env`
(default `16000`). `.build-agents/` only stores policy/checkpoints — not rule text.

## Checkpoints metadata

Checkpoint **metadata** (labels, ids, linkage to git refs / file backups) lives in
**`<workspace>/.build-agents/checkpoints.json`**. Older versions may have left a
**`checkpoints.db`** file there — it is **unused** now; safe to delete if you see it.
