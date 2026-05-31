# Pig Agents Desktop

Native IDE + AI agent for **Windows** (first), **Linux**, and **macOS**.

**Start here:** [`PLAN.md`](PLAN.md) — master plan (phases, gates, timeline).

This repository is **independent** from `pig-agents-web/`. Do not copy or patch files from the web project; reimplement features here against the rules in `AGENTS.md` and `.cursor/rules/`.

## Architecture

```text
app/
  core/       Node logic (agent, tools, FS) — no HTTP, no Playwright
  electron/   Main process, IPC, BrowserView, PTY
  renderer/   React UI — talks only via preload IPC
```

- **No** Express, Vite dev proxy, or browser-hosted backend.
- **No** Playwright / remote screencast browser.
- Embedded browsing uses Electron `BrowserView` + `webContents`.

## Prerequisites

- Node.js 20 LTS (64-bit)
- Windows 10/11 for primary development
- Visual Studio Build Tools (for `node-pty` on Windows) when enabling terminals

## Configuration

| What | Where |
|------|--------|
| LLM provider, model, API keys | **Settings** in the app (saved automatically) |
| Runtime `.env` | `%APPDATA%\Pig Agents\.env` on Windows (`PIG_ENV_FILE` in main) |
| Per-provider API keys | `llm-profiles.json` under userData (managed via Settings) |

## Security before `npm install`

Read [`docs/SECURITY.md`](docs/SECURITY.md) and [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md). New packages require approval and a lockfile update.

```bash
npm install
npm run dev
```

## App icon

Source: project root `icon.png` (1024×1024). Copies used by the app:

| Path | Use |
|------|-----|
| `app/electron/resources/icon.png` | Electron window / installer (`electron-builder`) |
| `app/renderer/public/icon.png` | Dev UI favicon |

After replacing `icon.png`, copy it to both paths above (or re-run your asset sync).

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Electron + Vite renderer (HMR) |
| `npm run build` | Production bundles |
| `npm run package:win` | NSIS installer (Windows x64) |

## Reference only

`pig-agents-web/` may sit beside this repo for product ideas. **Do not import or symlink its source into `app/`.**
