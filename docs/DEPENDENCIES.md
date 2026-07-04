# Dependency allowlist

Only packages listed here may be added to `package.json`. To add a new one:

1. Complete the checklist in [`SECURITY.md`](SECURITY.md).
2. Add a row below with version, scope, and rationale.
3. Use **exact** or caret-minimal versions; run `npm install` and commit lockfile.

## Root / tooling

| Package | Version policy | Maintainer / notes |
|---------|----------------|-------------------|
| `typescript` | `5.7.2` | Microsoft — compiler only |
| `@types/node` | `22.10.5` | DefinitelyTyped |
| `electron` | `34.0.2` in app/electron | OpenJS / Electron Foundation |
| `electron-builder` | `25.1.8` dev only | electron-userland |

## Workspace (internal)

| Package | Notes |
|---------|--------|
| `@pig-agents/core` | Monorepo workspace — not from npm registry |

## app/core

| Package | Notes |
|---------|--------|
| `dotenv` | Load config in main only; no network |
| `@anthropic-ai/claude-agent-sdk` | `0.3.x` — Anthropic. Powers the **Claude Code (SDK)** LLM provider: drives Claude Code headlessly via `query()` (auth via API key or local `claude login`). Spawns the bundled Claude Code CLI; loaded lazily (dynamic import) so it never affects startup or other providers. |

*(Agent/LLM deps will be added here as features land — each row required.)*

## app/electron

| Package | Notes |
|---------|--------|
| `electron` | Desktop shell |
| `electron-store` | UI prefs; maintainer sindresorhus — widely audited (10.0.0) |
| `node-pty` | `1.1.0` — Microsoft; ConPTY PTY. After `npm install` on Windows run `npm run rebuild:native` (needs VS 2022 Build Tools + C++ workload) |

## app/renderer

| Package | Notes |
|---------|--------|
| `react`, `react-dom` | Meta — UI |
| `vite`, `@vitejs/plugin-react` | Vite team — build only for renderer |
| `@monaco-editor/react`, `monaco-editor` | Microsoft — editor widget |
| `@xterm/xterm`, `@xterm/addon-fit` | xtermjs — terminal display |
| `antd` | Ant Design — UI component library (modals, inputs) |
| `react-resizable-panels` | bvaughn — split-pane layout |
| `react-virtuoso` | virtualized chat/file lists |
| `react-markdown`, `remark-gfm` | render agent markdown output |
| `prism-react-renderer` | syntax highlighting in markdown code blocks |
| `@iconify/react`, `@iconify-json/vscode-icons` | file-type icons in the tree |
| `prettier` | `3.3.3` (exact) — offline "Format Document" (Shift+Alt+F) for JS/TS/JSON/HTML/CSS/SCSS/LESS/Markdown/YAML. `prettier/standalone` + plugins run in the renderer (no network, no native tool); loaded lazily on first format. |
| `state-local` | transitive of `@monaco-editor/react` |

> All renderer packages run inside the sandboxed Electron renderer
> (`contextIsolation: true`, `nodeIntegration: false`) and reach the main
> process only through the `window.pig` IPC bridge — never the network.

## Explicitly banned (desktop product)

| Package | Reason |
|---------|--------|
| `express`, `cors` | No HTTP server in desktop app |
| `ws` | Use IPC, not WebSocket to self |
| `playwright`, `puppeteer` | Use Electron BrowserView |
| `concurrently` | **Not used** — dev spawns via `app/electron/scripts/dev.mjs` |

## Last reviewed

2026-05-31 — initial desktop scaffold.
2026-05-31 — ported web backend into `@pig-agents/core` as native IPC
services (no Express/ws/Playwright bridge); added renderer UI packages for the
copied web frontend. `npm audit` reports advisories only in build-time deps
(esbuild/vite chain); no runtime/product-path package is affected.

2026-06-26 — added `@anthropic-ai/claude-agent-sdk` (app/core) for the Claude
Code (SDK) provider and `prettier@3.3.3` (app/renderer) for offline code
formatting. Both run only on the product path (no extra network); the Agent SDK
spawns the local Claude Code CLI on demand.
