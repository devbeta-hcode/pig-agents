import { useEffect, useMemo, useState } from "react";
import { FileIcon } from "./FileIcon";
import { listRecents, removeRecent, type RecentFile } from "../lib/recents";
import { IconSearch, IconTerminal, IconX } from "./Icons";

// Detect macOS so the keyboard hints below render with ⌘ instead of Ctrl.
function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const platform = (navigator as Navigator & { platform?: string }).platform || "";
  return /Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X/.test(ua);
}

// Tiny helper to render a labeled key cap, e.g. <Kbd>S</Kbd>. CSS does the
// rest — we want them to look like real keys, not inline code.
function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="ew-kbd">{children}</kbd>;
}

interface QuickAction {
  id: string;
  icon: React.ReactNode;
  title: string;
  desc: string;
  shortcut?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

interface EditorWelcomeProps {
  workspace: string;
  onOpenFolder: () => void;
  onOpenFile: (path: string) => void;
  onShowSearch: () => void;
  onToggleTerminal: () => void;
  /** Bumped externally whenever the recent-files list may have changed. */
  recentsVersion?: number;
}

export function EditorWelcome({
  workspace,
  onOpenFolder,
  onOpenFile,
  onShowSearch,
  onToggleTerminal,
  recentsVersion = 0,
}: EditorWelcomeProps) {
  const mac = useMemo(isMac, []);
  const mod = mac ? "⌘" : "Ctrl";
  const [recents, setRecents] = useState<RecentFile[]>([]);

  useEffect(() => {
    setRecents(listRecents(workspace));
  }, [workspace, recentsVersion]);

  // Render a friendly path: strip the workspace prefix so "/very/long/ws/src/App.tsx"
  // shows up as just "src/App.tsx". Keep absolute when outside the workspace.
  function relPath(p: string): string {
    if (!workspace) return p;
    const ws = workspace.endsWith("/") ? workspace : workspace + "/";
    return p.startsWith(ws) ? p.slice(ws.length) : p;
  }

  const wsName = workspace ? workspace.split("/").filter(Boolean).pop() || workspace : "";

  const actions: QuickAction[] = [
    {
      id: "open-folder",
      icon: <FileIcon name="" isDir size={20} />,
      title: workspace ? "Change folder…" : "Open folder",
      desc: workspace ? "Switch the active workspace" : "Pick a project to start working on",
      onClick: onOpenFolder,
    },
    {
      id: "search",
      icon: <IconSearch size={20} />,
      title: "Search files",
      desc: "Find by name or content across the workspace",
      shortcut: (
        <>
          <Kbd>{mod}</Kbd>+<Kbd>P</Kbd>
        </>
      ),
      onClick: onShowSearch,
      disabled: !workspace,
    },
    {
      id: "terminal",
      icon: <IconTerminal size={20} />,
      title: "Toggle terminal",
      desc: "Run shell commands in the bottom panel",
      shortcut: (
        <>
          <Kbd>{mod}</Kbd>+<Kbd>`</Kbd>
        </>
      ),
      onClick: onToggleTerminal,
    },
  ];

  return (
    <div className="editor-welcome" role="region" aria-label="Welcome">
      <div className="ew-inner">
        <header className="ew-header">
          <div className="ew-brand">
            <div className="ew-brand-mark" aria-hidden>
              {/* Inline brand glyph — a folded "B" with a pulse line so it
                  reads as both "Build" and "agent activity". Pure SVG, no
                  external asset to manage. */}
              <svg viewBox="0 0 40 40" width="40" height="40">
                <defs>
                  <linearGradient id="ew-grad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#3b82f6" />
                    <stop offset="1" stopColor="#8b5cf6" />
                  </linearGradient>
                </defs>
                <rect x="2" y="2" width="36" height="36" rx="9" fill="url(#ew-grad)" />
                <path
                  d="M12 11 H22 a5 5 0 0 1 0 10 H12 Z M12 21 H24 a5 5 0 0 1 0 10 H12 Z"
                  fill="#fff"
                  fillOpacity="0.95"
                />
                <path
                  d="M28 26 L31 22 L34 30"
                  fill="none"
                  stroke="#fff"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity="0.9"
                />
              </svg>
            </div>
            <div className="ew-brand-text">
              <div className="ew-title">Pig Agents</div>
              <div className="ew-subtitle">
                Your AI coding workspace, powered by your own agents.
              </div>
            </div>
          </div>
          {workspace ? (
            <div className="ew-ws" title={workspace}>
              <FileIcon name={wsName} isDir expanded size={14} />
              <span className="ew-ws-name">{wsName}</span>
              <span className="ew-ws-path">{workspace}</span>
            </div>
          ) : (
            <div className="ew-ws ew-ws-empty">No folder opened</div>
          )}
        </header>

        <section className="ew-section">
          <div className="ew-section-title">Start</div>
          <div className="ew-actions">
            {actions.map((a) => (
              <button
                key={a.id}
                type="button"
                className="ew-action"
                onClick={a.onClick}
                disabled={a.disabled}
              >
                <span className="ew-action-icon">{a.icon}</span>
                <span className="ew-action-text">
                  <span className="ew-action-title">{a.title}</span>
                  <span className="ew-action-desc">{a.desc}</span>
                </span>
                {a.shortcut ? <span className="ew-action-shortcut">{a.shortcut}</span> : null}
              </button>
            ))}
          </div>
        </section>

        {workspace ? (
          <section className="ew-section">
            <div className="ew-section-title">
              <span>Recent files</span>
              {recents.length ? (
                <span className="ew-section-meta">{recents.length}</span>
              ) : null}
            </div>
            {recents.length === 0 ? (
              <div className="ew-empty">
                Files you open will show up here for quick access.
              </div>
            ) : (
              <ul className="ew-recents">
                {recents.map((r) => (
                  <li key={r.path}>
                    <button
                      type="button"
                      className="ew-recent"
                      onClick={() => onOpenFile(r.path)}
                      title={r.path}
                    >
                      <FileIcon name={r.path.split("/").pop() || ""} size={16} />
                      <span className="ew-recent-name">{r.path.split("/").pop()}</span>
                      <span className="ew-recent-dir">
                        {(() => {
                          const rel = relPath(r.path);
                          const idx = rel.lastIndexOf("/");
                          return idx > 0 ? rel.slice(0, idx) : "";
                        })()}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ew-recent-x"
                      title="Remove from recent"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeRecent(workspace, r.path);
                        setRecents(listRecents(workspace));
                      }}
                    >
                      <IconX size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        <footer className="ew-footer">
          <div className="ew-tips">
            <span className="ew-tip">
              <Kbd>{mod}</Kbd>+<Kbd>S</Kbd> Save
            </span>
            <span className="ew-tip">
              <Kbd>{mod}</Kbd>+<Kbd>P</Kbd> Quick file search
            </span>
            <span className="ew-tip">
              <Kbd>{mod}</Kbd>+<Kbd>`</Kbd> Toggle terminal
            </span>
            <span className="ew-tip">
              <Kbd>@</Kbd> Mention a file in chat
            </span>
            <span className="ew-tip">
              Right-click in the file tree for more actions
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}
