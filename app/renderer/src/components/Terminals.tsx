import { useEffect, useMemo, useRef, useState } from "react";
import { PlayTriangle } from "./ChevronExpand";
import { IconX, IconMenu, IconZap, IconPlus, IconSquareFill } from "./Icons";
import { TerminalView } from "./Terminal";
import { api } from "../lib/api";

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

interface LiveAgentTab {
  kind: "live";
  id: string;
  cmd: string;
  cwd: string;
  startedAt: number;
  output: string;
  pid?: number;
  background?: boolean;
}

function liveTabFromServer(
  info: { id: string; cmd: string; cwd: string; startedAt: number; output?: string; pid?: number; background?: boolean },
  outputFallback = "",
): LiveAgentTab {
  return {
    kind: "live",
    id: info.id,
    cmd: info.cmd,
    cwd: info.cwd,
    startedAt: info.startedAt,
    output: info.output ?? outputFallback,
    pid: info.pid,
    background: info.background,
  };
}

function mergeLiveFromServer(
  cur: LiveAgentTab[],
  incoming: Array<{ id: string; cmd: string; cwd: string; startedAt: number; output: string; pid?: number; background?: boolean }>,
): LiveAgentTab[] {
  const prevOut = new Map(cur.map((r) => [r.id, r.output]));
  return incoming
    .map((l) => liveTabFromServer(l, prevOut.get(l.id) ?? l.output ?? ""))
    .sort((a, b) => b.startedAt - a.startedAt);
}

type TerminalTab = ShellTab | LiveAgentTab;

let nextShellOrd = 1;

function shellLabel(ordinal: number): string {
  return `PowerShell ${ordinal}`;
}

function makeShell(initial?: string): ShellTab {
  const ordinal = nextShellOrd++;
  return { kind: "shell", id: `shell-${ordinal}`, ordinal, initial };
}

export function Terminals({ registerHandle, onClose, workspace }: Props) {
  const [shells, setShells] = useState<ShellTab[]>([makeShell()]);
  const [liveRuns, setLiveRuns] = useState<LiveAgentTab[]>([]);
  const [activeId, setActiveId] = useState<string>(shells[0].id);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(140);
  const sidebarResizing = useRef(false);
  const shellsRef = useRef(shells);
  shellsRef.current = shells;

  const allTabs: TerminalTab[] = useMemo(() => {
    const s: TerminalTab[] = shells.map((x) => ({ ...x }));
    const l: TerminalTab[] = liveRuns.map((r) => ({ ...r }));
    return [...s, ...l];
  }, [shells, liveRuns]);

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
    const focusLiveShell = (finishedId: string) => {
      setActiveId((aid) => {
        if (aid !== finishedId) return aid;
        const sh = shellsRef.current;
        return sh.length > 0 ? sh[sh.length - 1].id : aid;
      });
    };
    const syncLiveFromServer = () => {
      void api.agentCommandsLive().then((r) => {
        if (cancelled) return;
        setLiveRuns((cur) => mergeLiveFromServer(cur, r.live));
      }).catch(() => { /* noop */ });
    };
    const sub = api.streamAgentCommands({
      onHello: (_runs, live) => {
        if (cancelled) return;
        if (live.length > 0) {
          setLiveRuns((cur) => mergeLiveFromServer(cur, live));
        } else {
          syncLiveFromServer();
        }
      },
      onRun: (run) => {
        if (cancelled) return;
        if (run.background && run.pid) {
          setLiveRuns((cur) => {
            const existing = cur.find((r) => r.id === run.id);
            const tab = liveTabFromServer(run, existing?.output ?? "");
            return [tab, ...cur.filter((r) => r.id !== run.id)];
          });
          return;
        }
        setLiveRuns((cur) => cur.filter((r) => r.id !== run.id));
        focusLiveShell(run.id);
      },
      onClear: () => {
        if (!cancelled) setLiveRuns([]);
      },
      onDelete: (id) => {
        if (cancelled) return;
        setLiveRuns((cur) => cur.filter((r) => r.id !== id));
        focusLiveShell(id);
      },
      onRunStart: (info) => {
        if (cancelled) return;
        const tab = liveTabFromServer(info);
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
    syncLiveFromServer();
    const poll = window.setInterval(syncLiveFromServer, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
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
      : `⚡ Running: ${activeTab.cmd.length > 40 ? activeTab.cmd.slice(0, 40) + "…" : activeTab.cmd}`
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
                <span>Running <em>{liveRuns.length > 0 ? `(${liveRuns.length})` : ""}</em></span>
              </div>
              {liveRuns.length === 0 && (
                <div className="terminals-section-empty">No commands running</div>
              )}
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
          {activeTab && activeTab.kind === "live" && (
            <LiveTerminalView run={activeTab} />
          )}
        </div>
      </div>
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
    api.killAgentCommand(run.id)
      .then((res) => {
        // pid not registered yet (brief race) — let the user retry instead of
        // leaving the button stuck on "stopping…".
        if (!res.ok && res.reason === "pid-not-ready") setKilling(false);
      })
      .catch((err) => {
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
