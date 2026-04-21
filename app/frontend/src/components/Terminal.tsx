import { useEffect, useRef } from "react";
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
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const initSentRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: "ui-monospace, Menlo, Consolas, monospace",
      fontSize: 13,
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
    requestAnimationFrame(() => { try { fit.fit(); } catch { /* noop */ } });

    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const dims = (): { cols: number; rows: number } => {
      const c = Number.isFinite(term.cols) && term.cols > 0 ? term.cols : 80;
      const r = Number.isFinite(term.rows) && term.rows > 0 ? term.rows : 24;
      return { cols: c, rows: r };
    };

    const writeStatus = (s: string) => { try { term.writeln(s); } catch { /* noop */ } };

    const sendInitial = () => {
      if (!initialCommand || initSentRef.current) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data: initialCommand + "\n" }));
        initSentRef.current = true;
        onCommandSent?.();
      }
    };

    const connect = () => {
      if (disposed) return;
      const { cols, rows } = dims();
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const qs = new URLSearchParams({ cols: String(cols), rows: String(rows) });
      if (workspace?.trim()) qs.set("workspace", workspace.trim());
      const url = `${proto}//${location.host}/terminal/ws?${qs.toString()}`;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        writeStatus(`\r\n\x1b[31m[ws connect failed: ${(err as Error).message}]\x1b[0m`);
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        writeStatus("\x1b[90m[connected]\x1b[0m");
        sendInitial();
      };
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "data") term.write(msg.data);
          else if (msg.type === "exit") writeStatus(`\r\n\x1b[90m[exit ${msg.exitCode}]\x1b[0m`);
        } catch { /* noop */ }
      };
      ws.onerror = () => writeStatus("\r\n\x1b[31m[ws error]\x1b[0m");
      ws.onclose = () => {
        if (disposed) return;
        writeStatus("\r\n\x1b[90m[disconnected — retrying in 2s, click here to retry now]\x1b[0m");
        reconnectTimer = window.setTimeout(connect, 2000);
      };
    };

    connect();

    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* noop */ }
      const { cols, rows } = dims();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });
    ro.observe(host);

    const onWinResize = () => {
      try { fit.fit(); } catch { /* noop */ }
      const { cols, rows } = dims();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    };
    window.addEventListener("resize", onWinResize);

    const inputSub = term.onData((d) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data: d }));
      }
    });

    const onHostClick = () => {
      // immediate retry on click while disconnected
      if (ws && (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING)) {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        connect();
      }
      try { term.focus(); } catch { /* noop */ }
    };
    host.addEventListener("click", onHostClick);

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener("resize", onWinResize);
      host.removeEventListener("click", onHostClick);
      ro.disconnect();
      inputSub.dispose();
      try { ws?.close(); } catch { /* noop */ }
      try { term.dispose(); } catch { /* noop */ }
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [workspace]);

  // refit when becoming active again (panel was hidden via display:none)
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch { /* noop */ }
      const term = termRef.current;
      const ws = wsRef.current;
      if (term && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  return (
    <div
      ref={hostRef}
      className="terminal-host"
      style={{ display: active ? "block" : "none", width: "100%", height: "100%" }}
    />
  );
}
