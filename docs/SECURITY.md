# Security — supply chain and runtime

## npm supply chain (mandatory)

Recent attacks use typosquatting, compromised maintainers, and install-time scripts. **Every new dependency must pass this checklist before `npm install`:**

1. **Name sanity** — Exact package name on https://www.npmjs.com/ (no lookalikes).
2. **Publisher** — Prefer packages from known orgs (`@electron`, `@vitejs`, `facebook`, `microsoft`, `xtermjs`).
3. **Age & downloads** — Avoid brand-new packages with no history unless strictly necessary.
4. **Install scripts** — Run `npm view <pkg> scripts` and inspect `postinstall` / `preinstall`. Reject suspicious network or `curl | sh` patterns.
5. **Community signal** — Quick search: package name + "malware" / "compromised" (Reddit, GitHub issues, Socket, Snyk advisories) for the **current week**.
6. **Lockfile** — Always commit `package-lock.json`; use `npm ci` in CI, not open-ended `npm i` without review.
7. **Audit** — After install: `npm audit` (fix high/critical in direct deps when possible).

## Allowed install commands

```bash
# Preferred after lockfile is reviewed
npm ci

# New package (human or agent must document in DEPENDENCIES.md first)
npm install <exact-package>@<exact-version> --save-exact
```

## Forbidden patterns

- `npx` pulling unknown packages in production code paths.
- `curl | bash` or remote script installs from application code.
- Dependencies with no source repo or empty GitHub.
- Optional packages that auto-run crypto miners (historical `event-stream` class of issues).

## Runtime (Electron)

- `contextIsolation: true`, `sandbox: true` where compatible for renderer.
- Never expose `fs`, `child_process`, or raw `env` secrets to renderer.
- API keys only in main process / `userData` settings file with masking in UI.
- `webSecurity: true` on BrowserView unless a documented exception exists.
- Block `nodeIntegration` in renderer and in BrowserView guest unless required (prefer off).

## Reporting

If a listed dependency in `DEPENDENCIES.md` is reported compromised, stop installs, pin/remove the package, and update the allowlist the same day.
