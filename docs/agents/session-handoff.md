# Session handoff

> **For the next agent.** This file is a memory dump from a previous chat
> session. Read it once at the start of a new session, then rely on
> [`../../AGENTS.md`](../../AGENTS.md) and the rest of `docs/agents/` going
> forward. Update this file when you finish a meaningful chunk of work so
> the next handoff stays fresh.

Last updated: 2026-05-12

---

## TL;DR for the new session

The user is building **Pig Agents** (see
[`../../README.md`](../../README.md)). They speak Vietnamese; mirror that in
chat replies, but keep code/comments/docs in English.

Recent work (see **Last session (2026-04-20)** below): UI chevron glyphs,
composer `MentionInput` scrollbar behavior, and an agent-runner guardrail when
the model says “task done” without calling tools. Older milestones (Git panel,
VSCode icons, welcome screen, per-hunk diff, …) are summarized in **Last
session (2026-04-19)**.

---

## What's already implemented (don't re-do)

- Folder picker that defaults to **no folder opened** on first run; the
  flag `build-agents.ws.confirmed.v1` in `localStorage` tracks user
  confirmation. (`App.tsx`)
- Explorer with FileTree, **Cut / Copy / Paste**, **Copy Path** (absolute)
  and **Copy Relative Path**, plus rename / delete / new file / new folder.
  Backend has `copyEntry` with VSCode-style collision suffixes.
- Monaco editor with tabs, dirty state, `Ctrl/Cmd+S`, **inline pending-diff
  highlights**, **PENDING banner with Keep / Undo**, selection → floating
  **"Add to Chat"** action.
- Chat panel with **Ask** and **Agent** modes, slash commands, model
  dropdown, **file mention chips with individual ✕**, **drag files into
  chat**, code-block **Apply** button, streaming agent thinking, regenerate /
  copy / stop, scroll-to-bottom button.
- Chat composer (header w/ file chips, main textarea, footer
  w/ mode + model + actions).
- DiffViewer in the chat panel: header with **Undo All / Keep All / Review**;
  click a row → side-by-side `DiffEditorView` opens as a tab.
- Backend chat history at `~/.build-agents/chats/<wsHash>/` with
  `index.json` + `<sessionId>.json`, atomic writes, debounced 350 ms saves,
  `navigator.sendBeacon` on unload, full-text search with snippets,
  export/import, one-time migration from `localStorage`.
- ReAct agent loop with tools: `read_file`, `list_files`, `search_code`,
  `run_command`, `write_patch`. Patch engine returns unified diffs;
  `/diff/revert` reverses them.
- Terminals panel (VSCode-style header + sidebar) with multiple PTY shells
  and an **AGENT RUNS** section. Each agent `run_command` is recorded to a
  100-entry ring buffer, surfaced via SSE (`hello`, `run`, `delete`,
  `clear`). Per-run dismiss (✕) is **persistent across F5** via
  `DELETE /agent/commands/:id`.
- Settings modal with masked API key (POST without the field keeps the
  existing value).

---

## Non-negotiables (user-stated preferences)

These are repeated in [`../../AGENTS.md`](../../AGENTS.md) §4. Don't
regress them:

1. Workspace defaults to **no folder opened** until the user picks one.
2. Chat history lives **on the backend**, not in `localStorage`.
3. Every agent shell command goes through the **AGENT RUNS** log.
4. **Two chat modes** (Ask / Agent), both must keep working.
5. Diffs are **reviewable**, not silent (DiffViewer + inline highlights +
   Keep / Undo).
6. Tool calls cite **real files only** — `safeJoin` enforces the
   workspace sandbox.
7. Comments explain **why**, not what.
8. Don't commit secrets; preserve API key masking in the Settings UI.

---

## Things deliberately not done yet (fair game if user asks)

- Automated test suite (Jest / Vitest / Playwright). There are no tests
  today; verification is manual.
- Multi-workspace concurrent sessions in one browser tab.
- Embedding-based / semantic relevance — current ranker in
  `relevance/search.ts` is keyword + filename + import-graph.
- AST-aware patches (e.g. `ts-morph`) — current patch engine is
  SEARCH/REPLACE strings.

---

## Useful commands when you boot up

```bash
# What's already running?
ls /home/hcode/.cursor/projects/home-hcode-build-agents/terminals/

# Restart everything from clean
pkill -f 'tsx watch' ; pkill -f 'vite'
npm run dev

# Smoke test the backend
curl -s http://localhost:8787/health
curl -s http://localhost:8787/agent/commands | jq

# Reset user state (chats + workspace confirmation)
rm -rf ~/.build-agents
# in browser DevTools:
#   Object.keys(localStorage).filter(k=>k.startsWith('build-agents')||k.startsWith('react-resizable-panels')).forEach(k=>localStorage.removeItem(k))
```

The dev server URLs:

- Backend → <http://localhost:8787>
- Frontend (Vite) → <http://localhost:5174> (proxies `/api/*` and
  `/terminal/ws`)

---

## How to continue

1. Read [`../../AGENTS.md`](../../AGENTS.md) (the brief) and skim
   [`README.md`](README.md) (the docs index).
2. If the user asks for something specific, follow the matching recipe in
   [`workflows.md`](workflows.md).
3. When you finish a non-trivial chunk of work, **append a short bullet
   here** under a new "Last session" section so the next handoff is honest.

### Last session (2026-05-12) — workspace watcher lease cleanup

The backend filesystem watcher was keeping per-workspace `fs.watch`
instances alive after browser tabs disconnected. On large or frequently
switched workspaces, those stale leases can accumulate and eventually hit
Linux inotify limits (`ENOSPC`).

Fixes:

- `utils/watcher.ts`: ref-count active subscribers, return a release
  callback from `ensureWatching()`, and stop/remove the underlying watcher
  when the last client disconnects.
- `utils/watcher.ts`: if `fs.watch()` fails to start, do not cache the
  failed watcher as a live entry, so later connections can retry after
  resources recover.
- `server.ts`: `/fs/watch` now owns the release callback per websocket and
  runs idempotent cleanup on `close`/`error` so the lease is released
  exactly once.
- Build is green (`npm run build`).

### Last session (2026-05-12) — agent startup no longer stalls before LLM

The agent could appear to hang forever on large workspaces because it did a
full relevance scan and compact tree build before emitting any progress or
calling the LLM. On repositories with lots of files, that made it look like
the model never got a chance to respond.

Fixes:

- `agent/runner.ts`: emit progress logs before context preparation, run
  relevance ranking and tree compaction in parallel, and log when the first
  context bundle is ready.
- `relevance/search.ts`: cap file scanning with `MAX_CONTEXT_SCAN_FILES`
  (default 1200) so huge workspaces cannot block the first model call for
  unbounded time.
- Build is green (`npm run build`).

### Last session (2026-05-12) — chat trace split for Thinking / THOUGHT / ACTION

The chat timeline could mix sections when streamed output skipped clean
`THOUGHT:` boundaries (or emitted `ACTION` early), so users saw reasoning
and action payloads bleed into the same fold.

Fixes:

- `frontend/components/Chat.tsx`: hardened `streamingReasoningExtract()` so
  Thinking only shows the prefix before `THOUGHT`/`ACTION`/`FINAL` (and
  JSON action objects), preventing tool JSON from leaking into the thinking
  block.
- `frontend/components/Chat.tsx`: normalized archive labels to explicit
  `THOUGHT` and added an explicit `ACTION` badge on action accordion rows so
  the three phases read consistently.
- `frontend/styles/chat.css`: added styling for the `ACTION` badge.
- Build is green (`npm run build`).

### Last session (2026-05-14d) — BrowserPanel: page cursor + always-visible scrollbars

Two follow-up complaints from the user about the screencast losing fidelity
vs a real browser:

1. **Cursor didn't reflect page CSS** — pointer over links, text over
   inputs, etc. The panel always showed the OS default arrow.
2. **Scrollbars invisible** even when the page was scrollable. Despite the
   init-script that injects classic scrollbar CSS, modern Chromium's new
   *FluentScrollbar* / *OverlayScrollbar* features hide them when the OS
   cursor isn't actively hovering — and there is no OS cursor in headless.

Fixes:

- **`browser/session.ts` launch args**: added
  `--disable-features=OverlayScrollbar,FluentScrollbar`. Combined with the
  existing scrollbar CSS init script, scrollbars now render as classic
  always-visible 14 px tracks, captured cleanly by the JPEG screencast.
- **`browser/session.ts` hover()**: now returns
  `{ label: string|null, cursor: string|null }` instead of just the
  label. Walks up the DOM from `elementFromPoint` until it finds a
  computed `cursor` value that isn't `auto`/`inherit` — same logic the
  browser itself uses to pick a cursor style. Hover debounce on the
  client dropped 150 ms → 60 ms so cursor changes feel snappy.
- **`api/browser.ts` `/hover`** + **`server.ts` WS `hover` reply**:
  forward both `label` and `cursor`. WS reply event is now
  `{ type: "hover_label", id, label, cursor }`.
- **`BrowserPanel.tsx`**: new `pageCursor` state, applied to the `<img>`
  inline `style.cursor`. Inspect mode still wins (`crosshair`).
  `onMouseLeave` clears it back to default.
- Build green.



User feedback: even after the layout/render decoupling, interactions still
felt laggy because every mousemove/scroll/key/click was a fresh HTTP POST
to `/api/browser/*`. At ~30 moves/s + scroll bursts that's a constant
stream of round-trips through Express middleware — both slow and a great
way to "ngợp backend".

Solution: reuse the existing `/browser/ws` socket as a **bidirectional**
channel. Same WS that streams JPEG frames now also carries input events
client → server.

- **Backend `server.ts`** — `browserWss.on("connection")` adds an
  `ws.on("message")` handler that accepts JSON messages and dispatches:
  `move`, `scroll`, `click`, `key`, `type`, `hover`, `inspect_hover`,
  `viewport`. Per-connection coalescing state:
  - `move` / `scroll` → 16 ms tick (one CDP call per frame max).
  - `viewport` → 120 ms latest-wins (screencast restart is the costliest).
  - `hover` and `inspect_hover` carry a client-supplied `id` and the
    server replies `{type:"hover_label"|"inspect_rect", id, …}` so the
    client can drop stale replies that arrive after the cursor moved on
    (no more flickering tooltips).
  - Cleanup on `ws.close` clears all pending tick timers.
- **Frontend `BrowserPanel.tsx`** — added `wsSend(payload)` helper.
  Hot-path events (`click`, `move`, `scroll`, `key`, `type`, `hover`,
  inspect element highlight, `viewport` resize) now go through the
  socket; HTTP `post(...)` is kept as a graceful fallback when the WS
  isn't `OPEN` (initial connect, reconnect window). Hover label /
  inspect rect listeners added to the WS `onmessage` switch using
  monotonic `hoverReqRef` / `inspectReqRef` ids — only the latest reply
  wins. `mousemove` debounce dropped from 30 ms → 16 ms (server already
  coalesces, so we may as well send promptly).
- **Unchanged HTTP routes** (rare + need a response): `start`, `stop`,
  `install`, `navigate`, `back/forward/reload`, `inspect` (full element
  data + screenshot), `screenshot`, `eval`. Existing per-event POST
  routes still work for backwards compat / fallback.
- Build green.



User feedback after the WebM-extension attempt: **worse** than before — image
distorted (`object-fit: fill` stretched the desktop frame into the panel's
aspect), no auto-resize anymore, and interactions felt laggier. Diagnosis:
the streamer extension never actually worked in headless Chromium (no real
tab to capture), so we were paying full overhead for nothing. Plus
`--headless=new` is slower than legacy headless.

Decision: **revert** the extension/MSE/`<video>` path entirely. Solve only
the original "to tướng" complaint by separating two concepts that had been
conflated: **layout viewport** (what sites use for responsive design,
1280×800 desktop, fixed) vs **screencast output resolution** (size of JPEG
frames Chrome pushes, tracks panel size for crispness without upscaling).

- **Backend `browser/session.ts`**:
  - Removed `streamerPort` / `streamerActive` / extension launch path. Back
    to plain `chromium.launch({ headless: true })` + `browser.newContext()`.
  - Added `private renderCss = { width, height }` field separate from
    `viewportCss`. The page is created with `viewport: { 1280, 800 }` and
    that **never changes** for the lifetime of the session — sites always
    see desktop layout.
  - Rewrote `setViewport(width, height, dpr)`: now updates `renderCss`
    only, then restarts `Page.startScreencast` with
    `maxWidth: min(viewportCss.w, renderCss.w) * dpr`. The min() cap stops
    us from asking Chrome to upscale a small panel.
  - Dropped `Emulation.setDeviceMetricsOverride` from setViewport — it was
    mutating layout, which is exactly what we don't want.
  - JPEG quality 90 → **80** (smaller frames, faster encode, visually
    indistinguishable on a screencast).
- **Backend `server.ts`**: removed `/browser/ingest` WS endpoint and
  `webm-chunk` event forwarding. Back to single `/browser/ws` JSON channel.
  Removed the `setStreamerPort` call from `startListening`.
- **Files deleted**: `app/backend/src/browser/extension/{manifest.json,
  background.js}`, `app/backend/src/browser/extensionDir.ts`. `package.json`
  build script reverted to plain `tsc -p tsconfig.json` (no extension copy).
- **Frontend `BrowserPanel.tsx`**:
  - Removed `videoRef`/`stageRef`/`mediaSourceRef`/MSE helpers/`hasVideo`
    state. Removed `webm-reset` and binary-frame WS handling. Single
    `<img ref={imgRef}>` again.
  - `viewport` is a constant `{ w: 1280, h: 800 }` (used only for
    click-coord mapping into the page's layout space).
  - ResizeObserver restored: on panel resize, debounce 200 ms then POST
    `/api/browser/viewport { width, height, dpr }` with the **panel's
    display size**, not the layout size. This drives the screencast
    resolution change above. Auto-resize works again.
  - Inspect highlight overlay back to `imgRef`.
- **CSS**: `.browser-viewport { background: #1a1a1a }` (dark letterbox
  bg), `.browser-screencast { object-fit: contain }` (no distortion). All
  `.browser-stage` / `--video` / `--hidden` selectors removed.
- Build green (`npm run build`).



User complaint: pixel-perfect dynamic-viewport scaling made every site render
in mobile/tablet layout because the panel-CSS-px width was being sent
straight to Chromium as the viewport. They asked for WebRTC; I went with the
practically-equivalent path that doesn't need a peer connection: a Chrome
extension capturing the active tab via MediaRecorder → WebM chunks → WS →
MediaSource on a `<video>` overlay. The CDP/JPEG screencast is **kept
running** as a fallback so the panel always shows something even if the
extension doesn't load (or while MSE is still warming up).

- **NEW** `app/backend/src/browser/extension/{manifest.json,background.js}`
  — MV2 extension. Background dials `ws://127.0.0.1:PORT/browser/ingest`,
  uses `chrome.tabCapture.capture()` (no user gesture needed thanks to
  `--enable-usermedia-screen-capturing`), pipes the stream through
  `MediaRecorder({ mimeType: "video/webm; codecs=vp8", videoBitsPerSecond: 2_500_000 })`
  with a 100 ms timeslice, and sends each `dataavailable` blob as a binary
  WS frame. Re-captures on `chrome.tabs.onUpdated` (`status === "complete"`)
  and `chrome.tabs.onActivated`.
- **NEW** `app/backend/src/browser/extensionDir.ts` — copies the in-tree
  extension to OS tmp on first start, replacing `__PORT__` in
  `background.js` with the backend's listen port. `package.json` `build`
  script also `cpSync`s `src/browser/extension → dist/browser/extension`
  so the runtime path resolves in production.
- **`app/backend/src/browser/session.ts`**:
  - `setStreamerPort(port)`, `emitWebmChunk(buf)`, `emitWebmReset()` for
    the server.ts WS handlers to plumb extension data through.
  - `start()` now switches to `chromium.launchPersistentContext` (extensions
    require persistent contexts in Playwright) when the streamer extension
    is prepared. Launch flags include `--load-extension`,
    `--disable-extensions-except`, `--enable-usermedia-screen-capturing`,
    `--use-fake-ui-for-media-stream`, plus `--window-position=-32000,…` so
    the headful Chromium window stays off-screen. Falls back to old headless
    `browser.newContext()` if extension prep fails.
  - Reuses `ctx.pages()[0]` (the persistent context's initial about:blank)
    instead of `ctx.newPage()` so the extension's first capture target is
    the page Playwright actually drives.
- **`app/backend/src/server.ts`**:
  - New WS endpoint `/browser/ingest` (rejects non-loopback) for the
    extension uplink.
  - `/browser/ws` handler now also forwards the new `webm-chunk` events as
    binary frames; JSON `webm-reset` control frames signal MSE teardown.
- **`app/frontend/src/components/BrowserPanel.tsx`**:
  - `viewport` is now **fixed at 1280×800** (no more ResizeObserver →
    POST `/browser/viewport` chain). The desktop layout is preserved; the
    panel just scales the rendered image down via CSS.
  - New `<div class="browser-stage">` wraps both the existing `<img>`
    JPEG fallback and a new `<video>` overlay. The stage has
    `aspect-ratio: 1280/800; max-{w,h}: 100%` so it letterboxes inside the
    panel; mouse coord helpers (`scaleCoords`, `handleWheel`, inspect
    overlay) all map against `stageRef.getBoundingClientRect()` instead of
    `imgRef`.
  - WS `binaryType = "arraybuffer"`. Binary frames feed
    `setupMediaSource()` / `appendWebmChunk()` (queued + drained on
    `updateend`, with a defensive QuotaExceeded fallback that drops the
    oldest buffered range). First chunk reveals the video overlay and
    hides the `<img>` via `.browser-screencast--hidden { visibility: hidden }`.
  - On `webm-reset` (extension restarted MediaRecorder after a navigation)
    we tear down the MediaSource and start fresh on the next chunk.
- **CSS** (`styles.css` + `styles/workspace-manager.css`): `.browser-viewport`
  now centers the stage on a dark letterbox background; `.browser-stage`
  carries the desktop aspect; `.browser-screencast--video` and
  `--hidden` toggle the overlay.
- Build green (`npm run build`).
- **Caveats** (this is a POC; expect iteration):
  - The extension uses MV2 — Playwright's bundled Chromium still loads
    MV2 fine but be aware MV3 may be required eventually.
  - `tabCapture.capture()` from a background page without a user gesture
    relies on the `--enable-usermedia-screen-capturing` flag. If a
    Chromium update removes that flag, the capture call will fail and
    the panel will silently fall back to JPEG-only.
  - **No X server needed**: launch flags include `--headless=new` (Chrome
    109+ "new headless" mode), and `headless: false` is passed to
    Playwright so it doesn't inject the legacy `--headless` flag that
    would conflict. New headless supports both extensions and tabCapture.
    Initial attempt used a real headful window with off-screen
    `--window-position` and crashed on server boxes ("Looks like you
    launched a headed browser without having a XServer running.").



- **Backend `browser/session.ts`**:
  - Bumped CDP screencast JPEG quality 75 → 90 and `everyNthFrame: 1`.
  - Added `setViewport(width, height, dpr)` that calls
    `Emulation.setDeviceMetricsOverride` (so `deviceScaleFactor` can
    change mid-session) and restarts the screencast at
    `width*dpr × height*dpr`. This is the main blur fix.
  - Added `mouseMove(x, y)` → `page.mouse.move()` so CSS `:hover` /
    `mouseenter` / `mousemove` actually fire on the live page.
  - `addInitScript` injects forced `::-webkit-scrollbar` styling on every
    page so users can SEE the page is scrollable (Chromium's default
    overlay scrollbars vanish in screencasts).
- **Backend `api/browser.ts`**: new routes `POST /browser/move` and
  `POST /browser/viewport`.
- **Frontend `BrowserPanel.tsx`**:
  - Added `viewport` state + `viewportSentRef`. ResizeObserver on the
    viewport div debounces 200 ms and POSTs `/browser/viewport`
    `{ width, height, dpr }`.
  - `scaleCoords` and `handleWheel` now use `viewport.{w,h}` instead of
    hardcoded 1280×800; inspect highlight overlay scales the same way.
  - `handleImgMouseMove` now ALSO debounces (~30 ms) `POST /browser/move`
    so real hover dispatches happen alongside the slower (150 ms) hover
    label fetch.
- **CSS**: `.browser-screencast { image-rendering: -webkit-optimize-contrast }`.
- Build green (`npm run build`).

### Last session (2026-05-13) — docs sync for web + browser tools

- `README.md`: tool list now mentions `glob`, `create_file`, `web_search`,
  `web_fetch`, the full `browser_*` family, and the approval-gate model.
  API table gains `/agent/approvals/:askId`, `/policy*`, and `/browser/*`.
- `docs/agents/agent-loop.md`: tool table rewritten to reflect every tool
  the executor actually dispatches (was missing 9). New "Approval gate"
  subsection. SSE event table now lists `policy_ask` / `policy_decision`.
- `docs/agents/api.md`: `/agent/run?stream=1` event list updated; new
  "Approval policy" section (`/policy`, `/policy/auto-approve*`,
  `/policy/{allow,deny}`); new "Browser" section documenting every
  `/browser/*` route + the screencast WebSocket.
- `docs/agents/architecture.md`: backend ASCII diagram now shows
  `browser.ts`, `smartCommand.ts`, `web.ts`, `policy.ts`, `approvals.ts`,
  and the shared `browser/session.ts`.

### Last session (2026-05-13) — agent-driven Playwright browser tools

- Context: `BrowserSession` (singleton in `app/backend/src/browser/session.ts`)
  was already wired to the `BrowserPanel` UI, but the agent had no way to
  drive it. The only "web" reach was `web_fetch` (raw HTTP) which is useless
  for SPA / dev-server pages that need JS to render.
- New helpers on `BrowserSession`: `ensureStarted()` (lazy launch on first
  agent call), `getTitle()`, `getPageText(selector?, maxChars)`,
  `getPageHTML(selector?, maxChars)`, `clickSelector()`, `fillSelector()`,
  `waitForSelector()`. They share the same `Page` as the panel, so when the
  agent navigates/clicks the user sees it live in the screencast.
- Executor (`agent/executor.ts`) gains 7 new tool cases —
  `browser_navigate`, `browser_get_text`, `browser_get_html`,
  `browser_click`, `browser_fill`, `browser_wait_for`, `browser_eval`.
  Each goes through `gateWebApproval(ctx, "browser", <human-readable
  description>)` so the same Settings toggle (`Auto-allow web tools`) and
  the same approval modal cover them — no new policy switch.
- Modal: `PendingApproval.kind` now also accepts `"browser"`; copy:
  "Agent wants to drive the browser" + field label "Browser action".
  Allow-always pattern row stays hidden (web flow).
- Prompts: both `prompt.ts` and `prompt-compact.ts` advertise the new tools
  with one-line usage hints and a steering note ("Use instead of web_fetch
  when the page needs JS to render").
- Build green for both backend and frontend.

### Last session (2026-05-13) — web tools (`web_fetch` / `web_search`) with approval gate

- New backend tool `app/backend/src/tools/web.ts`:
  - `webFetch(url, maxChars)` — Node 20 `fetch`, hand-rolled HTML→text
    stripper, 12 KB body cap, 15 s timeout, realistic UA. SSRF guard
    rejects non-http(s), loopback, link-local, and RFC1918 hosts before the
    request fires.
  - `webSearch(query)` — scrapes `html.duckduckgo.com` (no API key, no
    third-party deps), returns up to 8 `{title, url, snippet}` hits.
- Executor (`app/backend/src/agent/executor.ts`):
  - `gateWebApproval(ctx, kind, initial)` emits a `policy_ask` SSE event
    with `kind: "web_fetch" | "web_search"` and waits for the user's
    answer — unless `policy.autoApproveWeb` is on, in which case it skips.
  - New cases `web_fetch` / `web_search` wired into the tool dispatch.
- Policy (`app/backend/src/utils/policy.ts`): added
  `autoApproveWeb?: boolean` field + `setAutoApproveWeb(value)` mutator.
  Persisted to `<workspace>/.pig-agents/policy.json`.
- Route: `POST /policy/auto-approve-web` → `{ ok, autoApproveWeb, policy }`.
- Prompt (both `prompt.ts` and `prompt-compact.ts`): added the two tools to
  the catalogue with one-line usage hints; warning that web access is
  always gated by user approval (or the auto-allow toggle).
- Frontend:
  - `lib/api.ts`: `CommandPolicy.autoApproveWeb?` + `setAutoApproveWeb()`.
  - `CommandApprovalModal.tsx`: `PendingApproval.kind` field; modal title /
    field label / hint copy now branch on `kind`. For web kinds the
    "Allow always" pattern row + button + "Auto-approve all" button are
    hidden — those are shell-specific concepts; the equivalent for web is
    the Settings toggle.
  - `Chat.tsx`: forwards `kind` from the SSE event into the approval queue.
  - `SettingsModal.tsx`: new "Auto-allow web tools" toggle right under the
    existing command auto-approve toggle, hitting
    `/policy/auto-approve-web`.
- Build: `npm run build` is green for both backend and frontend.

### Last session (2026-05-12) — stray END/EOF marker leaking into create_file

- Symptom: model frequently appended `END` (or `EOF`, `END_OF_FILE`) on a
  fresh line at the bottom of a `create_file` content payload — confused
  with the `write_patch` SEARCH/REPLACE/END syntax. The marker became a
  literal line in the produced file, so `main.jsx` would throw
  `Uncaught ReferenceError: END is not defined` in the browser.
- `app/backend/src/agent/executor.ts`: added `stripStrayPatchMarkers()`
  helper. The `create_file` case now passes `content` through it before
  writing to disk. Pattern only matches a sentinel-only trailing line so
  legitimate code containing the word "END" mid-line is untouched.
- `app/backend/src/tools/patch.ts`: `parsePatch` single-file form (when
  `defaultPath` is supplied) now also strips a trailing `\nEND` from the
  REPLACE body — same root cause: model adds it out of habit even though
  the single-file shape doesn't take a terminator.
- `app/backend/src/llm/prompt.ts` and `app/backend/src/llm/prompt-compact.ts`:
  `create_file` description now explicitly warns that content is written
  verbatim and END/EOF markers belong only to write_patch.

### Last session (2026-05-12) — model hallucinated cwd (`cd /workspace`)

- Symptom: every `run_command` action in chat trace showed
  `cd /workspace && ...` or `cd /data/workspace && ...` followed by
  `bash: line 1: cd: /workspace: No such file or directory`. The tool was
  already running with `cwd = getWorkspace()` — the model just hallucinated
  a canonical absolute path from training data.
- `app/backend/src/llm/prompt.ts` and `app/backend/src/llm/prompt-compact.ts`:
  the `run_command` tool description now spells out "cwd is already the
  workspace root, do NOT prefix with `cd /workspace` / `cd /data/workspace`
  / any imagined absolute path". Both `buildContextMessage` and
  `buildContextMessageCompact` now accept an optional `workspacePath` and
  inject a `WORKSPACE_PATH: <abs>` line into the per-turn user context, so
  the model has the real absolute cwd in front of it.
- `app/backend/src/agent/runner.ts`: passes `wsRoot` (already in scope) to
  both context builders.

### Last session (2026-05-12) — env leak: PORT bleeding into spawned children

- Symptom: agent's HTTP server reads `process.env.PORT` to pick its own
  listen port. Every child process spawned by the agent inherited that
  PORT, so a user dev server with `const PORT = process.env.PORT || 3001;`
  would boot on the agent's port (8787) instead of 3001 — looks like a
  port-conflict ghost bug from inside the workspace.
- `app/backend/src/server.ts`: prefer `BACKEND_PORT` > `AGENT_PORT` >
  `PORT` (legacy) > 8787, then `delete process.env.PORT` after we've
  decided so nothing we spawn can re-read it.
- `app/backend/src/tools/smartCommand.ts`: new exported helper
  `childSpawnEnv(extra)` returns `{ ...process.env, ...extra }` minus
  `PORT`, `BACKEND_PORT`, `AGENT_PORT`. Used by the smart `run_command`
  spawn here.
- `app/backend/src/tools/command.ts`: legacy `run_command` spawn now uses
  `childSpawnEnv()` instead of inlining `...process.env`.
- `app/backend/src/tools/terminal.ts`: PTY env (node-pty path, `script`
  fallback, dumb child fallback) all switched to `childSpawnEnv()`. User
  PTY shells therefore also get a clean PORT.

### Last session (2026-05-12) — diff streaming + chat memory caps

- `app/backend/src/agent/runner.ts`: `EarlyToolExec` now carries a
  `streamedObservation` flag. When a write tool finishes mid-iteration the
  runner emits its `observation` event (with diffs) immediately, so a
  multi-file turn (e.g. 5 `create_file` calls) populates the diff sidebar
  one file at a time instead of dumping all five only after the iteration
  wraps up. The four iteration-level aggregator emit sites (lone-write fast
  path, consultation FINAL path, ACTION+FINAL combo, multi-action tail)
  filter out diffs from already-streamed entries so the diff list never
  doubles up.
- `app/frontend/src/components/Chat.tsx`:
  - Added `STREAMING_BUFFER_CAP = 256_000` and `capStreamingBuffer()`. Both
    `flushTokenRaf` and `flushPendingTokensNow` now cap `thinking.partial`
    so a runaway iteration with a multi-MB tool payload can't grow the
    streaming buffer unbounded (was the prime cause of "tràn bộ nhớ" during
    very long agent reasoning streams).
  - Added a turn-window (`turnWindow` state, default 60, +60 per click)
    around `session.turns.map(...)`; only the last N turns render. A
    rounded-pill "Load N older message(s)" button appears at the top of the
    log when the window is cropping. Window resets when `session.id`
    changes. This is a pragmatic stand-in for full virtualization — the
    existing scroll/stick-to-bottom machinery is too entangled to swap to
    `react-virtuoso` safely in a single pass.
- `app/frontend/src/styles.css`: added `.chat-load-older` / `.chat-load-older-btn`
  / `.chat-load-older-count` rules.
- `app/frontend/package.json`: added `react-virtuoso` (currently unused;
  reserved for the proper virtualization pass when the scroll machinery
  gets refactored).

### Last session (2026-05-09) — chat trace separation invariant

- `app/frontend/src/components/Chat.tsx`: chat trace rendering now treats the agent stream as three independent parts, always ordered as **Thinking** (collapsible box from text before `THOUGHT:`), **THOUGHT** (plain text log from text after `THOUGHT:`), then **ACTION** (tool rows). Added separate settled stores/props for reasoning and THOUGHT so ACTION rows no longer steal or reorder the thinking/thought content when SSE events arrive late.
- Follow-up fix: `Thinking` is now persisted into chat turns as a synthetic `reasoning` event and `AgentEvent` includes the `reasoning` type, so reload/F5 can restore the pre-`THOUGHT:` box instead of losing it. `AssistantMessage` sorts each iteration with a hard rank: `reasoning -> thought -> action -> observation`, then groups same-iteration rows into `.trace-iteration-group` / `.trace-iteration-step` wrappers.
- Follow-up UI correction: the first box must be labeled **Thinking** (not “Reasoning Trace”). Timeline connectors are tree-style branches around the same iteration (Thinking/THOUGHT/ACTION), not one continuous `.agent-log-container` rail; grouped action rows use one group-level vertical trunk plus per-row L branches, so expanding one file row does not break the connector line.
- Correction after user feedback: ACTION owns its own group. `AssistantMessage` now wraps every ACTION run in `ActionGroupFold` (including single-item actions), and the rows/files/commands for that ACTION live inside that group instead of floating directly at the iteration level. The outer iteration connector is disabled around `.assistant-action-group` so the action header is not shifted by an extra timeline gutter.
- `app/frontend/src/styles/overrides.css`: chat trace disclosure icons are intentionally right-aligned (`order: 10; margin-left: auto`) for Thinking, ACTION groups/items, trace rows, and inline tool diffs so the left side stays reserved for the timeline rail + row content.
- `app/frontend/src/styles/chat.css`: inner ACTION group rows no longer draw the left vertical connector. Nested tool rows use `padding-left: 20px` (with no `margin-left`) so the child item starts under the parent ACTION header text column instead of the removed rail gutter.
- `app/frontend/src/components/Chat.tsx`: nested ACTION item `<details>` must not close/open the parent ACTION group; `onToggle` handlers now ignore bubbled toggle events, and item folds stop propagation.
- `app/frontend/src/components/Chat.tsx`: loose flat trace logs such as `INF Project rules...` are skipped entirely; chat trace should show Thinking/Thought/ACTION/Observation content, not standalone `TraceLogGroup` rows.
- `app/frontend/src/components/Chat.tsx` + `app/frontend/src/styles/chat.css`: grouped top-level trace rows now use Ant Design `Steps` (`direction="vertical"`, `size="small"`) for the connector instead of custom `.trace-iteration-step::before/::after` rails. Each step must pass a trace-specific `icon` (Brain/File/Edit/Terminal/Search) so antd does not render the default check icon; CSS hides duplicate row icons inside `Steps` and keeps the existing trace row content as the description.

### Last session (2026-05-08) — chat log CSS + runtime bugs

- **Chat log UI redesigned to Copilot-style** (`styles.css` + `Chat.tsx`).
  - User bubbles: removed heavy gradient, now subtle accent-tinted border + background, right-aligned; action buttons revealed on hover (icon-only, no borders).
  - Assistant messages: replaced inline avatar with a proper header row (small gradient avatar square + "Pig Agents" label); content area padding normalised to full-width with `padding: 4px 16px`.
  - Mode badge (Ask/Agent): accent-tinted pill with border instead of opaque background.
  - Tool accordion rows: lighter background (`bg-2/bg-3` blend), 2px left border (was 3px), tighter gaps (3px between steps instead of 10px), no left-margin timeline gutter.
  - Thought sections: brain icon tinted with `accent-2`, cleaner border/background matching accordion style.
  - Log groups: rounded pill border instead of flat bottom border.
  - `msg-actions-bottom`: opacity 0 → 1 on hover, icon-only with no border; "Restore" label shortened.
  - `trace-reasoning-summary`: removed legacy CSS triangle pseudo-element (ChevronExpand already handles this).

### Last session (2026-05-11) — chat trace: inline THOUGHT + grouped ACTIONs

- `app/frontend/src/components/Chat.tsx`:
  - `ThoughtStepArchive` rewritten to render the THOUGHT body as plain inline markdown (`.thought-step-inline`) instead of a collapsible "Step N" box. The pre-THOUGHT live thinking stream (`LiveThoughtStreamFold`) is unchanged.
  - Removed unused `thoughtCollapsedPreview`.
  - Render loop in `AssistantMessage` now tracks per-node `groupKeys`; consecutive items pushed with the same key (`${tool}#${iter}` for ACTIONs incl. write_patch slices and the streaming peek) are wrapped in a new `ActionGroupFold` (collapsible accordion with tool name + count badge). Single ACTIONs stay standalone.
  - `streamingThoughtExtract` / `streamingFinalExtract` now run buffer through `normalizeStreamXmlMarkers` so live previews work for XML-emitting models.
- `app/frontend/src/styles.css`: Added `.assistant-action-group{,-sum,-tool,-badge,-body}` and styled `.thought-step-inline` (subtle accent-rail quote, slightly muted, smaller line-height).
- `app/backend/src/agent/parser.ts`: New `normalizeXmlTags` converts `<thought>…</thought>`, `<action>{…}</action>`, `<final>…</final>` to canonical `THOUGHT:` / `ACTION:` / `FINAL:` markers before extraction. Without it, models like DeepSeek emit XML and only the first ACTION (via fallback) was parsed — the rest leaked into THOUGHT body and rendered as raw text. Applied in both `parseAgentResponse` and `extractAllActions`.
- `app/frontend/src/lib/streamingToolPeek.ts`: Mirror of the same normalization so streaming peek/marker counters work for XML output.

### Last session (2026-05-10)

- **Agent token waste fix: compact workspace tree pre-embedded in context.**
  - `app/backend/src/tools/file.ts`: Added `buildCompactTree(maxDepth, maxLines)` — lightweight indented dir tree (no manifest excerpts), depth ≤ 3, max 200 lines, skips node_modules/dist/.git etc.
  - `app/backend/src/agent/runner.ts`: Calls `buildCompactTree(3, 180)` once per run before the ReAct loop; result passed to both context builders.
  - `app/backend/src/llm/prompt.ts`: `buildContextMessage` now accepts optional `tree?: string`, adds `WORKSPACE:` section above `RELEVANT FILES`. Updated `codebase_map` tool description + "tool discipline" rule to say tree is already in context.
  - `app/backend/src/llm/prompt-compact.ts`: Same for `buildContextMessageCompact`; both compact/minimal prompts updated to say codebase_map is rarely needed.
  - Net effect: agent skips the `codebase_map` first iteration (saves 1 full round-trip ≈ 300-800 tokens per run).

- **"Select Element to Chat" inspect mode in BrowserPanel.**
  - `app/backend/src/browser/session.ts`: Added `inspectElement(x,y)` method — calls `getElementAt` then takes a cropped `page.screenshot({ clip: boundingRect })`, returns `{ element: ElementInfo, screenshot: base64png }`.
  - `app/backend/src/api/browser.ts`: Added `POST /browser/inspect { x, y }` route.
  - `app/frontend/src/components/BrowserPanel.tsx`: Added `onAddElementToChat?: (html, imageDataUrl) => void` prop; `inspecting` boolean state; replaced camera/screenshot download button with crosshair toggle "Select element to chat" button (active = accent color); when `inspecting` + click → calls `/inspect` → fires `onAddElementToChat`; Esc cancels inspect; crosshair cursor on viewport; blue accent banner overlay "Click on an element…" while active.
  - `app/frontend/src/components/Chat.tsx`: Added `pendingInjectImage?: string` + `onInjectImageConsumed?` props; useEffect adds injected data URL to `attachedImages` (shows as thumbnail in composer, not raw base64).
  - `app/frontend/src/App.tsx`: Added `pendingChatImage` state; `BrowserPanel.onAddElementToChat` sets both `pendingChatInject` (HTML text) and `pendingChatImage` (data URL); passes `pendingInjectImage` + `onInjectImageConsumed` to `Chat`.
  - `app/frontend/src/styles.css`: Added `.browser-inspect-banner` (accent pill at top of viewport).

- **Earlier in this session** (carried over from compacted context):
  - Settings token cap: `Math.min(8192,…)` → `Math.min(131072,…)` in `settings.ts`
  - Browser button moved from activity bar → titlebar next to Terminal button
  - System deps auto-detect on Chromium launch failure (libatk regex) → "Install System Dependencies" button
  - Keyboard forwarding: `typeText()`/`keyPress()` backend + `/type`,`/key` routes + SPECIAL_KEYS map in frontend
  - Batched scroll (16ms) via `/scroll` route
  - Hover element label tooltip
  - Animated loading progress bar
  - Full Cursor-style toolbar: Back/Forward/Reload↔Stop, URL bar (lock/globe icon), Add to Chat, Zoom+/−/Reset, Close

### Last session (2026-05-09)

- **Built-in Browser panel (Playwright + CDP screencast).** New activity-bar
  globe icon opens a full-panel browser view. Implementation:
  - `app/backend/src/browser/session.ts`: `BrowserSession` singleton — wraps
    Playwright Chromium, `Page.startScreencast` (JPEG via CDP), exposes
    `navigate`, `goBack/Forward/reload`, `clickAt(x,y)`, `getElementAt(x,y)`,
    `evalScript`, `installPlaywright()`, `isPlaywrightReady()`, `start/stop`.
  - `app/backend/src/api/browser.ts`: REST router mounted at `/api/browser/*`
    — `GET /status`, `POST /install`, `POST /start/stop/navigate/back/forward/
    reload/click/element/eval`.
  - `app/backend/src/server.ts`: Added `browserWss` (`noServer:true`), wired
    `/browser/ws` in upgrade router, fans out `BrowserSession "event"` to all
    connected WS clients. Also imports `browserRouter`.
  - `app/frontend/vite.config.ts`: `/browser/ws` proxy added (WS, port 8787).
  - `app/frontend/src/components/BrowserPanel.tsx`: Auto-detects playwright
    install state (shows "Install" button with live SSE log), "Launch Browser"
    button, URL bar with back/forward/reload, JPEG screencast rendered in `<img>`,
    click → sends coords → backend, element inspector panel with "Add to Chat".
  - `app/frontend/src/App.tsx`: `ActivityView` type gains `"browser"`, globe
    icon button in activity bar, `<BrowserPanel>` replaces editor area when
    `view === "browser"`, `pendingChatInject` state → passes to `<Chat>`.
  - `app/frontend/src/components/Chat.tsx`: Added `pendingInject` + `onInjectConsumed`
    props; `useEffect` appends injected text to composer when set.
  - `app/frontend/src/styles.css`: Full browser panel CSS added (setup card,
    toolbar, viewport, screencast, inspector).
  - `playwright` npm package installed in `app/backend`.

- **UI fixes from earlier in this session** (carried over from compacted context):
  - EditorWelcome subtitle: "Cursor-style" → "Your AI coding workspace"
  - Terminals sidebar: drag-to-resize handle (mousedown/move/up on `right:-3px` strip, `overflow-x:hidden`)
  - Composer footer CSS cleaned up (4 conflicting layers → 6 minimal rules, no `!important`)
  - Model dropdown: `right:0; width:auto` so it doesn't overflow the chat panel

### Last session (2026-05-08)

- **Timeline content inset:** On `.agent-log-timeline`, added `--assistant-timeline-content-inset` (matches summary `padding-left` + `.assistant-action-fold-chev`/`assistant-thought-fold-chev` 22px + flex gap); ACTION fold bodies (`.tool-details`, stream previews, `.tool-create-stream`) and live Thought scroll use it so payloads line up with the header row instead of drifting on a separate 20px indent. Files: `app/frontend/src/styles.css`.

- **Tool timeline single-expand:** Removed inner “Show …” rows in `ToolOutput` for `read_file`, `list_files`, `search_code`, `run_command`, `create_file`, and `write_patch` observation follow-up so the outer timeline accordion is the only expand control; added `.tool-inline-body-*` spacing resets. Files: `app/frontend/src/components/ToolOutput.tsx`, `app/frontend/src/styles.css`.

- **Multi-write ACTION accordion focus:** Earlier `write_patch` / `create_file` rows collapse when disk has settled (`tool_disk_settled`) and trace already shows a later `action` for the same iteration (combined `observation` still pending). Implemented `priorWriteCollapsedBySuccessorAction` + prop on `ActionAccordionFold`. File: `app/frontend/src/components/Chat.tsx`.

- **Live Thought disclosure:** Summary uses `ChevronExpand` plus `.assistant-thought-fold-chev` (shared gutter widths with ACTION rows); removed legacy `.trace-reasoning-summary::before` triangle under `.assistant-live-thought`. Files: `app/frontend/src/components/Chat.tsx`, `app/frontend/src/styles.css`.

- **Chat auto-scroll respects manual scroll-away:** Streaming token batches could outrun batched `setAutoScroll(false)` from `onScroll`, so pinned-to-bottom scrolling used stale state and yanked users off upward reads. Tail-follow uses `stickToBottomRef` gated in `useLayoutEffect`, clearer bottom slack (`CHAT_LOG_STICK_BOTTOM_PX`), and upward `wheel` breaks stick immediately before replays clamp `scrollTop`. Files: `app/frontend/src/components/Chat.tsx`.

- **`codebase_map` inline map:** Removed inner “Show map / Hide map” toggle (`CodebaseMapOutput`) so one click on the outer timeline accordion reveals the summary; tweaked `.tool-codebase-map-body` spacing. Files: `app/frontend/src/components/ToolOutput.tsx`, `app/frontend/src/styles.css`.

- **ACTION accordion disclosure:** Replaced coarse CSS triangle `::before` with shared `ChevronExpand` SVG on `ActionAccordionFold` summaries (`.assistant-action-fold-chev`). Files: `app/frontend/src/components/Chat.tsx`, `app/frontend/src/styles.css`.

- **Thought vs Acting UX in agent chat:** Wrapped `.assistant-step-list` in `.agent-log-container.agent-log-timeline`; live + archived Thought use `thought-section assistant-thought-box`, muted `IconBrain` summary, statuses **Analyzing… / Thinking · Ns**, default collapsed until first streamed reasoning arrives (still collapses once tools dominate). ACTION accordions get left-accent variants (`assistant-action-accent--*` for mutate vs read-fs vs terminal vs search vs map). Files: `app/frontend/src/components/Chat.tsx`, `app/frontend/src/components/Icons.tsx`, `app/frontend/src/styles.css`.

- **Streaming `write_patch` diff-ish preview:** Per-line span classes (+/- / @@ / FILE: / SEARCH/REPLACE markers), file banner row with `FileIcon` + relative path via first `FILE:` line, accordion header shows **Applied** after success / **writing…** while streaming. Files: `app/frontend/src/components/ToolOutput.tsx`, `app/frontend/src/styles.css`.

- **Multi-ACTION SSE turns (`peekNth`):** Streaming peek previously read only the first `ACTION:` block, so subsequent tools in the same token buffer reused the wrong patches / stalled until full JSON landed. Added `nthActionBlobAfterMarker` + `peekStreamingToolArgBodyNth` (+ related), `streamingActionOrdinal` on `TraceStep` / `ActionAccordionFold`, and marker-count–based synthetic write rows. Timeline container uses **flex column + gap** so ACTION accordions do not visually merge (`styles.css`). Files: `app/frontend/src/lib/streamingToolPeek.ts`, `app/frontend/src/components/Chat.tsx`, `app/frontend/src/styles.css`.

- **Copilot-like agent activity stream in chat.** Grouped consecutive `INF`/policy rows into one compact block; flattened `.trace` panel (theme tokens vs heavy gradient); tightened turn spacing + answer separator (`assistant-answer`); collapsible `<details>` "Reasoning" for completed turns. Files: `app/frontend/src/components/Chat.tsx`, `app/frontend/src/styles.css`.

- **Removed boxed `.trace` wrapper.** Streaming thought Markdown + elapsed line render as loose blocks in `.msg-content`; INF/tools/peek/streamingArgPreview (`ToolOutput` + `TraceStep`) list as `.assistant-step-list` siblings—no nested scroll shell. Files: `app/frontend/src/components/Chat.tsx`, `app/frontend/src/styles.css`.

- **Dropped redundant runner INFO logs + hide from persisted chat.** Removed `Ask/Agent mode starting`, `Selected N relevant files`, and checkpoint-created INFO emits; unsuccessful checkpoint is now `warn` only. Frontend filters the same legacy log shapes so old sessions stay clean. Files: `app/backend/src/agent/runner.ts`, `app/frontend/src/components/Chat.tsx`.

- **Chat panel Loading… fixed when chat API fails.** `listChats` / `getChat` errors previously left `activeSession` unset forever; fallback to a local empty session (+ `chatListRef` for GET recovery title meta). Workspace switch clears `activeSessionId` before re-listing. File: `app/frontend/src/App.tsx`.

- **Live Thought folds + ACTION accordions (streaming UX).** Thought `<details>` auto-collapses once the same iteration has a persisted `action` or streaming write peek (`collapseWhenToolsVisible`). ACTION folds start **open** while awaiting observation (`applying…`); close when observation lands. When tools are visible, the thought summary drops thinking dots + elapsed timer so it does not read as active streaming. Files: `app/frontend/src/components/Chat.tsx`.

- **multi-file `write_patch` → one accordion per `FILE:` block.** Parsed via `splitWritePatchByFileSections` + `mergeWritePatchStreamBody` / `peekWritePatchSection` (`streamingToolPeek.ts`). `ActionAccordionFold` pins header stream text per slice (`writePatchHeaderPreview`). Extra rows omit duplicate **Show changes** (`suppressObservationFollowup` → `suppressWritePatchObservationFollowup`). Files: `streamingToolPeek.ts`, `Chat.tsx`, `ToolOutput.tsx`.

- **Per-step archived thought + live stream handoff.** Parsed `thought` SSE clears the duplicate live token buffer and drops into `<details>` with `Step N` + one-line preview (default closed); live Markdown only shows until that iteration’s thought is finalized. `processSessionEvent`: wipe `thinking.partial` on matching `thought`; `TraceStep` renders `thought-step-archive`. CSS: `.thought-step-archive-*`. Files: `app/frontend/src/components/Chat.tsx`, `app/frontend/src/styles.css`.

- **`tool_payload_streaming` omitted from assistant trace.** No duplicate STREAMING/write_patch buffer block; streamed patch/content still flows through `ToolOutput` / synthetic `TraceStep` (`streamingPartial`). Files: `app/frontend/src/components/Chat.tsx`.

- **Flat OpenUI-style agent trace in chat (always visible).** Brought back live
  “Thinking” (streamed reasoning) and `action` rows via `ToolOutput` (file chips / applying / stream). No chevron
  collapse: `trace--flat` + `streamingText` / `streamingIteration` wired from
  `thinking` into `AssistantMessage`. Added flat trace CSS (payload `pre`
  max-height, log rows, tool row padding). Files: `Chat.tsx`, `styles.css`,
  `app/frontend/src/lib/streamingToolPeek.ts`.

- **Assistant final markdown: no Insert/Apply on fenced code.** Agent turns
  already apply edits via tools; full CodeBlock actions duplicated Cursor-style
  “composer in the bubble”. `Markdown variant="assistant"` keeps Copy only and
  caps block height. Files: `Markdown.tsx`, `Chat.tsx`, `styles.css`.

- **Sanitize user-visible agent/ask replies.** Models sometimes paste rubric lines
  like `(Vietnamese) describing that I can…` or duplicate `THOUGHT:` into FINAL
  or Ask Markdown; the chat bubble showed that junk. Added `sanitizeFinal.ts` and
  apply `sanitizeFinalOrKeep` before emitting `final` in `runner.ts` (Ask + Agent
  success paths). Prompts now forbid meta-rubric / THOUGHT-in-FINAL explicitly.
  Files: `sanitizeFinal.ts`, `runner.ts`, `prompt.ts`, `prompt-compact.ts`.

- **write_patch trace stream: no character typewriter.** The patch panel
  revealed text ~3 chars per tick, so users often saw `FIL` + caret while the
  buffer was already spelling `FILE:…`. Live `pre` now mirrors `targetPatches`
  directly and auto-scrolls on change. File: `ToolOutput.tsx`.

- **Fix false “still writing files” after F5 / history load.** The runner emits
  `thought` between `action` and `observation`, but the trace UI only paired a
  tool row with an observation if it was the very next trace row (after
  `command_chunk`s). That left `observation` missing on reload, so
  `CreateFileOutput` / `write_patch` behaved like live streaming again. Now we
  scan forward for the first `observation` with matching `iteration`.
  File: `Chat.tsx`.

- **Fix streamed `create_file` / `write_patch` `<pre>` stretching the trace.**
  CSS had forced `max-height: none` on the inner `pre` while only the wrapper
  was capped, so the block sized to full file content (~thousands of px). Now
  the `pre` gets `max-height: min(45vh, 360px); overflow: auto`,
  `.tool-create-stream` has `min-height: 0` for flex safety, and typewriter
  auto-scroll refs target the `pre` (not the wrapper). Files: `styles.css`,
  `ToolOutput.tsx`.

- **Removed persisted vertical resize** for the assistant trace card and for
  `create_file` / `write_patch` live stream panels (no drag handle, no
  `localStorage` height). Deleted `usePersistedResizeHeight.ts`; streaming
  blocks use `.tool-create-stream` with a fixed `max-height` and inner scroll.
  Files: `Chat.tsx`, `ToolOutput.tsx`, `styles.css`.

- **Live THOUGHT in trace header scroll panel.** While streaming, full extracted
  THOUGHT (Markdown + caret) renders in `div.trace-thought-scroll` under the
  trace toggle (`max-height` ~38vh cap, scroll inside; auto-scroll to bottom).
  The
  one-line `trace-head-preview` is suppressed during stream; after the turn it
  still shows the truncated line from trace events. Files: `Chat.tsx`,
  `styles.css`. **Patch/create streaming** (`.tool-create-stream`, fixed max
  height + scroll) in ToolOutput:
  `write_patch` and
  `create_file` use `streamingArgPreview` with typewriter + caret;
  `pre.tool-patch-stream` shows live patch text until observation. The useless
  `tool_payload_streaming` trace row is hidden (still emitted by backend, not
  listed in trace). Files: `ToolOutput.tsx`, `Chat.tsx`, `styles.css`.
  **In-flight tool card:** the backend only adds `action` to the trace after the
  ACTION JSON closes, so the UI synthesizes a transient `TraceStep` (with
  `peekStreamingToolArgBody` / `peekStreamingCreatePath`) until the real event
  lands; trace auto-expands once per peek signature. Files: `Chat.tsx`,
  `streamingToolPeek.ts`. **Auto-open tweak:** signature must not include
  `path` (it grows per token and re-fired `setTraceOpen(true)` after user
  collapsed); respect manual collapse until the next streaming run (`turn.id` /
  `isStreaming` edge).

- **Stream-execute: fire tools mid-stream.** The agent loop no longer buffers
  the full LLM response before acting. A new `chatStream` async generator in
  `llm/client.ts` yields token deltas; `runner.ts` accumulates them and calls
  `scanFirstCompleteAction(buf)` after each token. As soon as the ACTION JSON's
  brace depth closes, `executeTool()` is called immediately in a background
  Promise while the LLM finishes generating the rest of the response. For write-
  type tools (`write_patch`, `create_file`) the result is awaited synchronously
  right after streaming ends so `didWrite`/`writeCount` are correct when the
  guardrails run. Other tools' results are awaited just before the observation
  step. Files: `llm/client.ts` (`_sseStream` extracted, `chatStream` added),
  `agent/runner.ts` (iteration loop rewritten).

- **Parallel multi-tool execution.** A single LLM response can now contain
  multiple `ACTION:` blocks; all are dispatched concurrently via `Promise.all`.
  `parser.ts` returns `{ kind: "multi_action", actions: [...] }` when 2+ valid
  action blocks are found. The runner builds the combined OBSERVATION as
  `[tool1]: result\n\n[tool2]: result`. Prompts updated to document the syntax.
  Early-fired promises are reused (not re-executed) in the parallel map.
  Files: `agent/parser.ts` (`extractAllActions`, `multi_action` AgentStep
  variant), `agent/runner.ts`, `llm/prompt.ts`, `llm/prompt-compact.ts`.

### Last session (2026-04-21)

- **Live agent terminal streaming.** Every `run_command` agent tool call now
  streams output in real-time to the Terminals panel:
  - `commandLog.ts`: Added `startAgentCommand()` returning a `PendingCommandHandle`
    with `appendChunk(stream, text)` and `complete(result)`; emits `run_start`
    and `run_chunk` EventEmitter events.
  - `executor.ts`: Uses `startAgentCommand()` + `appendChunk()` for live streaming
    during `run_command`; also dispatches existing `command_chunk` SSE in parallel.
  - `routes.ts`: `/api/agent/commands/stream` SSE now forwards `run_start` and
    `run_chunk` events. `/api/agent/run` SSE gets a 20-second keepalive comment
    to prevent gateway/proxy timeouts.
  - `api.ts`: `streamAgentCommands()` accepts new `onRunStart` and `onRunChunk`
    callbacks for live event subscription.
  - `Terminals.tsx`: New `LiveAgentTab` union member in `TerminalTab`; `liveRuns`
    state tracks in-flight commands; sidebar shows `⚡` live row above finished
    runs with combined count; pane renders new `LiveTerminalView` component (auto-
    scrolling `<pre>` with "running…" indicator) while command is in progress.
    On completion, run migrates from `liveRuns` to `agents`.

- **New agent tools: `create_file` + `glob`.**
  - `tools/file.ts`: Added `globFiles(pattern, maxResults?)` — converts glob
    to regex, walks workspace tree, returns workspace-relative paths.
  - `executor.ts`: Added `create_file` (`{ path, content }`) and `glob`
    (`{ pattern }`) tool dispatch cases.
  - `llm/prompt.ts` + `llm/prompt-compact.ts`: Both now document the new tools
    in the TOOLS section so the agent knows to use them.

- **Increased token limits and iteration defaults.**
  - `llm/prompt-mode.ts`: Raised per-mode token budgets (minimal: 2048,
    economical: 4096, balanced: 8192, detailed/verbose: 16384). Env cap raised
    from 8192 to 131072.
  - `runner.ts`: Default `MAX_ITERATIONS` fallback raised from 20 → 50.
  - `api/settings.ts`: Same default bumped 20 → 50.
  - `runner.ts`: LLM call timeout raised from 3 min → 10 min (600 000 ms).
  - `SettingsModal.tsx`: Fixed `max` attributes on inputs (iterations: 1000,
    tokens: 131072) that were silently capping values at the old browser-enforced
    100 / 8192 limits.

### Last session (2026-04-20)

- **Agent stream: avoid freezing UI + backend.** Backend: defer session SSE
  delivery with `setImmediate`, chunked replay subscribe; frontend: batched
  token updates via `requestAnimationFrame`, `startTransition` for append-to-turn
  updates, yield in `/agent/sessions/.../stream` fetch every N SSE frames. Files:
  `sessionManager.ts`, `Chat.tsx`, `api.ts`.

- **Checkpoint metadata JSON-only.** `.build-agents/checkpoints.json` again (no
  SQLite / WASM / sql.js). File: `app/backend/src/utils/checkpointDb.ts`.

- **Per-project agent rules.** Load `<workspace>/.pig/rules/**/*.md|.mdc` and
  `.cursor/rules/**` into the system prompt (`PROJECT RULES`; cap
  `PROJECT_RULES_MAX_CHARS`). Background sessions run inside
  `runWithWorkspace(session.workspace)` so tools/relevance/checkpoints resolve
  to the correct folder. Files: `app/backend/src/utils/projectRules.ts`,
  `app/backend/src/agent/runner.ts`, `app/backend/src/agent/sessionManager.ts`;
  docs: `docs/agents/conventions.md`, `docs/agents/architecture.md`.

- **Chat: loading while stopping or connecting.** When the user clicks Stop,
  `awaitingStop` shows banners (`Stopping…`), status bar, placeholder, spinner
  title, and a disabled header button until `runTask`/`streamSession` finishes;
  added `Connecting…` for the gap before `startSession` returns (`sessionConnecting`).
  Files: `app/frontend/src/components/Chat.tsx`, `app/frontend/src/styles.css`.

- **UI motion.** `styles.css`: shared easing tokens (`--ease-out-expo`,
  `--transition-ui`), keyframes for dropdown/modal/pop-in, message bubble
  entrances, empty-state title gradient shimmer, floating scroll-to-bottom
  button; hover lift on composer pills / activity bar / circular icon buttons /
  send with glow; pop-in on mode/model menus, `@`/`/` dropdowns, context menu,
  selection popup; backdrop + modal entrance. Honors `prefers-reduced-motion`
  (animations off, transitions shortened).

- **Assistant reply layout (markdown overflow).** `styles.css`: `chat-turn` and
  `.msg-assistant .msg-text` use `min-width: 0` + bounded width + `overflow-x:
  auto` so tables, code, and long tokens don’t stretch the chat panel;
  scoped `.msg-assistant .md` rules for word-wrap and images; streaming thought
  box gets horizontal scroll when needed.

- **Responsive polish for the welcome screen and chat composer.** Updated
  `app/frontend/src/styles.css` so the editor welcome view now collapses its
  quick actions to a single column earlier, lets the workspace badge/path use
  the full available width, and reduces brand/action spacing on smaller
  screens instead of waiting for a phone-sized breakpoint. Also adjusted the
  chat composer footer/header breakpoints so mode/model controls wrap cleanly
  in narrow chat panes, with the model picker stretching to available width
  instead of colliding with the send controls.

- **Product rename: Build Agents → Pig Agents.** Updated visible branding in
  the frontend shell (`App.tsx` titlebar + status bar), welcome screen
  (`EditorWelcome.tsx`), browser title (`app/frontend/index.html`), and
  top-level docs (`README.md`, `AGENTS.md`, this handoff) so the product is
  now consistently presented as **Pig Agents**. Kept internal
  package names, repo folder names, and storage keys such as `build-agents.*`
  unchanged to avoid unnecessary breakage.

- **Frontend visual refresh + operation feedback polish.** Updated
  `app/frontend/src/styles.css` with a broad UI refresh across app shell,
  activity/sidebar, file tree, editor tabs, welcome screen, chat/composer,
  diff viewer, terminal panel, git panel, search/chats, and status bar using
  a consistent token set (colors, radii, shadows, transitions). Also polished
  loading feedback wiring in file operations and git actions (`FileTree.tsx`,
  `GitPanel.tsx`), and fixed a nested-composer visual regression by removing
  the inner framed look from `.composer-lower` so the composer renders as a
  single unified card.
- **Composer model dropdown overflow fix.** Adjusted `.model-menu` in
  `app/frontend/src/styles.css` to anchor from the right edge of the trigger
  pill (`right: 0; left: auto`) and constrained width on normal + smaller
  viewports so the model chooser no longer spills past the chat panel border;
  then tuned anchor/width to open from the model pill's left edge for a less
  "sunk inward" visual position inside narrow chat panes. Final pass anchors
  the model menu to the responsive width of the composer footer-left group
  (not a fixed pixel width), preventing both horizontal spill and awkward
  inward offset in tight chat columns. Added model-name readability polish:
  each model row now exposes full id on hover (`title`) and temporarily lifts
  ellipsis truncation on hover/focus so long model names can be read. Latest
  tweak moves the positioning context to the full composer footer so the menu
  width auto-follows the chat/composer box instead of the trigger cluster.
- **DiffViewer Review opens all changed files.** Updated
  `app/frontend/src/components/DiffViewer.tsx` so the header `Review` action
  iterates over every active diff and opens all changed files as diff tabs,
  rather than only opening the first/next changed file.

- **Smart command execution for long-running processes.** Created
  `app/backend/src/tools/smartCommand.ts` with intelligent detection and
  handling of dev servers (`npm run dev`, `yarn start`, `vite`, `uvicorn`,
  etc.). The system:
  - Auto-detects long-running commands via regex patterns
  - Monitors output for "ready" signals (e.g., "listening on port", "compiled
    successfully", "ready in Xms")
  - Returns immediately when server is ready (or after ~15s timeout for
    background mode)
  - Detects early failures (EADDRINUSE, syntax errors, module not found)
  - Runs processes in detached mode so they continue after agent completes
  - Files: `smartCommand.ts` (new), `executor.ts` (updated import + handler),
    `llm/prompt.ts` (updated tool description)
- **ANSI escape code stripping.** Added `stripAnsi()` helper to both
  `command.ts` and `smartCommand.ts` to remove terminal color codes from
  output. Also set `NO_COLOR=1` and `FORCE_COLOR=0` env vars when spawning
  commands. This prevents garbled Unicode in AGENT RUNS log and chat traces.
- **Modern ToolOutput UI.** Created new
  `ToolOutput.tsx` component that renders agent tool calls in a clean,
  visually appealing format instead of raw JSON/text:
  - Each tool type has custom rendering: icons, colored badges, collapsible
    details
  - `read_file`: file icon + path + collapsible content preview
  - `write_patch`: edit icon + file chips + status + expandable results
  - `run_command`: terminal icon + command + exit status badge + output
  - `search_code`: search icon + query + hit count + collapsible results
  - `list_files`: folder icon + path + item count + expandable file list
  - `codebase_map`: map icon + depth + collapsible tree
  - Action + observation events are now combined into single trace items
  - Added ~200 lines of CSS for the new components
  - Files: `ToolOutput.tsx` (new), `Chat.tsx` (updated TraceStep + imports),
    `styles.css` (ToolOutput styles)
- **`ChevronExpand.tsx` + `PlayTriangle`.** Replaced tiny Unicode ▸/▾ (and ▶
  for shells) with consistent SVG icons: `ChevronExpand` (disclosure: down vs
  right, optional `flipOpen` for dropdown-open state) and `PlayTriangle` for
  terminal sidebar shell rows. Wired in `DiffViewer.tsx`, `Chat.tsx` (trace
  toggle + trace steps + composer pills; Mode menu uses `flipOpen={open}`),
  `FileTree.tsx`, `GitPanel.tsx`, `Terminals.tsx`. Shared CSS in `styles.css`:
  `.chevron-expand`, `.play-triangle`, plus context rules (e.g.
  `.tree-row .chev`, `.trace-toggle-icon`, `.git-section-caret`,
  `.diff-viewer-head .changes-toggle .chev`).
- **`MentionInput` composer textarea.** Empty input showed a bogus inner
  scrollbar (UA `overflow: auto` + auto-grow height rounding). Fix: default
  `overflow-y: hidden` in `.composer-body textarea`, `rows={1}` with
  `min-height` from CSS, and in the auto-grow `useEffect` set
  `overflowY = "auto"` only when height hits the max cap (~220px).
- **Agent “Task completed” with no `ACTION`.** In `runner.ts`, if the model
  emits `FINAL` that looks like a no-op platitude while **no** tool has run yet,
  but `THOUGHT` clearly promised concrete file work (`thoughtPromisesConcreteWork`
  + `looksLikeNoOpFinal`), the runner **re-prompts once** (separate flag from
  the existing “lazy FINAL with fenced code but no `write_patch`” nudge). Also
  added a line in `llm/prompt.ts` forbidding FINAL-only “done” without an
  `ACTION` in the same turn.
- **Composer layout (CSS + DOM).** Structure in `Chat.tsx`: `composer-body` →
  optional `chat-diffs` (DiffViewer) + `composer-lower` (`composer-input` /
  `composer-footer`). The user iterated on **fused** vs **stacked card** styling;
  avoid large unsolicited rewrites of this block — confirm intent before
  replacing margins, `:has(.chat-diffs) .composer`, or border fusion rules.
- **Agent prompt + premature-FINAL cues.** `llm/prompt.ts`: added a compact
  "Reasoning & tool discipline" block (evidence-based THOUGHT, list_files /
  search_code before guessing paths, handle failed OBSERVATION, stay scoped,
  mirror user language in FINAL). `ASK_SYSTEM_PROMPT`: slightly stronger
  structured reasoning for Ask mode. `runner.ts`: extended
  `thoughtPromisesConcreteWork` edit-verb regex with common Vietnamese upgrade
  / optimize / improve phrases so premature-FINAL nudge catches more real
  "promised work, no tools" cases. `docs/agents/agent-loop.md` documents this.
- **Background agent sessions (runs independently of browser).** New feature
  allowing the agent to run in the background even when the user closes the
  browser or refreshes (F5). Files:
  - `app/backend/src/agent/sessionManager.ts` (NEW): In-memory session store
    with event buffering (max 500 events), subscriber management, 5-min TTL
    after completion. Key exports: `startSession`, `getSession`, `listSessions`,
    `getRunningSessions`, `subscribeToSession`, `abortSession`, `deleteSession`.
  - `app/backend/src/api/routes.ts`: Added 7 routes at `/agent/sessions/*`:
    POST (start), GET (list/get), GET `/running`, GET `/:id/stream` (SSE),
    POST `/:id/abort`, DELETE `/:id`.
  - `app/frontend/src/lib/api.ts`: Added `AgentSessionInfo` interface and
    session API methods (`startSession`, `listSessions`, `getSession`,
    `streamSession`, `abortSession`, `deleteSession`).
  - `app/frontend/src/components/Chat.tsx`: Added reconnect logic using
    `sessionStorage` key `build-agents.active-session` to track running
    sessions; on mount, checks for running sessions and reconnects.
  - **Note**: Routes are at `/agent/sessions` (no `/api` prefix in backend);
    the Vite proxy rewrites `/api/*` → `/*` when forwarding to backend.

### Last session (2026-04-19)

- Created agent documentation set: root `AGENTS.md` plus
  `docs/agents/{README, architecture, backend, frontend, agent-loop, api,
  chat-history, conventions, workflows, troubleshooting, session-handoff}.md`.
- Added end-of-session ritual to `AGENTS.md` §6 rule #7 so future agents
  must update this handoff before declaring work done.
- Added always-on Cursor rule `.cursor/rules/session-handoff.mdc` that
  enforces "read AGENTS.md + handoff at session start, update handoff
  before finishing." Files: `AGENTS.md`, `.cursor/rules/session-handoff.mdc`,
  `docs/agents/session-handoff.md`.
- **Per-hunk Keep / Undo.** Backend now emits real multi-hunk unified
  diffs with `@@ -X,Y +A,B @@` line-numbered headers and 3 lines of
  context (was a single `@@\n` whole-file blob). Files:
  `app/backend/src/tools/patch.ts` (`makeUnifiedDiff` rewrite),
  `app/backend/src/api/diff.ts` (multi-hunk-aware `/diff/revert`, new
  `POST /diff/revert-hunk { diff, hunkIndex }`),
  `app/frontend/src/lib/api.ts` (`api.revertHunk`),
  `app/frontend/src/components/Editor.tsx` (`parsePendingDiff` returns
  per-hunk records using the line-numbered headers; renders a Monaco
  content widget with `✓ Keep` / `↶ Undo` anchored above each hunk;
  emits `ba:hunk-action`),
  `app/frontend/src/App.tsx` (listens to `ba:hunk-action`, calls
  `revertHunk` on undo, splices the targeted hunk out of the in-memory
  diff and shifts subsequent `+start` line numbers when the on-disk file
  shrank/grew — see `removeHunkFromDiff`),
  `app/frontend/src/styles.css` (`.ba-hunk-actions` widget styles).
- **Real VSCode file icons.** Initial pass shipped a hand-rolled inline-SVG
  `<FileIcon>` (extension-label band on a file shape) but it looked
  homemade. Replaced with the actual **vscode-icons** SVGs (the same set
  the popular VSCode "vscode-icons" extension ships) via Iconify:
  - Deps: `@iconify/react` + `@iconify-json/vscode-icons` (the full
    collection JSON is `addCollection`-loaded once at module init so icons
    render offline; bundle hit ≈ +150 KB gzipped, fine for a Monaco-heavy
    app — total prod bundle is 1.27 MB gz).
  - `app/frontend/src/components/FileIcon.tsx` exports a single
    `<FileIcon name isDir? expanded? size? className? />` that renders
    `<Icon icon="vscode-icons:..." />`. Three lookup tables resolve the
    icon id:
      - `NAME_MAP` (highest priority) — full lowercased filename → id.
        Covers `package.json`/`-lock.json` → `file-type-npm`,
        `tsconfig.json` → `file-type-tsconfig`, `vite.config.ts` →
        `file-type-vite`, `Dockerfile`/`docker-compose.yml` →
        `file-type-docker`/`docker2`, `.env*` → `file-type-dotenv`,
        `.gitignore`/`.gitattributes` → `file-type-git`,
        `.eslintrc*` → `file-type-eslint`, `Cargo.toml`/`go.mod`/
        `pyproject.toml`/`Gemfile` → their language icon, `AGENTS.md` →
        `file-type-agents`, `LICENSE`/`CHANGELOG.md`/`Makefile`,
        lockfiles for npm/yarn/pnpm/bun, etc.
      - `EXT_MAP` — extension → id. ~80 entries: `.ts/.tsx/.d.ts`,
        `.js/.jsx/.mjs/.cjs`, `.json/.jsonc`, `.yml/.toml/.ini`,
        `.html/.css/.scss/.sass/.less/.vue/.svelte/.astro`, `.py/.rs/
        .go/.rb/.java/.kt/.swift/.c/.cpp/.h/.cs/.php/.lua/.r/.scala/
        .ex/.erl/.hs/.zig/.dart/.ada`, shells (`.sh`/`.ps1`/`.bat`),
        `.sql/.graphql/.proto`, images/video/audio/fonts/archives, etc.
      - Fallback heuristics: `.d.ts` → `typescriptdef`,
        `.tsbuildinfo` → `tsconfig`, `tsconfig.*.json`/`jest.config.*`/
        `babel.config.*`/`.babelrc`/`vitest.config.*` → matching tool icon.
        Anything else → `default-file`.
  - Folders: `FOLDER_MAP` resolves to the matching `folder-type-*` (each
    has a `-opened` variant) — `src`, `app/apps`, `components`, `lib/libs`,
    `utils/helpers`, `hooks`, `views/pages`, `routes`, `models`,
    `controllers`, `services`, `interfaces`, `types`, `plugins`, `themes`,
    `public/static`, `assets/images`, `fonts`, `css/styles`, `test/tests/
    __tests__/spec/specs/e2e`, `docs`, `config`, `api`,
    `server/backend`, `client/frontend/ui/web`, `dist/build/out`,
    `node_modules`, `.git`, `.github`, `.gitlab`, `.vscode`, `.cursor`,
    `.claude`, `locale/locales/i18n`, `middleware`, `redux`, `graphql`,
    `db/database`, `log/logs`, `temp/tmp`. Unknown folders fall back to
    `default-folder` / `default-folder-opened`.
  - Wired into the same call-sites as the v1 component: `FileTree.tsx`
    (tree rows + new-file row), `DiffViewer.tsx` (diff list),
    `App.tsx` (editor tabs), `Chat.tsx` (mention chips + expanded list),
    `MentionInput.tsx` (`@`-mention dropdown), `FolderPicker.tsx`
    (folder/file rows). CSS sizing in `styles.css` (`.file-icon-svg`,
    `.tree-row .icon`, `.diff-row .file-icon`, `.tab-icon`,
    `.msg-chip .chip-icon`) was already in place from v1.
  - Adding mappings: edit `EXT_MAP` / `NAME_MAP` / `FOLDER_MAP` and use a
    valid `vscode-icons:` id. To check what id exists, run
    `node -e "console.log(Object.keys(require('@iconify-json/vscode-icons/icons.json').icons).filter(x => x.includes('SEARCH')))"`
    from `app/frontend/`.
- **Editor welcome screen.** The empty editor used to render a one-line
  "Open a file from the Explorer or Search to edit it." placeholder which
  the user (rightly) called "phèn". Replaced with a proper IDE-style welcome page:
  - `app/frontend/src/components/EditorWelcome.tsx` (new) — renders the
    brand mark (inline SVG gradient "B" + pulse line, no asset file),
    "Pig Agents" + tagline, a workspace pill (folder icon + name + full
    path with ellipsis), a 2x2 grid of quick-action cards (`Open/Change
    folder`, `Search files` w/ `⌘P` kbd, `Ask the agent`, `Toggle
    terminal` w/ <code>⌘`</code> kbd), a "Recent files" section with
    per-row remove (`✕`) + relative dir display, and a footer strip of
    keyboard hints. Auto-detects mac vs other for `⌘` vs `Ctrl`. The
    `<Kbd>` helper is just a styled `<kbd>` element — see `.ew-kbd` in
    `styles.css` for the look (real keycap with bottom-border lift).
  - `app/frontend/src/lib/recents.ts` (new) — tiny
    `pushRecent(workspace, path)` / `listRecents(workspace)` /
    `removeRecent(workspace, path)` keyed by
    `build-agents.recent-files.v1.<workspace>` in localStorage, capped at
    12 entries, sorted by most-recent first. Recents are per-workspace so
    switching folders gives a clean slate.
  - `app/frontend/src/App.tsx` — `openFile()` now calls `pushRecent` and
    bumps a `recentsVersion` counter that the welcome reads as a hint to
    refresh from storage. Wired callbacks: `onOpenFolder` →
    `setPickerOpen(true)`, `onShowSearch` → `setView("search")`,
    `onShowChats` → `setView("chats")`, `onToggleTerminal` →
    `toggleBottom()` (existing helper that
    `expand()`/`collapse()`s the bottom panel).
  - `app/frontend/src/styles.css` — new `.editor-welcome` block (subtle
    radial-gradient blue/purple wash on `var(--bg)`, capped 720px column,
    semantic sub-classes `.ew-*` for header/brand/section/actions/recents/
    kbd/footer). Responsive collapse to single column under 560px.
  - To extend: add more `actions` entries in `EditorWelcome.tsx` (each is
    `{ id, icon, title, desc, shortcut?, onClick }`); to surface a new
    keyboard hint, append a `<span className="ew-tip">` in the footer.
    To wipe recents during dev, run
    `Object.keys(localStorage).filter(k => k.startsWith('build-agents.recent-files.')).forEach(k => localStorage.removeItem(k))`
    in the browser console.
- **Source Control (Git) panel.** Fourth activity-bar entry between Search
  and Chats, opened by a `git-branch` SVG icon with a small change-count
  badge. UI mirrors the VSCode "Source Control" view (see screenshot the
  user shared). Built end-to-end:
  - **Backend** — `app/backend/src/api/git.ts` (new), mounted in
    `server.ts` as `gitRouter`. All commands shell out to `git` with
    `cwd: getWorkspace()`, `LC_ALL=C`, and `GIT_TERMINAL_PROMPT=0`. 1 MiB
    stdout/stderr cap. Endpoints:
    - `GET /git/status` — `git status --porcelain=v1 -z --branch
      --untracked-files=all`. Parses the `-z` NUL-separated stream
      including the leading `## branch...upstream [ahead N, behind M]`
      header and rename/copy second-token paths. Returns
      `{ ok, workspace, branch, upstream, ahead, behind, detached, files:
      GitFileEntry[] }`. Reports `{ ok: false, reason: "not_a_repo" }`
      when the workspace has no `.git` so the UI can offer init.
    - `GET /git/diff?path=&staged=0|1&untracked=0|1` — `git diff
      [--cached] -- <path>`, or `git diff --no-index -- /dev/null <path>`
      for untracked. Returns the unified diff as `diff:` plus echoed
      flags.
    - `POST /git/stage` / `POST /git/unstage` / `POST /git/discard` —
      take `{ paths: string[] }`. Unstage prefers `git restore --staged`
      and falls back to `git reset HEAD --` (covers the initial-commit
      case). Discard runs `git checkout -- <paths>` and is the only
      destructive call (UI confirms first).
    - `POST /git/commit` — `{ message, stageAll?, signoff? }`. When
      `stageAll`, runs `git add -A` first.
    - `GET /git/log?limit=N` — `git log --pretty=format:` with NUL
      record separator and `\x1f` field separator (`%H %h %P %an %ae
      %aI %at %s`). `format:` emits an extra `\n` between records, so
      we strip leading whitespace per record before splitting fields.
      Returns `{ ok, entries: GitLogEntry[] }`.
    - `POST /git/init` — `git init` (only when not already a repo).
    - `GET /git/version` — `git --version`, used as a tiny health probe.
  - **Frontend client** — `app/frontend/src/lib/api.ts` gains
    `api.gitStatus / gitDiff / gitStage / gitUnstage / gitDiscard /
    gitCommit / gitLog / gitInit` plus `GitFileEntry`, `GitStatus`, and
    `GitLogEntry` types.
  - **GitPanel component** — `app/frontend/src/components/GitPanel.tsx`
    (new). Polls `gitStatus + gitLog` on mount and every 8 s while
    visible. Renders:
    - Header `SOURCE CONTROL` with total-change badge and `＋` (stage
      all unstaged + untracked) / `↻` (refresh) buttons.
    - Multiline commit textarea (placeholder `Message (Ctrl+Enter to
      commit on "<branch>")`) + a big `✓ Commit` button. When nothing
      is staged but there are unstaged changes, the button auto-flips
      to `✓ Commit All` and runs `git add -A` before commit.
      `⌘/Ctrl+Enter` submits.
    - Branch row: `git-branch` SVG glyph + branch name + upstream name
      + `↓N ↑N` ahead/behind counters.
    - Three collapsible file sections — `Staged Changes`, `Changes`,
      `Untracked`. Each row shows `FileIcon` + filename + dir +
      one-letter status badge in VSCode colors (`M` orange, `A`/`U`
      green, `D` red, `R`/`C` green-blue). Hover swaps the badge for
      per-row action icons (`↶` discard / `＋` stage for unstaged;
      `−` unstage for staged; `＋` only for untracked). Section
      headers expose bulk versions of the same actions on hover.
    - `GRAPH` (commit history): vertical line + colored dot per commit
      (HEAD dot is filled with a halo), subject + abbreviated hash +
      author + relative time. Caps at 8 with a "Show N more" toggle.
    - Empty workspace → `"No folder opened"`. Not-a-repo → big
      `Initialize Repository` button calling `api.gitInit()`.
  - **App.tsx wiring** — `ActivityView` now includes `"source"`. New
    `gitChangeCount` state polled every 10 s independently of the panel
    so the activity-bar badge stays roughly in sync. New helper
    `openGitDiff({ path, staged, untracked, diff })` that synthesises a
    `DiffItem` (id `git:idx:<path>` / `git:wt:<path>`) and reuses the
    existing `openDiff()` plumbing — so git diffs open as `DIFF`
    tabs in the same Monaco-backed `DiffEditorView` as agent diffs.
    Untracked files just open the file directly (no original to diff
    against and `--- /dev/null` headers don't parse). Empty diffs
    (binary/mode-only) likewise fall back to plain `openFile`.
  - **Activity-bar button** — `<button class="activity-source">` with
    inline `git-branch` SVG and absolute-positioned `.activity-badge`
    (bumps to `99+` over 99). Styled in `styles.css` next to the rest
    of the activity bar.
  - **Styles** — large `git-*` block at the bottom of `styles.css`
    (commit textarea, branch row, sections, file rows w/ hover-swapped
    badge↔actions, log graph dots/lines, primary commit button gradient,
    error toast). Uses existing CSS vars (`--bg-2`, `--bg-3`, `--border`,
    `--fg-dim`).
  - **Caveats / future work**:
    - Working-tree diff vs staged diff for the *same* file with both
      staged and unstaged hunks: `DiffEditorView` reads the current file
      and back-applies the diff, so it shows the staged version against
      HEAD perfectly when the file has no further unstaged edits, but
      may misalign if you have both. For MVP we accept this; a proper
      fix would either pipe `git show :<path>` for the index blob or
      teach `DiffEditorView` to render an explicit "old/new" pair
      instead of computing one from the other.
    - No branch switcher / fetch / pull / push UI yet — the panel is
      read+commit only. Adding a branch dropdown next to the branch
      row, plus `gh`-style action buttons, would slot cleanly into the
      existing layout.
    - No conflict resolution UI for merge conflicts (status will show
      `UU`/`AA`/etc. but we don't help resolve them).
- No open bugs reported by the user.
- **Image paste (Ctrl+V) and attachment in chat composer.** Users can now
  paste images directly into the chat composer or use a file picker to
  attach images. Images are included in the LLM request as base64 data URLs.
  Files changed:
  - `app/frontend/src/components/Chat.tsx`: Added `attachedImages` state,
    `imageInputRef` for hidden file input, `addImageFromFile` (reads via
    FileReader with 10MB limit), `handlePaste` (checks clipboard for
    images), `handleImageInput` (handles file picker), `removeImage`.
    Images are captured before send, included in the turn for display,
    and cleared after sending. Added image preview section in composer
    with thumbnails and remove buttons. Added image picker button in
    footer with SVG icon.
  - `app/frontend/src/lib/sessions.ts`: Added `ChatImage` interface and
    `images?: ChatImage[]` field to `ChatTurn` type.
  - `app/frontend/src/lib/api.ts`: Updated `startSession` to accept
    optional `images` parameter.
  - `app/backend/src/api/routes.ts`: Updated `POST /agent/sessions` to
    extract and validate images array from request body.
  - `app/backend/src/agent/sessionManager.ts`: Added `images` field to
    `AgentSession` interface and updated `startSession` signature.
  - `app/backend/src/agent/runner.ts`: Added `images` to `AgentRunOptions`,
    imported `ContentPart` type, created `buildUserContent` helper that
    converts text + images into multimodal content array. Images are only
    included in the first iteration of agent mode.
  - `app/backend/src/llm/client.ts`: Added `TextContentPart`,
    `ImageContentPart`, `ContentPart` types. Updated `ChatMessage.content`
    to accept `string | ContentPart[]` for multimodal messages.
  - `app/frontend/src/styles.css`: Added `.composer-images`,
    `.composer-image-preview`, `.composer-image-remove`,
    `.composer-icon-btn.image-picker` styles for the composer, and
    `.msg-images` styles for displaying images in sent messages.
