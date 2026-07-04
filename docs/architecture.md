# Architecture — Pig Agents Desktop

## Processes

```text
┌─────────────────────────────────────────────────────────────┐
│  Electron Main                                               │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │ IPC registry│  │ @pig-agents/ │  │ BrowserView manager │ │
│  │             │──│ core services│  │ (no Playwright)     │ │
│  └──────▲──────┘  └──────┬───────┘  └─────────────────────┘ │
│         │                 │                                  │
│         │                 ▼                                  │
│         │            Workspace FS (sandboxed)                │
└─────────┼────────────────────────────────────────────────────┘
          │ contextBridge (preload)
┌─────────┴────────────────────────────────────────────────────┐
│  Renderer (React + Vite → file:// or dev server URL)          │
│  IDE layout · Monaco · xterm · Chat · no fetch() to localhost │
└──────────────────────────────────────────────────────────────┘
```

## IPC bridge (`window.pig`)

The renderer never uses `fetch`/`WebSocket`. The preload exposes a single
`window.pig` object; the web app's old REST/SSE/WS client (`lib/api.ts`) was
rewritten to call it:

| Bridge method | Main handler | Purpose |
|---------------|--------------|---------|
| `rpc(method, args)` | `pig:rpc` → `core.services[method]` | Request/response (files, git, settings, chats, checkpoints, policy, sessions, diff revert) |
| `streamOpen(kind, params, onMessage)` | `pig:stream:open` / `:close` | Long-lived callback streams: `agentRun`, `session`, `commandLog`, `fsWatch` (replaces SSE + the fs-watch WebSocket) |
| `terminalCreate(...)` | `pig:terminal:*` | PTY I/O over IPC via `core.createPty` (replaces the terminal WebSocket) |
| `pickFolder()` | `pig:workspace:pickFolder` | Native `dialog.showOpenDialog` |
| `browserSetVisible`, `browserSetBounds`, `browserSetOverlaySuppressed`, `browserSetTabActive`, `browserNavigate`, … | `pig:browser:*` | Embedded page via **`WebContentsView`** on `win.contentView` (replaces deprecated `BrowserView`). Main measures `.browser-viewport` via `executeJavaScript`; renderer `setBounds` is a layout nudge only. Hidden with `setVisible(false)` when tab inactive or modal open. |
| `browserToggleDevTools`, `browserDevToolsOpen` | `pig:browser:toggleDevTools` / `devToolsOpen` | Chrome DevTools for the embedded page, opened detached; auto-closed on `browserStop`/detach. |
| `onBrowserState`, `onBrowserLayout`, `onBrowserInspectPick` | `pig:browser:state` / `layout` / `inspectPick` (main → renderer) | Navigation state, relayout after zoom/resize, element pick for chat |

`@pig-agents/core` contains the former backend as **pure functions** (`services.ts`)
plus callback-based streaming primitives (`runAgent`, `subscribeToSession`,
`subscribeAgentCommands`, `workspaceWatcher`). There is **no** Express, `ws`, or
Playwright anywhere in the product path.

## LLM providers

`app/core/src/llm/client.ts` exposes `chat()` / `chatStream()` behind a provider
abstraction selected by `LLM_PROVIDER`:

- **OpenAI-compatible** (default) — ChatGPT, Gemini, OpenRouter, Claude API,
  DeepSeek, Groq, Mistral, … over `/v1/chat/completions`.
- **Cursor** — Cloud Agents API (`cursorClient.ts`).
- **Ollama** — native `/api/chat`.
- **Claude Code (SDK)** — `claudeAgentClient.ts` drives Claude Code headlessly
  through `@anthropic-ai/claude-agent-sdk` `query()` (its own tools disabled,
  single turn, Pig Agents' system prompt → a plain text generator). Auth is an
  Anthropic API key if configured, else the machine's `claude login`
  subscription. The model list is fetched live via the SDK's `supportedModels()`
  (labels like *Sonnet 4.6*); images are forwarded as base64 content blocks.

Provider metadata lives in `llm/integrations.ts`, per-provider profiles in
`llm/profiles.ts`; the Settings modal builds the provider dropdown + model
picker from those.

## Renderer modules (selected)

| Module | Purpose |
|--------|---------|
| `components/EditorMedia.tsx` | In-editor **image viewer** + **Markdown Preview ⇆ Source** toggle; routes by extension in the editor pane (else Monaco). |
| `lib/formatProvider.ts` | Registers Prettier (offline `prettier/standalone`) as Monaco's Format Document provider. |
| `components/Chat.tsx` (`UserMessageEditor`) | Cursor-style inline message edit — a real composer instance (`ComposerEditable` + `ComposerHeader`) with add/remove/paste images; submit re-runs after reverting to the turn's checkpoint. |
| `utils/watcher.ts` (core) | Recursive FS watcher (Windows/macOS native recursive) so the Explorer updates in real time. |

## Data stores

| Location | Content |
|----------|---------|
| userData `.env` + electron-store `llm-profiles` | LLM settings (via in-app Settings) |
| `electron-store` | Panel sizes, last window bounds |
| `~/.pig-agents/` | Chat history, policies (same product name as web; new implementation) |

## Platform abstraction

`app/electron/src/platform.ts` exports:

- `defaultShell()` — PowerShell on Windows, `$SHELL` elsewhere
- `isWindows()`, `isMac()`, `isLinux()`
- path helpers wrapping `node:path`

## Phases (implementation)

1. **Done** — rules, IPC shell, health ping, open-folder dialog
2. **Done** — full web frontend copied into `app/renderer`; backend ported into
   `@pig-agents/core` as native IPC services (files, git, chats, settings,
   checkpoints, policy, agent runs/sessions, command log)
3. **Done** — Terminal via `node-pty` (optional) + IPC; fs-watch over IPC
4. **Done** — BrowserView (`app/electron/src/browser/`) + renderer Browser tab;
   `browserSession` delegates to the registered driver (no Playwright)
5. **Next** — `electron-builder` Windows NSIS, then Linux/macOS
