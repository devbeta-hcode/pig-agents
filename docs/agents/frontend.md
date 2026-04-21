# Frontend

React + Vite + TypeScript. No state management library — `useState` /
`useEffect` / `useRef` plus a few `CustomEvent`s on `window` for
cross-component messaging. Monaco for the editor, xterm.js for terminals,
`react-resizable-panels` for layout.

## Module map

```text
app/frontend/src/
├── main.tsx                Vite entry
├── App.tsx                 layout shell + workspace + chat session state
├── styles.css              all CSS (no CSS modules / Tailwind)
└── components/
    ├── FileTree.tsx        Explorer sidebar w/ context menu, copy/cut/paste
    ├── Editor.tsx          Monaco wrapper (FileEditor + handle ref)
    ├── DiffViewer.tsx      compact list of pending diffs (in chat panel)
    ├── DiffEditorView.tsx  Monaco DiffEditor in a tab
    ├── Chat.tsx            chat panel: turns, composer, slash cmds, drag-drop
    ├── ChatsList.tsx       sidebar list of past chat sessions + search
    ├── Terminals.tsx       VSCode-style terminal panel + AGENT RUNS sidebar
    ├── Terminal.tsx        single xterm wired to /terminal/ws
    ├── AgentTerminalView   read-only viewer for a captured agent shell run
    ├── SearchPanel.tsx     full-text code search (sidebar)
    ├── FolderPicker.tsx    "Open Folder" modal
    ├── SettingsModal.tsx   masked settings form (.env-backed)
    ├── Modal.tsx           generic modal frame
    ├── Markdown.tsx        markdown + code blocks (Apply / Insert buttons)
    ├── MentionInput.tsx    @-mention picker; auto-grow, overflow-y capped (see file)
    ├── ChevronExpand.tsx   SVG disclosure chevron + PlayTriangle for shell rows
    └── ContextMenu.tsx     reusable right-click menu (supports `disabled`)

└── lib/
    ├── api.ts              typed REST/SSE client (single source of truth)
    └── sessions.ts         newSession() helper, ChatSession type
```

## Layout

```text
┌────────────────────────────── titlebar ──────────────────────────────┐
│  📂 <workspace>                          ⟲ Reset · ▤ Terminal · ⚙   │
├──────┬─────────────────┬──────────────────────────────┬──────────────┤
│ 📁🔍 │  sidebar        │  editor area + tabs          │  chat        │
│ 💬   │  (Explorer /    │  ┌──────────────────────────┐│              │
│      │   Search /      │  │  Monaco / DiffEditor     ││              │
│      │   ChatsList)    │  └──────────────────────────┘│              │
│      │                 │ ─── horizontal resize ───    │              │
│      │                 │  bottom panel: Terminals     │              │
└──────┴─────────────────┴──────────────────────────────┴──────────────┘
                              statusbar
```

Panels are `react-resizable-panels`; sizes persist under
`react-resizable-panels:*` keys in `localStorage`. The titlebar's
**⟲ Reset layout** button purges those keys and reloads.

## App.tsx is the brain

`App.tsx` owns:

- `workspace` (string) — empty until the user picks a folder; persistence
  flag is `build-agents.ws.confirmed.v1`.
- `tabs` (`OpenTab[]`) — file or diff tabs. Diff tabs prefix the path with
  `diff:<id>:` so they coexist with the file tab of the same name.
- `diffs` (`DiffItem[]`) — pending diffs from agent edits.
- `chatList` (`ChatSessionMeta[]`) — sidebar list, lightweight.
- `activeSession` (`ChatSession | null`) — full session, lazy-loaded.
- `settings`, `pickerOpen`, `settingsOpen`, `bottomCollapsed`, `view`, …

Heavy children get **handles via `useRef` + `forwardRef` +
`useImperativeHandle`** (see `FileEditor`, `Terminals`) so the App can call
methods like `editorRef.current?.save()` or `terminalsRef.current?.reveal()`
without re-rendering them.

## Cross-component messaging

We avoid context for short-lived, low-volume signals. Instead the App
listens to / dispatches `CustomEvent`s on `window`:

| Event | Direction | Detail |
| --- | --- | --- |
| `ba:active-file` | App → world | `{ path: string \| null }` (broadcast on tab change) |
| `ba:editor-action` | child → App | `{ kind: "insert" \| "replace", text, target }` (Apply button on chat code blocks) |
| Drag/drop file → chat | native HTML5 | `application/x-ba-file` MIME on the dataTransfer |

When adding new cross-component triggers, follow this pattern: a `ba:`
prefix, typed `CustomEvent<Detail>`, and document it in this file.

## API client (`lib/api.ts`)

- One `BASE = "/api"` constant.
- One generic `jsonOrThrow(res)` helper.
- One exported `api` object with all methods. Add new endpoints there —
  components must not call `fetch` directly.
- SSE helpers return a `{ close }` handle so callers can clean up in
  `useEffect`.

```ts
const sub = api.streamAgentCommands({
  onHello: (runs) => { /* … */ },
  onRun: (run) => { /* … */ },
  onDelete: (id) => { /* … */ },
  onClear: () => { /* … */ },
});
return () => sub.close();
```

## Adding a UI panel

1. Create the component in `components/`. Keep CSS additions in
   `styles.css` near related rules; reuse vars `--bg`, `--fg`, `--accent`,
   `--hover`, `--selection`, `--border`, `--bad`.
2. If the panel is in the activity bar, add a `view` value in `App.tsx` and
   render it inside the sidebar Panel (gate on `workspace` so the empty
   state still wins when no folder is opened).
3. If you need new backend data, add an `api.*` method (don't `fetch`
   directly).
4. If the panel can affect other panels, prefer a typed `CustomEvent` (see
   above) over hoisting state.

## Empty state for "no folder opened"

Multiple panels share the `.ws-empty` style block (`.ws-empty-title`,
`.ws-empty-msg`, `.ws-empty-btn`). Use this when a panel needs the user to
pick a workspace before it can render anything useful.
