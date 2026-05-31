# Pig Agents Desktop — Master Plan

> **Status:** Active · **Last updated:** 2026-05-31  
> **Owner:** DEV BETA (desktop track)  
> **Reference only (do not import code):** `pig-agents-web/`

This document is the **single source of truth** for scope, phases, and gates. Implementation must follow `PLAN.md` → `AGENTS.md` → `.cursor/rules/` → `docs/DEPENDENCIES.md`.

---

## 1. Executive summary

Build a **native desktop IDE + AI agent** using **Electron**, targeting **Windows first**, then **Linux** and **macOS**. The product must be **faster and more stable** than the web stack by eliminating HTTP round-trips, Playwright, and a separate backend process.

| Goal | Approach |
|------|----------|
| Performance | Main process runs agent, FS, PTY, LLM; UI talks via **IPC only** |
| Stability | One app process model; no dev proxy; pinned dependencies |
| Security | Allowlisted npm packages; `preinstall` banned-dep check; secrets in main only |
| Greenfield | **Rewrite** features in `app/` — **never** copy/patch `pig-agents-web/` |

---

## 2. Non-goals (out of scope)

- Running Express / `localhost:8787` / Vite API proxy in the desktop product
- Playwright, Puppeteer, or JPEG screencast “remote browser” (Steam-style)
- Symlinking or importing source from `pig-agents-web/`
- Shipping a browser-tab version of this repo
- Auto-update (`electron-updater`) until post-MVP (Phase 6)
- macOS notarization until post-MVP Windows + Linux installers work

---

## 3. Principles (mandatory)

1. **Desktop-native path** — `contextBridge` + `ipcMain`; renderer has `nodeIntegration: false`.
2. **Windows-first verification** — every phase gate includes Win 10/11 x64 smoke test.
3. **Portable core** — OS-specific code only in `app/electron/src/platform.ts` and electron adapters.
4. **Dependency discipline** — see `docs/SECURITY.md`; new packages require `docs/DEPENDENCIES.md` row + review.
5. **Workspace safety** — all FS via `@pig-agents/core` `safeJoin`; user picks folder via native dialog; no auto-open on first launch.
6. **User-facing chat** — Vietnamese summaries when the user writes Vietnamese; code/docs in English.

---

## 4. Target architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│ Electron Main                                                     │
│  ipc/register.ts ──► @pig-agents/core (agent, tools, llm, fs)    │
│  terminal/pty.ts   node-pty (optional, rebuilt per Electron)     │
│  browser/controller.ts   BrowserView (embedded, not Playwright)  │
│  env.ts, electron-store (prefs)                                   │
└────────────────────────────▲─────────────────────────────────────┘
                             │ preload: window.pigAgents
┌────────────────────────────┴─────────────────────────────────────┐
│ Renderer (React + Vite)                                           │
│  IDE layout · Monaco · xterm · Chat · desktopApi.ts (no fetch API)│
└──────────────────────────────────────────────────────────────────┘
```

### Data locations

| Store | Path | Notes |
|-------|------|-------|
| User env | `%APPDATA%/pig-agents-desktop/.env` (Win) | LLM keys; main only |
| UI prefs | `electron-store` | Panel sizes, window bounds |
| Chat history | `~/.pig-agents/chats/<wsHash>/` | New implementation; same product folder name |
| Project rules | `<workspace>/.pig/rules/**/*.md` | Loaded into agent prompt |

### IPC naming

- Pattern: `pig:<domain>:<action>` (e.g. `pig:fs:readFile`)
- Errors: `DesktopError` → `{ code, message }` to renderer
- Agent stream: `webContents.send('pig:agent:event', payload)` — **not** SSE/EventSource

---

## 5. Platform rollout order

| Order | OS | Packaging | Gate |
|-------|-----|-------------|------|
| **P0** | Windows 10/11 x64 | NSIS (`.exe`) | Daily dev + installer smoke |
| **P1** | Linux (Ubuntu 22.04/24.04) | AppImage or `.deb` | PTY + open folder + agent run |
| **P2** | macOS 13+ Intel/ARM | `.dmg` | PTY + custom titlebar; notarize later |

---

## 6. Phase plan

Each phase has **deliverables**, **exit criteria**, and **dependencies**. Do not start the next phase until exit criteria pass on **Windows**.

---

### Phase 0 — Foundation ✅ (done)

**Deliverables**

- [x] Repo layout: `app/core`, `app/electron`, `app/renderer`
- [x] `PLAN.md`, `AGENTS.md`, `docs/SECURITY.md`, `docs/DEPENDENCIES.md`
- [x] `.cursor/rules/*` (desktop, deps, IPC, core)
- [x] `scripts/verify-deps.mjs` + `preinstall` hook
- [x] Electron window + preload + IPC health + native **Open folder**
- [x] `npm run build` green on Windows

**Exit criteria**

- App launches; IPC ping returns platform + Electron version
- No banned packages in any `package.json`

---

### Phase 1 — Workspace & filesystem (IPC)

**Deliverables**

- [ ] `core`: `listFiles`, `readFile`, `writeFile`, `createEntry`, `deleteEntry`, `rename`, `searchCode`
- [ ] `core`: `fsWatcher` debounced events (main process)
- [ ] IPC: `pig:fs:*`, `pig:workspace:*` (complete CRUD)
- [ ] Renderer: minimal **FileTree** + open file in editor placeholder
- [ ] `desktopApi.ts` expanded; types synced with `electron/src/shared/ipc-types.ts`

**Exit criteria (Windows)**

- Pick folder → list tree → read/write file → see watcher refresh
- Path escape attempts throw `PATH_ESCAPE` (test `../outside`)

**Estimate:** 4–6 dev days

---

### Phase 2 — Editor shell (Monaco)

**Deliverables**

- [ ] Add Monaco to allowlist (`DEPENDENCIES.md`) after security check
- [ ] Tabs, dirty state, Ctrl+S → `pig:fs:writeFile`
- [ ] Language detection by extension
- [ ] VS Code–like layout skeleton (activity bar, sidebar, editor area, status bar)

**Exit criteria**

- Edit and save multiple files; restart app preserves nothing critical yet (prefs optional)

**Estimate:** 4–5 dev days · **Depends on:** Phase 1

---

### Phase 3 — Settings & LLM client

**Deliverables**

- [ ] `core/llm`: OpenAI-compatible client (new code)
- [ ] IPC: `pig:settings:get|save`; mask API keys in renderer
- [ ] Settings modal (provider, model, base URL, iterations)
- [x] Load `.env` from userData (Settings → `PIG_ENV_FILE`)

**Exit criteria**

- Save settings → restart → values persist; test call to local Ollama or OpenAI

**Estimate:** 3–4 dev days

---

### Phase 4 — Agent loop (Ask / Agent modes)

**Deliverables**

- [ ] `core/agent`: ReAct parser, runner, executor (new implementation)
- [ ] Tools v1: `read_file`, `list_files`, `search_code`, `write_patch`, `run_command`
- [ ] Approval policy + `policy_ask` modal in renderer
- [ ] IPC: `pig:agent:run` streaming events; `pig:agent:approve`
- [ ] Chat panel: stream thoughts/actions/observations/final
- [ ] Project rules from `.pig/rules`

**Exit criteria**

- Agent mode patches a file in workspace; Ask mode answers without writes
- Command approval works; deny/allow_once/allow_always

**Estimate:** 8–12 dev days · **Depends on:** Phase 1–3

---

### Phase 5 — Terminal (PTY)

**Deliverables**

- [ ] `node-pty` optionalDependency + `electron-rebuild` documented for Windows
- [ ] `platform.defaultShell()` → PowerShell on Win
- [ ] IPC: `pig:terminal:create|write|resize|kill` + events
- [ ] Renderer: xterm.js panel (allowlist xterm packages first)
- [ ] Agent runs sidebar (live output via IPC, not SSE)

**Exit criteria**

- Interactive PowerShell on Windows; UTF-8 output sane for Vietnamese paths

**Estimate:** 4–6 dev days · **Depends on:** Phase 1

---

### Phase 6 — Browser (BrowserView, no Playwright)

**Deliverables**

- [ ] `browser/controller.ts`: attach/detach, `setBounds`, navigate, back/forward
- [ ] Renderer: URL bar + panel slot (no `<img>` screencast)
- [ ] Agent tools: `browser_navigate`, `browser_click`, `browser_fill`, `browser_get_text`, …
- [ ] Implement via `webContents` + CDP/`executeJavaScript` as needed
- [ ] Remove any stub referencing Playwright

**Exit criteria**

- User and agent can navigate a real URL in-panel; agent reads page text

**Estimate:** 5–7 dev days · **Depends on:** Phase 4

---

### Phase 7 — Diff, checkpoints, git panel

**Deliverables**

- [ ] Patch engine (SEARCH/REPLACE) in `core`
- [ ] Diff viewer + Keep/Undo in editor
- [ ] Checkpoints + optional git status panel (IPC `pig:git:*`)

**Exit criteria**

- Agent patch reviewable; revert last patch works

**Estimate:** 6–8 dev days · **Depends on:** Phase 2, 4

---

### Phase 8 — Packaging & cross-platform

**Deliverables**

- [ ] `electron-builder`: NSIS Win x64 (primary)
- [ ] Linux AppImage smoke on Ubuntu CI
- [ ] macOS dmg smoke (unsigned OK for internal)
- [ ] `npm run package:win` documented in README

**Exit criteria**

- Clean machine install Win `.exe` → open folder → run agent

**Estimate:** 3–5 dev days · **Depends on:** Phase 4+

---

## 7. Timeline (indicative)

| Milestone | Phases | Calendar (1 dev, familiar with agents) |
|-----------|--------|----------------------------------------|
| **MVP Win** | 0–4 + partial 5 | ~4–5 weeks |
| **IDE parity** | 5–7 | +3–4 weeks |
| **Ship installers** | 8 | +1 week |
| **Linux/mac parity** | 8 + platform fixes | +1–2 weeks |

---

## 8. Dependency policy (summary)

- Full checklist: `docs/SECURITY.md`
- Allowlist: `docs/DEPENDENCIES.md`
- Automated: `npm run verify:deps` (also runs on `preinstall`)
- **Banned in product:** `express`, `cors`, `ws`, `playwright`, `puppeteer`

Before every new package:

1. Verify npm package name and maintainer
2. Search “package-name malware” / “compromised” (recent week)
3. `npm view <pkg> scripts` — inspect install hooks
4. Add row to `DEPENDENCIES.md` with pinned version
5. `npm install` → commit lockfile → `npm audit`

---

## 9. Open decisions (need product owner input)

| # | Question | Default if no answer |
|---|----------|----------------------|
| D1 | Single window per workspace or multi-window? | **Single window**, one workspace |
| D2 | Keep `pig-agents-web` in same monorepo folder? | **Yes**, reference only, no imports |
| D3 | Chat history path `~/.pig-agents/` shared name with web? | **Yes**, separate JSON implementation |
| D4 | Auto-update in v1? | **No** (Phase 9 later) |
| D5 | Browser: single tab or multi-tab BrowserView? | **Single** agent browser first |

---

## 10. Risk register

| Risk | Impact | Mitigation |
|------|--------|------------|
| `node-pty` fails to build on Win | No terminal | Document VS Build Tools; `electron-rebuild`; clear error UI |
| Supply-chain compromised npm pkg | Critical | Allowlist + preinstall ban + pin versions |
| BrowserView overlays Monaco | UI glitch | Sync bounds on resize; hide view when panel hidden |
| Scope creep (copy web 1:1) | Delays | Stick to phases; rewrite only needed behavior |
| Agent rewrite bugs | Bad edits | Approval gate + checkpoints before Phase 7 full git |

---

## 11. Definition of Done (product v1.0)

- [ ] Windows installer runs on clean Win 10/11 machine
- [ ] Open folder, edit files, chat Ask/Agent, apply patches with review
- [ ] Terminal (PowerShell) + agent command log
- [ ] Embedded browser for agent (no Playwright)
- [ ] No runtime dependency on Express/Playwright/ws server
- [ ] `PLAN.md` phases 0–8 exit criteria checked off
- [ ] `docs/session-handoff.md` updated per release

---

## 12. Document map

| File | Role |
|------|------|
| **PLAN.md** (this file) | Phases, gates, timeline, decisions |
| `AGENTS.md` | Rules for AI/human contributors |
| `README.md` | Quick start for developers |
| `docs/architecture.md` | Technical diagram (update when IPC stabilizes) |
| `docs/SECURITY.md` | npm / runtime security |
| `docs/DEPENDENCIES.md` | Package allowlist |
| `docs/session-handoff.md` | Per-session changelog |

---

## 13. Changelog

| Date | Change |
|------|--------|
| 2026-05-31 | Initial master plan; Phase 0 marked complete |
