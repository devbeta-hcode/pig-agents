import { useEffect, useMemo, useRef, useState } from "react";
import { PlayTriangle } from "./ChevronExpand";
import { IconX, IconMenu, IconZap, IconAlertTriangle, IconTrash, IconPlus, IconMoreHorizontal, IconSquareFill } from "./Icons";
import { TerminalView } from "./Terminal";
import { AgentTerminalView } from "./AgentTerminalView";
import { api, type AgentCommandSummary } from "../lib/api";
import { useDialogs } from "./DialogProvider";

interface TerminalsHandle {
  reveal: (cwd: string) => void;
}

interface Props {
  registerHandle?: (h: TerminalsHandle) => void;
  onClose?: () => void;
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
  id: string;
  run: AgentCommandSummary;
}

interface LiveAgentTab {
  kind: "live";
  id: string;
  cmd: string;
  cwd: string;
  startedAt: number;
  output: string;
}

type TerminalTab = ShellTab | AgentTab | LiveAgentTab;

let nextShellOrd = 1;

function shellLabel(ordinal: number): string {
  return `PowerShell ${ordinal}`;
}

function makeShell(initial?: string): ShellTab {
  const ordinal = nextShellOrd++;
  return { kind: "shell", id: `shell-${ordinal}`, ordinal, initial };
}

export function Terminals({ registerHandle, onClose, workspace }: Props) {
  const dlg = useDialogs();
  const [shells, setShells] = useState<ShellTab[]>([makeShell()]);
  const [agents, setAgents] = useState<AgentCommandSummary[]>([]);
  const [liveRuns, setLiveRuns] = useState<LiveAgentTab[]>([]);
  const [activeId, setActiveId] = useState<string>(shells[0].id);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(140);
  const sidebarResizing = useRef(false);

  const allTabs: TerminalTab[] = useMemo(() => {
    const s: TerminalTab[] = shells.map((x) => ({ ...x }));
    const l: TerminalTab[] = liveRuns.map((r) => ({ ...r }));
    const a: TerminalTab[] = agents.map((r) => ({ kind: "agent", id: r.id, run: r }));
    return [...s, ...l, ...a];
  }, [shells, liveRuns, agents]);

  const activeTab = useMemo(
    () => allTabs.find((t) => t.id === activeId) ?? allTabs[0],
    [allTabs, activeId],
  );

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

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      api.listAgentCommands()
        .then((r) => { if (!cancelled) setAgents(r.runs); })
        .catch(() => { /* noop */ });
    };
    refresh();
    const poll = window.setInterval(refresh, 10000);
    const onBecameVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onBecameVisible);
    window.addEventListener("focus", refresh);
    const sub = api.streamAgentCommands({
      onHello: (runs, live) => {
        if (!cancelled) {
          setAgents(runs);
          if (live.length > 0) {
            setLiveRuns(live.map((r) => ({ kind: "live" as const, ...r })));
          }
        }
      },
      onRun: (run) => {
        if (cancelled) return;
        setLiveRuns((cur) => cur.filter((r) => r.id !== run.id));
        setAgents((cur) => [run, ...cur.filter((r) => r.id !== run.id)]);
      },
      onClear: () => {
        if (!cancelled) {
          setAgents([]);
          setLiveRuns([]);
        }
      },
      onDelete: (id) => {
        if (cancelled) return;
        setAgents((cur) => cur.filter((r) => r.id !== id));
        setLiveRuns((cur) => cur.filter((r) => r.id !== id));
      },
      onRunStart: (info) => {
        if (cancelled) return;
        const tab: LiveAgentTab = { kind: "live", ...info, output: "" };
        setLiveRuns((cur) => [tab, ...cur.filter((r) => r.id !== info.id)]);
        setActiveId(info.id);
      },
      onRunChunk: (chunk) => {
        if (cancelled) return;
        setLiveRuns((cur) =>
          cur.map((r) =>
            r.id === chunk.id ? { ...r, output: r.output + chunk.text } : r,
          ),
        );
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
    setAgents((cur) => cur.filter((r) => r.id !== id));
    setLiveRuns((cur) => cur.filter((r) => r.id !== id));
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

  function onSidebarResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    sidebarResizing.current = true;
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      if (!sidebarResizing.current) return;
      const next = Math.max(140, Math.min(400, startW - (ev.clientX - startX)));
      setSidebarWidth(next);
    };
    const onUp = () => {
      sidebarResizing.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const activeShellOrdinal =
    activeTab && activeTab.kind === "shell"
      ? activeTab.ordinal
      : null;
  const headerLabel = activeTab
    ? activeTab.kind === "shell"
      ? shellLabel(activeTab.ordinal)
      : activeTab.kind === "live"
        ? `⚡ Running: ${activeTab.cmd.length > 40 ? activeTab.cmd.slice(0, 40) + "…" : activeTab.cmd}`
        : `Agent: ${activeTab.run.cmd.length > 40 ? activeTab.run.cmd.slice(0, 40) + "…" : activeTab.run.cmd}`
    : "Terminal";

  return (
    <div className="terminals">
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
          <aside className="terminals-sidebar" style={{ width: sidebarWidth }}>
            <div
              className="terminals-sidebar-resizer"
              onMouseDown={onSidebarResizeStart}
            />
            <div className="terminals-section">
              <div className="terminals-section-head">
                <span>Shells</span>
                <button className="terminals-section-btn" title="New terminal" onClick={newShell}><IconPlus size={13} /></button>
              </div>
              {shells.map((s) => (
                <div
                  key={s.id}
                  className={`terminals-item ${activeId === s.id ? "active" : ""}`}
                  onClick={() => setActiveId(s.id)}
                >
                  <PlayTriangle className="terminals-item-icon" />
                  <span className="terminals-item-name">{shellLabel(s.ordinal)}</span>
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
                <span>Agent runs <em>{(liveRuns.length + agents.length) > 0 ? `(${liveRuns.length + agents.length})` : ""}</em></span>
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
              {liveRuns.map((r) => (
                <div
                  key={r.id}
                  className={`terminals-item agent live ${activeId === r.id ? "active" : ""}`}
                  onClick={() => setActiveId(r.id)}
                  title={`$ ${r.cmd}\n⚡ Running…`}
                >
                  <span className="terminals-item-icon" style={{ color: "var(--warn)" }}>
                    <IconZap size={13} />
                  </span>
                  <span className="terminals-item-name">{r.cmd.length > 30 ? r.cmd.slice(0, 30) + "…" : r.cmd}</span>
                  <button
                    className="terminals-item-close"
                    title="Kill this command (agent keeps running)"
                    onClick={(e) => {
                      e.stopPropagation();
                      api.killAgentCommand(r.id).catch((err) => {
                        console.warn("killAgentCommand failed:", err);
                      });
                    }}
                    style={{ color: "var(--warn)" }}
                  >
                    <IconSquareFill size={11} />
                  </button>
                </div>
              ))}
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
          {activeTab && activeTab.kind === "agent" && (
            <AgentTerminalView runId={activeTab.id} />
          )}
          {activeTab && activeTab.kind === "live" && (
            <LiveTerminalView run={activeTab} />
          )}
        </div>
      </div>
    </div>
  );
}

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

function LiveTerminalView({ run }: { run: LiveAgentTab }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [killing, setKilling] = useState(false);

  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run.output]);

  const startedAt = new Date(run.startedAt).toLocaleTimeString();
  const elapsed = Math.floor((Date.now() - run.startedAt) / 1000);

  function handleKill(e: React.MouseEvent) {
    e.stopPropagation();
    if (killing) return;
    setKilling(true);
    api.killAgentCommand(run.id).catch((err) => {
      console.warn("killAgentCommand failed:", err);
      setKilling(false);
    });
  }

  return (
    <div className="agent-term">
      <div className="agent-term-header">
        <span className="agent-term-prompt" style={{ color: "var(--warn)" }}>$</span>
        <span className="agent-term-cmd" title={run.cmd}>{run.cmd}</span>
        <span className="agent-term-exit" style={{ color: "var(--warn)", animation: killing ? undefined : "pulse 1s infinite" }}>
          {killing ? "stopping…" : "running…"}
        </span>
        <span className="agent-term-meta">{elapsed}s · {startedAt}</span>
        <button
          id={`kill-cmd-${run.id}`}
          className="agent-term-copy"
          title="Kill this command (agent keeps running)"
          onClick={handleKill}
          disabled={killing}
          style={{ color: killing ? undefined : "var(--err, #f87171)", fontWeight: 600 }}
        >
          <IconSquareFill size={12} />
        </button>
      </div>
      <div className="agent-term-cwd">cwd: {run.cwd}</div>
      <pre ref={preRef} className="agent-term-output" style={{ overflowY: "auto", maxHeight: "100%" }}>
        {run.output || <span style={{ opacity: 0.4 }}>Waiting for output…</span>}
      </pre>
    </div>
  );
}

export type { TerminalsHandle };
