# AGENTS.md — Pig Agents Desktop

Read this first. This is a **greenfield Electron app**, not a fork of `pig-agents-web/`.

**Planning:** [`PLAN.md`](PLAN.md) defines phases, exit criteria, and timeline — follow it before starting non-trivial work.

---

## 1. Non-negotiable principles

1. **No web stack in the product path**
   - Forbidden in runtime: `express`, `cors`, `ws` as a public API server, Vite `server.proxy`, Playwright, headless Chromium for the IDE browser panel.
   - Communication: `ipcMain` / `ipcRenderer` via `contextBridge` only (`preload.ts`).
   - Renderer: `nodeIntegration: false`, `contextIsolation: true`.

2. **Desktop-first performance**
   - Agent, FS, PTY, and LLM calls run in the **main process** (or worker threads spawned from main).
   - Avoid HTTP round-trips between UI and logic.
   - Prefer native dialogs (`dialog.showOpenDialog`), `electron-store` for UI prefs, and embedded `BrowserView` over streaming JPEG screencasts.

3. **Platform order**
   - Implement and verify on **Windows** first.
   - Keep code portable: use `app/electron/platform.ts` for shell paths, separators, and shortcuts — no Win-only APIs in `app/core/`.

4. **Do not modify `pig-agents-web/`**
   - Never copy-paste files from the web repo into `app/`.
   - You may read it for behavior reference only; all code here is written fresh.

5. **Dependency security**
   - Before adding any npm package: follow [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md).
   - Pin versions; commit `package-lock.json`; run `npm audit` after install.

6. **Workspace safety**
   - All file paths go through `core` sandbox helpers (`safeJoin`).
   - Default: no folder until user picks one (native dialog).

7. **User language**
   - Chat summaries for the user: Vietnamese when they write Vietnamese.
   - Code, identifiers, and repo docs: English.

---

## 2. Repo map

```text
.
├── AGENTS.md
├── README.md
├── docs/
│   ├── SECURITY.md
│   ├── DEPENDENCIES.md
│   └── architecture.md
├── .cursor/rules/          ← Cursor agent rules (mandatory)
├── app/
│   ├── core/               ← @pig-agents/core
│   ├── electron/           ← main + preload + ipc
│   └── renderer/           ← React + Vite (Electron renderer only)
└── pig-agents-web/         ← reference only; do not edit for desktop work
```

---

## 3. IPC contract

- Channel names: `pig:<domain>:<action>` (e.g. `pig:workspace:get`).
- Errors: throw `DesktopError` with `{ code, message }`; preload maps to rejected promises.
- Streaming agent events: `webContents.send('pig:agent:event', payload)` — not SSE.

---

## 4. Browser (agent tools)

- Use `BrowserView` attached to the main window.
- Agent tools (`browser_navigate`, `browser_click`, …) call `electron/browser/controller.ts`.
- Do not add Playwright or puppeteer.

---

## 5. Verification

- No unit test suite yet; smoke-test on Windows after user-facing changes.
- Run `npm run build` before packaging.
- Update `docs/architecture.md` when IPC or data stores change.

---

## 6. Session handoff

For non-trivial changes, append a bullet to `docs/session-handoff.md` (create if missing) with date and summary.
