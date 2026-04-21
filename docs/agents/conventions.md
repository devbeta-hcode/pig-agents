# Conventions

Read these before opening a PR-sized change. They're terse on purpose.

## TypeScript & language

- **Strict mode is on** in both packages. No `any` for new code; prefer
  `unknown` + narrowing or precise types. If you absolutely must, scope it
  with a TODO referencing why.
- **ESM everywhere.** Imports of local modules **must** include `.js` (even
  in `.ts` source) so the compiled output and `tsx` agree:
  `import { foo } from "./bar.js";`.
- **No default exports** for components or modules; named exports only.
  Easier to grep, easier to refactor.
- **Discriminated unions** for events / messages / tool actions
  (`{ type: "thought", ... } | { type: "action", ... } | ...`). Switch on
  `type` and let TS narrow.

## Naming

- React components: `PascalCase` files and exports (`FileTree.tsx`).
- Hooks / utilities: `camelCase` (`useDebouncedSave`, `safeJoin`).
- Backend modules: `camelCase` files (`commandLog.ts`).
- CSS classes: `kebab-case`, scoped by feature prefix (`chat-`, `tree-`,
  `terminals-`, `agent-term-`).
- Custom DOM events: `ba:<noun>-<verb>` (`ba:active-file`,
  `ba:editor-action`).
- localStorage keys: `build-agents.<namespace>.<key>.v<n>` and bump `vN`
  when shape changes.

## Comments

> **Comments explain *why*, not *what*.** This is enforced by code review.

Bad:

```ts
// increment the counter
i++;
// loop through items
for (const it of items) { ... }
```

Good:

```ts
// Atomic write: rename is the only crash-safe primitive across filesystems.
fs.renameSync(tmp, target);

// We must not call this from `useLayoutEffect` — Monaco hasn't measured
// its container yet and `setModel` would no-op.
```

If a function's body is self-explanatory, **no comment**. Reserve them for
non-obvious intent, trade-offs, gotchas, or platform constraints.

## Errors

- **Backend routes**: catch and return `4xx` with `{ error: msg }`.
  Reserve `5xx` for "this is a bug, not user input."
- **Tools**: throw `Error` with a useful message. The agent's
  `executor.ts` will surface it as an observation.
- **Frontend**: avoid `alert()` for non-fatal errors — use inline cards or
  a toast region. `alert()` is acceptable for "user clicked Save and disk
  is full" style failures where blocking is correct.
- **Never swallow errors silently.** At minimum `console.warn(...)` so the
  next agent debugging the issue has a breadcrumb.

## State management (frontend)

- Local state with `useState`. Lift it only when two siblings need it.
- For app-wide signals, prefer typed `CustomEvent` over context. We don't
  use Redux/Zustand and there is no plan to.
- For "imperative" child APIs (Monaco save, Terminals reveal), use
  `forwardRef` + `useImperativeHandle`.
- `useEffect` cleanup is **mandatory** for subscriptions
  (`EventSource`, `WebSocket`, `addEventListener`). Memory leaks on a
  long-lived dev server bite hard.

## CSS

- All rules in `app/frontend/src/styles.css`. Group near related blocks.
- Use the existing CSS variables defined at the top: `--bg`, `--fg`,
  `--fg-dim`, `--accent`, `--accent-2`, `--hover`, `--selection`,
  `--border`, `--bad`. Add a new var only if it'll be used in ≥3 places.
- Don't introduce a CSS framework or CSS-in-JS library.

## File / path handling

- **Per-repo agent rules (Pig Agents).** Put Markdown rules next to the code
  so each project steers the agent without changing the global prompt:
  **`<workspace>/.pig/rules/**/*.md`** (and `.mdc`). Files under
  **`.cursor/rules/`** (any depth) are also loaded if present (reuse Cursor rules without
  copying). The backend prepends these to the system message as “PROJECT
  RULES”. Total size is capped by **`PROJECT_RULES_MAX_CHARS`** (default
  `16000`). Bookkeeping under **`.build-agents/`** (policy, checkpoints) is
  separate from rules.

- **Workspace-relative inside the app boundary.** Convert with `toRel()`
  before sending to clients. Resolve client input through `safeJoin()`
  before touching the disk.
- **Posix separators** in workspace-relative paths (`a/b/c.ts`), even on
  Windows. The frontend assumes `/`.
- **Never** read or write outside the workspace from a tool. If a feature
  needs that (e.g. chat storage in `~/.build-agents/`), it's a backend
  concern that bypasses `safeJoin` deliberately and is documented.

## Logging

- Backend: `utils/logger.ts` (info/warn/error). Don't litter `console.log`.
- Frontend: `console.warn` for recoverable issues, `console.error` for
  bugs the user shouldn't see but might. Don't ship debug `console.log`s.

## Performance hot paths

- Chat session writes are **debounced 350 ms** (LLM token streams flood
  otherwise).
- Agent SSE events are **buffered** by the server and flushed on each
  `res.write` — don't replace with chunked-fetch unless you measure.
- Agent command log is **bounded to 100 entries**. Higher values defeat
  the "in-memory ring" promise; persist to disk if you need more.
- Monaco editor models are reused per `path`; create new ones only when
  the path changes (otherwise diff decorations get confused).

## When in doubt

Match the surrounding code. If the surrounding code is bad, fix it first
and document the rationale in your commit message.
