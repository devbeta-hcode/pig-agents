import { useEffect, useRef, useState, useCallback } from "react";
import {
  IconArrowLeft, IconArrowRight, IconRotateCw, IconX,
  IconLock, IconGlobe, IconZoomIn, IconZoomOut, IconMaximize2,
  IconMessagePlus, IconMousePointer,
} from "./Icons";

interface BrowserStatus {
  installed: boolean;
  running: boolean;
  url: string;
}

interface ElementInfo {
  outerHTML: string;
  path: string;
  attributes: Record<string, string>;
  textContent: string;
  rect: { top: number; left: number; width: number; height: number };
  computedStyles: Record<string, string>;
}

interface BrowserPanelProps {
  onAddToChat?: (text: string) => void;
  /** When set, called with element HTML + cropped image data URL when user selects an element in inspect mode. */
  onAddElementToChat?: (html: string, imageDataUrl: string) => void;
}

type ConnState = "connecting" | "connected" | "disconnected";

// Playwright key names for special keys
const SPECIAL_KEYS: Record<string, string> = {
  Enter: "Enter", Backspace: "Backspace", Delete: "Delete", Tab: "Tab",
  Escape: "Escape", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Home: "Home",
  End: "End", PageUp: "PageUp", PageDown: "PageDown",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5",
  F6: "F6", F7: "F7", F8: "F8", F9: "F9", F10: "F10",
  F11: "F11", F12: "F12",
};

export default function BrowserPanel({ onAddToChat, onAddElementToChat }: BrowserPanelProps) {
  const [status, setStatus] = useState<BrowserStatus>({ installed: false, running: false, url: "" });
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [loading, setLoading] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [selectedEl, setSelectedEl] = useState<ElementInfo | null>(null);
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);
  const [hoverScreen, setHoverScreen] = useState<{ x: number; y: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [installingDeps, setInstallingDeps] = useState(false);
  const [viewportFocused, setViewportFocused] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [inspectMsg, setInspectMsg] = useState<string>("");
  const inspectMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStartAfterInstall = useRef(false);
  const handleStartRef = useRef<() => Promise<void>>();

  const imgRef = useRef<HTMLImageElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScroll = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);

  // ── fetch initial status ──────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/browser/status")
      .then((r) => r.json())
      .then((s: BrowserStatus) => {
        setStatus(s);
        setCurrentUrl(s.url ?? "");
        setUrlInput(s.url ?? "");
      })
      .catch(() => { /* backend may not be up yet */ });
  }, []);

  // ── WebSocket connection ──────────────────────────────────────────────────
  useEffect(() => {
    let ws: WebSocket;
    let dead = false;

    function connect() {
      if (dead) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${window.location.host}/browser/ws`);
      wsRef.current = ws;
      setConnState("connecting");

      ws.onopen = () => setConnState("connected");

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);

          if (msg.type === "frame" && imgRef.current) {
            imgRef.current.src = `data:image/jpeg;base64,${msg.data}`;
            setLoading(false);
          } else if (msg.type === "navigate") {
            setCurrentUrl(msg.url ?? "");
            setUrlInput(msg.url ?? "");
          } else if (msg.type === "status") {
            if (msg.status === "loading") setLoading(true);
            if (msg.status === "idle") setLoading(false);
            if (typeof msg.installed === "boolean") {
              setStatus((s) => ({ ...s, installed: msg.installed }));
            }
            if (typeof msg.running === "boolean") {
              setStatus((s) => ({ ...s, running: msg.running }));
            }
          } else if (msg.type === "install_progress") {
            setInstallLog((l) => [...l.slice(-100), msg.line]);
          } else if (msg.type === "install_done") {
            setInstalling(false);
            setInstallingDeps(false);
            setInstallLog((l) => [...l, msg.message]);
            if (msg.success) {
              setStatus((s) => ({ ...s, installed: true }));
              if (pendingStartAfterInstall.current) {
                pendingStartAfterInstall.current = false;
                setTimeout(() => handleStartRef.current?.(), 1500);
              }
            }
          }
        } catch { /* malformed */ }
      };

      ws.onclose = () => {
        setConnState("disconnected");
        if (!dead) setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      dead = true;
      ws?.close();
    };
  }, []);

  // ── helpers ───────────────────────────────────────────────────────────────
  async function post(path: string, body?: object) {
    const r = await fetch(`/api/browser${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  }

  function scaleCoords(e: React.MouseEvent<HTMLImageElement>) {
    const rect = imgRef.current!.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * 1280),
      y: Math.round(((e.clientY - rect.top) / rect.height) * 800),
    };
  }

  function handleInstall() {
    setInstalling(true);
    setInstallLog([]);
    post("/install");
  }

  function handleInstallDeps() {
    setInstallingDeps(true);
    setStartError("");
    setInstallLog([]);
    pendingStartAfterInstall.current = true;
    post("/install");
  }

  async function handleStart() {
    setStartError("");
    setStarting(true);
    const r = await post("/start");
    setStarting(false);
    if (r.ok) {
      setStatus((s) => ({ ...s, running: true }));
    } else {
      setStartError(r.error ?? "Failed to start browser");
    }
  }
  handleStartRef.current = handleStart;

  function showInspectMsg(msg: string) {
    if (inspectMsgTimer.current) clearTimeout(inspectMsgTimer.current);
    setInspectMsg(msg);
    inspectMsgTimer.current = setTimeout(() => setInspectMsg(""), 2500);
  }

  async function handleNavigate(e: React.FormEvent) {
    e.preventDefault();
    if (!urlInput.trim()) return;
    setLoading(true);
    await post("/navigate", { url: urlInput.trim() });
    viewportRef.current?.focus();
  }

  // ── viewport interaction ──────────────────────────────────────────────────
  async function handleImgClick(e: React.MouseEvent<HTMLImageElement>) {
    if (!imgRef.current) return;
    const { x, y } = scaleCoords(e);
    viewportRef.current?.focus();
    if (inspecting) {
      setInspecting(false);
      try {
        const r = await post("/inspect", { x, y });
        if (r.ok && r.element && onAddElementToChat) {
          const el = r.element as ElementInfo;
          const html = `**Element**: \`${el.path}\`\n\n\`\`\`html\n${el.outerHTML.slice(0, 800)}\n\`\`\`\n\n**URL**: ${currentUrl}`;
          const imgDataUrl = r.screenshot ? `data:image/png;base64,${r.screenshot}` : "";
          onAddElementToChat(html, imgDataUrl);
          showInspectMsg("Element added to chat ✓");
        } else {
          showInspectMsg(r.error ?? "No element found at this position");
        }
      } catch {
        showInspectMsg("Inspect failed — check browser connection");
      }
      return;
    }
    const r = await post("/click", { x, y });
    if (r.element) setSelectedEl(r.element);
  }

  function handleImgMouseMove(e: React.MouseEvent<HTMLImageElement>) {
    if (!imgRef.current) return;
    const { x, y } = scaleCoords(e);
    setHoverScreen({ x: e.clientX, y: e.clientY });

    // Debounce hover label fetch (100ms)
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(async () => {
      const r = await post("/hover", { x, y });
      setHoverLabel(r.label ?? null);
    }, 100);
  }

  function handleWheel(e: React.WheelEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 1280);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 800);

    // Batch scroll events within 16ms
    if (pendingScroll.current) {
      pendingScroll.current.dx += e.deltaX;
      pendingScroll.current.dy += e.deltaY;
    } else {
      pendingScroll.current = { x, y, dx: e.deltaX, dy: e.deltaY };
    }
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      const s = pendingScroll.current!;
      pendingScroll.current = null;
      post("/scroll", { x: s.x, y: s.y, deltaX: s.dx, deltaY: s.dy });
    }, 16);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Don't intercept when url bar is focused
    if ((e.target as HTMLElement).tagName === "INPUT") return;

    // Escape cancels inspect mode without forwarding the key
    if (e.key === "Escape" && inspecting) {
      e.preventDefault();
      setInspecting(false);
      return;
    }

    const special = SPECIAL_KEYS[e.key];
    if (special) {
      e.preventDefault();
      // Build modifier combo e.g. "Control+a"
      const mods = [
        e.ctrlKey ? "Control" : "",
        e.metaKey ? "Meta" : "",
        e.shiftKey ? "Shift" : "",
        e.altKey ? "Alt" : "",
      ].filter(Boolean);
      const combo = mods.length ? `${mods.join("+")}+${special}` : special;
      post("/key", { key: combo });
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      post("/type", { text: e.key });
    }
  }

  const handleAddPageToChat = useCallback(async () => {
    if (!onAddToChat && !onAddElementToChat) return;
    const r = await fetch("/api/browser/screenshot");
    const data = await r.json();
    const text = `**Page**: ${currentUrl}`;
    const imageDataUrl = data.data ? `data:image/png;base64,${data.data}` : "";
    if (onAddElementToChat) {
      onAddElementToChat(text, imageDataUrl);
    } else {
      onAddToChat!(text);
    }
  }, [currentUrl, onAddToChat, onAddElementToChat]);

  const handleAddToChat = useCallback(() => {
    if (!selectedEl || !onAddToChat) return;
    const text = `**Element**: \`${selectedEl.path}\`\n\n**HTML:**\n\`\`\`html\n${selectedEl.outerHTML}\n\`\`\`\n\n**URL**: ${currentUrl}`;
    onAddToChat(text);
    setSelectedEl(null);
  }, [selectedEl, currentUrl, onAddToChat]);

  // ── render ────────────────────────────────────────────────────────────────
  if (!status.installed) {
    return (
      <div className="browser-panel browser-panel--setup">
        <div className="browser-setup-card">
          <div className="browser-setup-icon">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          </div>
          <h2>Built-in Browser</h2>
          <p className="browser-setup-desc">
            Playwright Chromium is not installed yet. Install it to enable the built-in browser panel.
          </p>
          {!installing ? (
            <button className="browser-install-btn" onClick={handleInstall}>
              Install Playwright Chromium
            </button>
          ) : (
            <div className="browser-install-progress">
              <div className="browser-install-spinner" />
              <span>Installing…</span>
              {installLog.length > 0 && (
                <pre className="browser-install-log">
                  {installLog.slice(-20).join("\n")}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!status.running) {
    return (
      <div className="browser-panel browser-panel--setup">
        <div className="browser-setup-card">
          <div className="browser-setup-icon">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          </div>
          <h2>Built-in Browser</h2>
          <p className="browser-setup-desc">
            Playwright is installed. Launch the browser to start browsing.
          </p>
          {startError && (
            <>
              <p className="browser-error">{startError.slice(0, 300)}{startError.length > 300 ? "…" : ""}</p>
              {/shared libraries|libatk|libnss|libgbm|libxcb|cannot open shared/i.test(startError) && (
                installingDeps ? (
                  <div className="browser-install-progress">
                    <div className="browser-install-spinner" />
                    <span>Installing system dependencies…</span>
                    {installLog.length > 0 && (
                      <pre className="browser-install-log">{installLog.slice(-15).join("\n")}</pre>
                    )}
                  </div>
                ) : (
                  <button className="browser-install-btn" onClick={handleInstallDeps}>
                    Install System Dependencies
                  </button>
                )
              )}
            </>
          )}
          {!installingDeps && (
            <button className="browser-install-btn" onClick={handleStart} disabled={starting} style={startError ? { marginTop: 8 } : undefined}>
              {starting ? "Launching…" : "Launch Browser"}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="browser-panel browser-panel--active">
      {/* ── loading bar ── */}
      <div className={`browser-progress-bar ${loading ? "browser-progress-bar--loading" : ""}`} />

      {/* ── toolbar ── */}
      <div className="browser-toolbar">
        {/* navigation */}
        <button className="browser-nav-btn" title="Back (Alt+←)" onClick={() => post("/back")}>
          <IconArrowLeft size={15} strokeWidth={2.2} />
        </button>
        <button className="browser-nav-btn" title="Forward (Alt+→)" onClick={() => post("/forward")}>
          <IconArrowRight size={15} strokeWidth={2.2} />
        </button>
        <button className="browser-nav-btn" title="Reload (F5)" onClick={() => { setLoading(true); post("/reload"); }}>
          {loading ? <IconX size={14} strokeWidth={2.2} /> : <IconRotateCw size={15} strokeWidth={2.2} />}
        </button>

        {/* url bar */}
        <form className="browser-url-form" onSubmit={handleNavigate}>
          {/* lock/globe icon */}
          <span className="browser-url-icon" aria-hidden>
            {currentUrl.startsWith("https://")
              ? <IconLock size={11} strokeWidth={1.8} />
              : <IconGlobe size={11} strokeWidth={1.6} />
            }
          </span>
          <input
            className="browser-url-input"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Enter URL…"
            spellCheck={false}
          />
          {loading && <div className="browser-url-spinner" />}
        </form>

        {/* action buttons */}
        <div className="browser-toolbar-actions">
          {onAddToChat && (
            <button className="browser-nav-btn browser-nav-btn--accent" title="Add page to Chat" onClick={handleAddPageToChat}>
              <IconMessagePlus size={14} strokeWidth={2} />
            </button>
          )}
          {onAddElementToChat && (
            <button
              className={`browser-nav-btn${inspecting ? " browser-nav-btn--accent" : ""}`}
              title={inspecting ? "Click on an element to select it (Esc to cancel)" : "Select element to chat"}
              onClick={() => setInspecting((v) => !v)}
            >
              <IconMousePointer size={14} strokeWidth={2} />
            </button>
          )}
          <button className="browser-nav-btn" title="Zoom in" onClick={() => post("/eval", { js: "document.body.style.zoom = (parseFloat(document.body.style.zoom||'1')+0.1).toFixed(1)" })}>
            <IconZoomIn size={14} strokeWidth={2} />
          </button>
          <button className="browser-nav-btn" title="Zoom out" onClick={() => post("/eval", { js: "document.body.style.zoom = Math.max(0.3,(parseFloat(document.body.style.zoom||'1')-0.1)).toFixed(1)" })}>
            <IconZoomOut size={14} strokeWidth={2} />
          </button>
          <button className="browser-nav-btn" title="Reset zoom" onClick={() => post("/eval", { js: "document.body.style.zoom='1'" })}>
            <IconMaximize2 size={13} strokeWidth={2} />
          </button>
          <div className="browser-toolbar-sep" />
          <button className="browser-nav-btn browser-nav-btn--danger" title="Close browser" onClick={async () => {
            await post("/stop");
            setStatus((s) => ({ ...s, running: false }));
          }}>
            <IconX size={14} strokeWidth={2.2} />
          </button>
        </div>
      </div>

      {/* ── viewport ── */}
      <div
        ref={viewportRef}
        className={`browser-viewport ${viewportFocused ? "browser-viewport--focused" : ""}`}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onWheel={handleWheel}
        onFocus={() => setViewportFocused(true)}
        onBlur={() => setViewportFocused(false)}
        onMouseLeave={() => { setHoverLabel(null); setHoverScreen(null); }}
        style={{ outline: "none" }}
      >
        {connState !== "connected" ? (
          <div className="browser-connecting">
            <div className="browser-install-spinner" />
            <span>Connecting…</span>
          </div>
        ) : (
          <img
            ref={imgRef}
            className="browser-screencast"
            alt="Browser screencast"
            draggable={false}
            style={{ cursor: inspecting ? "crosshair" : "default" }}
            onClick={handleImgClick}
            onMouseMove={handleImgMouseMove}
          />
        )}
        {/* hover label tooltip */}
        {hoverLabel && hoverScreen && (
          <div
            className="browser-hover-tip"
            style={{ left: hoverScreen.x + 12, top: hoverScreen.y + 16, position: "fixed" }}
          >
            {hoverLabel}
          </div>
        )}
        {/* focus ring hint */}
        {!viewportFocused && !inspecting && connState === "connected" && (
          <div className="browser-focus-hint">Click to focus · then type</div>
        )}
        {/* inspect mode banner / feedback */}
        {(inspecting || inspectMsg) && (
          <div className={`browser-inspect-banner${inspectMsg && !inspecting ? " browser-inspect-banner--msg" : ""}`}>
            {inspecting ? "Click on an element to send it to Chat · Esc to cancel" : inspectMsg}
          </div>
        )}
      </div>

      {/* ── element inspector ── */}
      {selectedEl && (
        <div className="browser-inspector">
          <div className="browser-inspector-header">
            <span className="browser-inspector-path">{selectedEl.path}</span>
            <div className="browser-inspector-actions">
              {onAddToChat && (
                <button className="browser-inspector-btn" onClick={handleAddToChat} title="Add element context to chat">
                  Add to Chat
                </button>
              )}
              <button className="browser-inspector-close" onClick={() => setSelectedEl(null)} title="Dismiss">✕</button>
            </div>
          </div>
          {selectedEl.textContent && (
            <div className="browser-inspector-text">{selectedEl.textContent.slice(0, 120)}</div>
          )}
          <pre className="browser-inspector-html">{selectedEl.outerHTML.slice(0, 500)}</pre>
        </div>
      )}
    </div>
  );
}
