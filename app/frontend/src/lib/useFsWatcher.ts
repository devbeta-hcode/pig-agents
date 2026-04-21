import { useEffect, useRef } from "react";

export interface FsChange {
  type: "change";
  path: string;
  kind: "rename" | "change";
}

interface FsMessage {
  type: "fs:ready" | "fs:changes";
  changes?: FsChange[];
}

interface Options {
  /** Called for every batch of changes the backend coalesces. */
  onChanges?: (changes: FsChange[]) => void;
  /**
   * Absolute workspace root for this browser tab. Passed as `?workspace=` so
   * the backend watches the correct tree when multiple tabs use different folders.
   */
  workspace?: string;
  /**
   * Coalescing window applied on top of whatever the backend already
   * debounced. Defaults to 150ms — enough to fold a "save 5 files in a row"
   * burst into a single React state bump.
   */
  debounceMs?: number;
  /**
   * If false, the hook does nothing (no socket opened). Used to wait for the
   * workspace to be confirmed before connecting.
   */
  enabled?: boolean;
}

/**
 * Subscribe to backend filesystem-change events over a WebSocket and call
 * `onChanges` whenever something in the workspace tree mutates (file created,
 * renamed, deleted, or modified).
 *
 * Connection lifecycle:
 *   - opens lazily on mount when `enabled` is true
 *   - reconnects with capped exponential backoff on close/error
 *   - closes cleanly on unmount
 *
 * Keep the callback stable (e.g. wrap in useCallback) or pass the latest one
 * via a ref-style callback — the hook intentionally only binds it once.
 */
export function useFsWatcher({ onChanges, workspace, debounceMs = 150, enabled = true }: Options): void {
  // Stash the callback in a ref so consumers can pass an inline function
  // without us tearing down the WebSocket on every re-render.
  const cbRef = useRef(onChanges);
  cbRef.current = onChanges;

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: number | null = null;
    let reconnectDelay = 500;
    let pending: FsChange[] = [];
    let flushTimer: number | null = null;

    function flush() {
      flushTimer = null;
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      try { cbRef.current?.(batch); } catch { /* swallow consumer errors */ }
    }

    function queue(changes: FsChange[]) {
      if (changes.length === 0) return;
      pending.push(...changes);
      if (flushTimer !== null) return;
      flushTimer = window.setTimeout(flush, debounceMs);
    }

    function connect() {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
      const url = `${proto}//${location.host}/fs/watch${qs}`;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        reconnectDelay = 500; // reset backoff on a healthy connect
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        let msg: FsMessage;
        try { msg = JSON.parse(ev.data) as FsMessage; } catch { return; }
        if (msg.type === "fs:changes" && msg.changes) queue(msg.changes);
      };
      ws.onerror = () => { /* `onclose` will run next */ };
      ws.onclose = () => {
        ws = null;
        if (!closed) scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (closed || reconnectTimer !== null) return;
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    connect();

    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      try { ws?.close(); } catch { /* noop */ }
      ws = null;
    };
  }, [enabled, debounceMs, workspace]);
}
