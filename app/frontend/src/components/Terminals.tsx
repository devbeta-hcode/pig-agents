import { useEffect, useMemo, useRef, useState } from "react";
import { PlayTriangle } from "./ChevronExpand";
import { IconX, IconMenu, IconZap, IconAlertTriangle, IconTrash } from "./Icons";
import { TerminalView } from "./Terminal";
import { AgentTerminalView } from "./AgentTerminalView";
import { api, type AgentCommandSummary } from "../lib/api";
import { useDialogs } from "./DialogProvider";

interface TerminalsHandle {
  reveal: (cwd: string) => void;
}

interface Props {
  registerHandle?: (h: TerminalsHandle) => void;
  /** Closes the bottom panel from the title bar's ✕ button. */
  onClose?: () => void;
  /** Open-folder path so each bash session starts in the project root. */
  workspace?: string;
}

interface ShellTab {
  kind: "shell";
  id: string;
  ordinal: number;
  initial?: string;
}

interface AgentTab {
  kind: "agent";
  /** Stable agent-command id (`cmd_…`). Used as both id and selection key. */
  id: string;
  run: AgentCommandSummary;
}

type TerminalTab = ShellTab | AgentTab;

let nextShellOrd = 1;

function makeShell(initial?: string): ShellTab {
  const ordinal = nextShellOrd++;
  return { kind: "shell", id: `shell-${ordinal}`, ordinal, initial };
}

export function Terminals({ registerHandle, onClose, workspace }: Props) {
  const dlg = useDialogs();
  const [shells, setShells] = useState<ShellTab[]>([makeShell()]);
  const [agents, setAgents] = useState<AgentCommandSummary[]>([]);
  const [activeId, setActiveId] = useState<string>(shells[0].id);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Stable list of all tabs in display order: shells first, then agent runs (newest top).
  const allTabs: TerminalTab[] = useMemo(() => {
    const s: TerminalTab[] = shells.map((x) => ({ ...x }));
    const a: TerminalTab[] = agents.map((r) => ({ kind: "agent", id: r.id, run: r }));
    return [...s, ...a];
  }, [shells, agents]);

  const activeTab = useMemo(
    () => allTabs.find((t) => t.id === activeId) ?? allTabs[0],
    [allTabs, activeId],
  );

  // ---- expose imperative reveal() for "Open in terminal" --------------------
  const registerRef = useRef(registerHandle);
  useEffect(() => { registerRef.current = registerHandle; }, [registerHandle]);
  useEffect(() => {
    registerRef.current?.({
      reveal: (cwd: string) => {
        const tab = makeShell(`cd "${cwd.replace(/"/g, '\\"')}"`);
        setShells((t) => [...t, tab]);
        setActiveId(tab.id);
      },
    });
  }, []);

  // ---- live agent-command feed ---------------------------------------------
  // SSE can stall (sleep, proxy, connection limits). Poll + focus refresh keep
  // the sidebar in sync without requiring F5.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      api.listAgentCommands()
        .then((r) => { if (!cancelled) setAgents(r.runs); })
        .catch(() => { /* noop */ });
    };
    refresh();
    const poll = window.setInterval(refresh, 4000);
    const onBecameVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onBecameVisible);
    window.addEventListener("focus", refresh);
    const sub = api.streamAgentCommands({
      onHello: (runs) => { if (!cancelled) setAgents(runs); },
      onRun: (run) => {
        if (cancelled) return;
        setAgents((cur) => [run, ...cur.filter((r) => r.id !== run.id)]);
      },
      onClear: () => { if (!cancelled) setAgents([]); },
      onDelete: (id) => {
        if (cancelled) return;
        setAgents((cur) => cur.filter((r) => r.id !== id));
      },
    });
    return () => {
      cancelled = true;
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onBecameVisible);
      window.removeEventListener("focus", refresh);
      sub.close();
    };
  }, []);

  // ---- helpers --------------------------------------------------------------
  function newShell() {
    const tab = makeShell();
    setShells((t) => [...t, tab]);
    setActiveId(tab.id);
  }

  function closeShell(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setShells((t) => {
      const next = t.filter((x) => x.id !== id);
      if (next.length === 0) {
        const fresh = makeShell();
        setActiveId(fresh.id);
        return [fresh];
      }
      if (activeId === id) setActiveId(next[next.length - 1].id);
      return next;
    });
  }

  function dismissAgent(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    // Optimistic local remove; backend delete is the source of truth so the
    // entry won't reappear after a reload. SSE `delete` event also fires for
    // any other open browser tabs.
    setAgents((cur) => cur.filter((r) => r.id !== id));
    if (activeId === id && shells.length > 0) setActiveId(shells[shells.length - 1].id);
    api.deleteAgentCommand(id).catch((err) => {
      console.warn("deleteAgentCommand failed:", err);
    });
  }

  async function clearAllAgents() {
    if (agents.length === 0) return;
    if (!(await dlg.confirm({
      title: "Clear agent log",
      message: `Clear ${agents.length} agent run${agents.length === 1 ? "" : "s"} from the log?`,
      confirmLabel: "Clear",
    }))) return;
    try {
      await api.clearAgentCommands();
      setAgents([]);
    } catch (err) {
      console.warn("clearAgentCommands failed:", err);
    }
  }

  // ---- render ---------------------------------------------------------------
  const activeShellOrdinal =
    activeTab && activeTab.kind === "shell"
      ? activeTab.ordinal
      : null;
  const headerLabel = activeTab
    ? activeTab.kind === "shell"
      ? `bash ${activeTab.ordinal}`
      : `Agent: ${activeTab.run.cmd.length > 40 ? activeTab.run.cmd.slice(0, 40) + "…" : activeTab.run.cmd}`
    : "Terminal";

  return (
    <div className="terminals">
      {/* Single VSCode-style header bar */}
      <div className="terminals-header">
        <button
          className={`terminals-toggle ${sidebarOpen ? "active" : ""}`}
          title={sidebarOpen ? "Hide terminal list" : "Show terminal list"}
          onClick={() => setSidebarOpen((v) => !v)}
        >
          <IconMenu size={15} />
        </button>
        <span className="terminals-title">TERMINAL</span>
        <span className="terminals-current" title={headerLabel}>{headerLabel}</span>
        <div className="terminals-spacer" />
        <button
          className="terminals-action"
          title="New terminal"
          onClick={newShell}
        >
          +
        </button>
        {onClose && (
          <button
            className="terminals-action close"
            title="Hide panel"
            onClick={onClose}
          >
            <IconX size={14} />
          </button>
        )}
      </div>

      <div className="terminals-body">
        {sidebarOpen && (
          <aside className="terminals-sidebar">
            <div className="terminals-section">
              <div className="terminals-section-head">
                <span>Shells</span>
                <button className="terminals-section-btn" title="New terminal" onClick={newShell}>+</button>
              </div>
              {shells.map((s) => (
                <div
                  key={s.id}
                  className={`terminals-item ${activeId === s.id ? "active" : ""}`}
                  onClick={() => setActiveId(s.id)}
                >
                  <PlayTriangle className="terminals-item-icon" />
                  <span className="terminals-item-name">bash {s.ordinal}</span>
                  <button
                    className="terminals-item-close"
                    title="Kill terminal"
                    onClick={(e) => closeShell(s.id, e)}
                  >
                    <IconX size={12} />
                  </button>
                </div>
              ))}
            </div>

            <div className="terminals-section">
              <div className="terminals-section-head">
                <span>Agent runs <em>{agents.length > 0 ? `(${agents.length})` : ""}</em></span>
                {agents.length > 0 && (
                  <button
                    className="terminals-section-btn"
                    title="Clear all agent runs from history"
                    onClick={clearAllAgents}
                  >
                    <IconTrash size={13} />
                  </button>
                )}
              </div>
              {agents.map((r) => (
                <AgentItem
                  key={r.id}
                  run={r}
                  active={activeId === r.id}
                  onClick={() => setActiveId(r.id)}
                  onDismiss={(e) => dismissAgent(r.id, e)}
                />
              ))}
            </div>
          </aside>
        )}

        <div className="terminals-pane">
          {/* Shells: keep mounted so PTY survives tab switches; just toggle visibility. */}
          {shells.map((t) => (
            <div
              key={t.id}
              className="terminals-shell-host"
              style={{ display: activeShellOrdinal === t.ordinal ? "block" : "none" }}
            >
              <TerminalView
                active={activeShellOrdinal === t.ordinal}
                workspace={workspace}
                initialCommand={t.initial}
                onCommandSent={() => setShells((cur) => cur.map((x) => x.id === t.id ? { ...x, initial: undefined } : x))}
              />
            </div>
          ))}
          {/* Agent run viewer (read-only) */}
          {activeTab && activeTab.kind === "agent" && (
            <AgentTerminalView runId={activeTab.id} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Sidebar item for a single agent command ------------------------------

function AgentItem({
  run, active, onClick, onDismiss,
}: {
  run: AgentCommandSummary;
  active: boolean;
  onClick: () => void;
  onDismiss: (e: React.MouseEvent) => void;
}) {
  const ok = run.exitCode === 0;
  const dur = run.durationMs >= 1000
    ? `${(run.durationMs / 1000).toFixed(1)}s`
    : `${run.durationMs}ms`;
  return (
    <div
      className={`terminals-item agent ${active ? "active" : ""} ${ok ? "ok" : "fail"}`}
      onClick={onClick}
      title={`$ ${run.cmd}\nexit ${run.exitCode} · ${dur}`}
    >
      <span className="terminals-item-icon">{ok ? <IconZap size={13} /> : <IconAlertTriangle size={13} />}</span>
      <span className="terminals-item-name">{run.cmd}</span>
      <span className="terminals-item-meta">{dur}</span>
      <button
        className="terminals-item-close"
        title="Remove from list"
        onClick={onDismiss}
      >
        <IconX size={12} />
      </button>
    </div>
  );
}

export type { TerminalsHandle };
