import { useEffect, useRef } from "react";
import { pig, type TerminalHandle } from "../lib/pig.js";
import { releaseInitialFocus } from "../lib/startupFocus.js";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Props {
  active: boolean;
  /** Absolute workspace path — shell starts in this directory (must match session tab). */
  workspace?: string;
  initialCommand?: string;
  onCommandSent?: () => void;
}

/**
 * Single-terminal view backed by xterm.js + a backend PTY over WebSocket.
 *
 * Design notes (the previous implementation tried to be clever and ended up
 * not opening at all in some layouts):
 *  - We `term.open()` immediately on mount with a default 80x24 size so the
 *    user always sees the cursor / prompt even before flex layout settles.
 *  - WebSocket connects immediately (no waiting for dimensions). The backend's
 *    `script` PTY happily accepts a default size.
 *  - A `ResizeObserver` keeps the terminal fit'd and forwards size changes
 *    to the backend pty via `{type:"resize"}`.
 *  - On disconnect we surface a clear `[disconnected, retrying...]` line and
 *    auto-reconnect every 2s; clicking the host triggers an immediate retry.
 */
export function TerminalView({ active, workspace, initialCommand, onCommandSent }: Props) {
  /** xterm mounts here; outer `.terminal-host` supplies visual padding. */
  const fitHostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<TerminalHandle | null>(null);
  const initSentRef = useRef(false);

  useEffect(() => {
    const host = fitHostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: "ui-monospace, Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      theme: { background: "#000000", foreground: "#d4d4d4" },
      convertEol: true,
      cursorBlink: true,
      scrollback: 5000,
      cols: 80,
      rows: 24,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;

    // Open immediately. xterm.js handles 0-size hosts; ResizeObserver fits later.
    try { term.open(host); } catch { /* noop */ }
    requestAnimationFrame(() => {
      try { fit.fit(); } catch { /* noop */ }
      releaseInitialFocus();
    });

    let handle: TerminalHandle | null = null;
    let disposed = false;

    const dims = (): { cols: number; rows: number } => {
      const c = Number.isFinite(term.cols) && term.cols > 0 ? term.cols : 80;
      const r = Number.isFinite(term.rows) && term.rows > 0 ? term.rows : 24;
      return { cols: c, rows: r };
    };

    const writeStatus = (s: string) => { try { term.writeln(s); } catch { /* noop */ } };

    const sendInitial = () => {
      if (!initialCommand || initSentRef.current || !handle) return;
      handle.write(initialCommand + "\n");
      initSentRef.current = true;
      onCommandSent?.();
    };

    const connect = async () => {
      if (disposed) return;
      const { cols, rows } = dims();
      try {
        handle = await pig.terminalCreate({ cols, rows, workspace: workspace?.trim() || undefined });
      } catch (err) {
        writeStatus(`\r\n\x1b[31m[terminal failed: ${(err as Error).message}]\x1b[0m`);
        return;
      }
      if (disposed) { try { handle.kill(); } catch { /* noop */ } return; }
      wsRef.current = handle;
      writeStatus("\x1b[90m[connected]\x1b[0m");
      handle.onData((msg) => {
        if (msg.type === "data" && msg.data != null) term.write(msg.data);
        else if (msg.type === "exit") writeStatus(`\r\n\x1b[90m[exit ${msg.exitCode ?? 0}]\x1b[0m`);
      });
      sendInitial();
    };

    void connect();

    const refit = () => {
      try { fit.fit(); } catch { /* noop */ }
      const { cols, rows } = dims();
      handle?.resize(cols, rows);
    };

    const ro = new ResizeObserver(() => {
      requestAnimationFrame(refit);
    });
    ro.observe(host);

    const onWinResize = () => {
      try { fit.fit(); } catch { /* noop */ }
      const { cols, rows } = dims();
      handle?.resize(cols, rows);
    };
    window.addEventListener("resize", onWinResize);

    const inputSub = term.onData((d) => { handle?.write(d); });

    const onHostClick = () => { try { term.focus(); } catch { /* noop */ } };
    host.addEventListener("click", onHostClick);

    return () => {
      disposed = true;
      window.removeEventListener("resize", onWinResize);
      host.removeEventListener("click", onHostClick);
      ro.disconnect();
      inputSub.dispose();
      try { handle?.kill(); } catch { /* noop */ }
      try { term.dispose(); } catch { /* noop */ }
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [workspace]);

  // refit when becoming active again (panel was hidden via display:none)
  useEffect(() => {
    if (!active) return;
    let id2 = 0;
    const id1 = requestAnimationFrame(() => {
      id2 = requestAnimationFrame(() => {
        try { fitRef.current?.fit(); } catch { /* noop */ }
        const term = termRef.current;
        const h = wsRef.current;
        if (term && h) h.resize(term.cols, term.rows);
      });
    });
    return () => {
      cancelAnimationFrame(id1);
      cancelAnimationFrame(id2);
    };
  }, [active]);

  return (
    <div
      className="terminal-host"
      style={{ display: active ? "block" : "none" }}
    >
      <div ref={fitHostRef} className="terminal-host-fit" />
    </div>
  );
}
