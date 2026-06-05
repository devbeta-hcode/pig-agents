import { useCallback, useEffect, useRef, useState } from "react";
import type { ElectronWebviewElement } from "../webview.js";
import type { BrowserElementPickDetail } from "../lib/browserElementRefs.js";
import { pig, type BrowserState } from "../lib/pig.js";
import {
  IconArrowLeft,
  IconArrowRight,
  IconBug,
  IconGlobe,
  IconLock,
  IconMoreHorizontal,
  IconRotateCw,
  IconSelectElement,
  IconX,
  IconZoomIn,
  IconZoomOut,
} from "./Icons";

interface BrowserPanelProps {
  onAddToChat?: (text: string) => void;
  /** Page screenshot attachment (camera toolbar). */
  onAddPageImage?: (dataUrl: string) => void;
  onAddElementToChat?: (pick: BrowserElementPickDetail) => void;
}

const HOME = "https://viewrp.com/";
const WEBVIEW_PREFS = "contextIsolation=yes,sandbox=yes,nodeIntegration=no";

export default function BrowserPanel({
  onAddToChat,
  onAddPageImage,
  onAddElementToChat,
}: BrowserPanelProps) {
  const webviewRef = useRef<ElectronWebviewElement | null>(null);
  const guestIdRef = useRef<number | null>(null);
  const registeredGuestIdRef = useRef<number | null>(null);
  const registerInFlightRef = useRef(false);
  const initialNavDoneRef = useRef(false);
  const inspectMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inspectingRef = useRef(false);
  const moreOpenRef = useRef(false);
  const urlRef = useRef(HOME);
  const agentActivatingRef = useRef(false);

  const [state, setState] = useState<BrowserState>({
    url: "",
    title: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
  });
  const [urlInput, setUrlInput] = useState(HOME);
  const [ready, setReady] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectMsg, setInspectMsg] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [pageZoomPct, setPageZoomPct] = useState(100);
  const [pageShot, setPageShot] = useState<string | null>(null);
  const [overlayHidden, setOverlayHidden] = useState(false);
  const freezeClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const moreWrapRef = useRef<HTMLDivElement | null>(null);
  const moreDropdownRef = useRef<HTMLDivElement | null>(null);

  inspectingRef.current = inspecting;
  moreOpenRef.current = moreOpen;
  urlRef.current = state.url || urlInput;

  const webviewHidden = overlayHidden || moreOpen;

  const registerGuest = useCallback(async (el: ElectronWebviewElement) => {
    if (registerInFlightRef.current) return;
    let id: number;
    try {
      id = el.getWebContentsId();
    } catch {
      return;
    }
    if (registeredGuestIdRef.current === id) return;

    registerInFlightRef.current = true;
    try {
      guestIdRef.current = id;
      const s = await pig.browserRegisterGuest(id);
      registeredGuestIdRef.current = id;
      setState(s);
      if (s.url && s.url !== "about:blank") {
        setUrlInput(s.url);
      }
      setReady(true);
      setError(null);

      // Manual open: load default URL once when the panel is still blank.
      // dom-ready fires on every navigation — never repeat this here.
      const current = s.url || "";
      if (
        !initialNavDoneRef.current &&
        !agentActivatingRef.current &&
        (!current || current === "about:blank")
      ) {
        initialNavDoneRef.current = true;
        const target = urlRef.current.trim() || HOME;
        const ns = await pig.browserNavigate(target);
        setState(ns);
        setUrlInput(ns.url);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      registerInFlightRef.current = false;
    }
  }, []);

  const webviewCleanupRef = useRef<(() => void) | null>(null);

  const onWebviewRef = useCallback(
    (node: ElectronWebviewElement | null) => {
      webviewCleanupRef.current?.();
      webviewCleanupRef.current = null;
      webviewRef.current = node;
      if (!node) return;

      const onDomReady = () => { void registerGuest(node); };
      node.addEventListener("dom-ready", onDomReady);

      webviewCleanupRef.current = () => {
        node.removeEventListener("dom-ready", onDomReady);
        const id = guestIdRef.current;
        if (id != null) void pig.browserUnregisterGuest(id);
        guestIdRef.current = null;
        registeredGuestIdRef.current = null;
        initialNavDoneRef.current = false;
      };
    },
    [registerGuest],
  );

  const showInspectMsg = useCallback((msg: string) => {
    if (inspectMsgTimer.current) clearTimeout(inspectMsgTimer.current);
    setInspectMsg(msg);
    inspectMsgTimer.current = setTimeout(() => setInspectMsg(""), 2500);
  }, []);

  const launchBrowser = useCallback(async () => {
    setError(null);
    setStopped(false);
    try {
      await pig.browserSetVisible(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!stopped) void launchBrowser();
    return () => {
      void pig.browserInspectStop();
      void pig.browserSetVisible(false);
      const id = guestIdRef.current;
      if (id != null) void pig.browserUnregisterGuest(id);
      if (inspectMsgTimer.current) clearTimeout(inspectMsgTimer.current);
    };
  }, [launchBrowser, stopped]);

  useEffect(() => () => webviewCleanupRef.current?.(), []);

  useEffect(() => {
    const unsubAgent = pig.onBrowserAgentActivate(() => {
      agentActivatingRef.current = true;
      window.setTimeout(() => {
        agentActivatingRef.current = false;
      }, 4000);
    });
    const unsubState = pig.onBrowserState((s) => {
      setState(s);
      if (s.url && s.url !== "about:blank") setUrlInput(s.url);
    });
    const unsubOverlay = pig.onBrowserOverlaySuppressed(setOverlayHidden);
    return () => {
      unsubAgent();
      unsubState();
      unsubOverlay();
    };
  }, []);

  useEffect(() => {
    const unsubPick = pig.onBrowserInspectPick(({ element, screenshot }) => {
      if (onAddElementToChat) {
        onAddElementToChat({
          path: element.path,
          outerHTML: element.outerHTML,
          url: urlRef.current,
          attributes: element.attributes,
          textContent: element.textContent,
          rect: element.rect,
          computedStyles: element.computedStyles,
          screenshotDataUrl: screenshot ? `data:image/png;base64,${screenshot}` : undefined,
        });
        showInspectMsg("Added to chat ✓");
      }
    });
    const unsubCancel = pig.onBrowserInspectCancel(() => {
      setInspecting(false);
      showInspectMsg("Inspect cancelled");
    });
    return () => {
      unsubPick();
      unsubCancel();
    };
  }, [onAddElementToChat, showInspectMsg]);

  useEffect(() => pig.onBrowserDevTools(setDevtoolsOpen), []);

  useEffect(() => {
    if (!ready || !moreOpen) {
      if (freezeClearTimer.current) clearTimeout(freezeClearTimer.current);
      freezeClearTimer.current = setTimeout(() => setPageShot(null), moreOpen ? 0 : 240);
      return;
    }
    let cancelled = false;
    void pig.browserScreenshot()
      .then(({ data }) => {
        if (cancelled) return;
        if (data) setPageShot(`data:image/png;base64,${data}`);
      })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [moreOpen, ready]);

  useEffect(() => () => {
    if (freezeClearTimer.current) clearTimeout(freezeClearTimer.current);
  }, []);

  const closeMoreMenu = useCallback(() => setMoreOpen(false), []);

  useEffect(() => {
    if (!moreOpen) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (moreWrapRef.current?.contains(t)) return;
      if (moreDropdownRef.current?.contains(t)) return;
      closeMoreMenu();
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [moreOpen, closeMoreMenu]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest(".browser-url-input")) return;
      if (e.key === "F5") {
        e.preventDefault();
        void pig.browserReload().then(setState);
      } else if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        void pig.browserBack().then(setState);
      } else if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        void pig.browserForward().then(setState);
      } else if (e.key === "Escape") {
        if (moreOpenRef.current) {
          e.preventDefault();
          closeMoreMenu();
          return;
        }
        if (inspectingRef.current) {
          e.preventDefault();
          setInspecting(false);
          void pig.browserInspectStop();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeMoreMenu]);

  async function handleNavigate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const s = await pig.browserNavigate(urlInput.trim() || HOME);
      setState(s);
      setUrlInput(s.url);
      void pig.browserFocus();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleAddPageToChat() {
    if (!onAddToChat) return;
    try {
      const { data } = await pig.browserScreenshot();
      const line = state.title ? `[${state.title}](${state.url})` : state.url;
      onAddToChat(`**Page**: ${line}`);
      if (data && onAddPageImage) onAddPageImage(`data:image/png;base64,${data}`);
      showInspectMsg("Page added to chat ✓");
    } catch (err) {
      showInspectMsg((err as Error).message || "Screenshot failed");
    }
  }

  async function toggleInspect() {
    if (inspecting) {
      setInspecting(false);
      setInspectMsg("");
      await pig.browserInspectStop();
      return;
    }
    try {
      setInspecting(true);
      setInspectMsg("");
      await pig.browserInspectStart();
    } catch (err) {
      setInspecting(false);
      showInspectMsg((err as Error).message || "Inspect failed");
    }
  }

  async function toggleDevTools() {
    try {
      const { open } = await pig.browserToggleDevTools();
      setDevtoolsOpen(open);
    } catch (err) {
      showInspectMsg((err as Error).message || "DevTools failed");
    }
  }

  async function handlePageZoom(action: "in" | "out" | "reset") {
    await pig.browserZoom(action);
    setPageZoomPct((z) => {
      if (action === "reset") return 100;
      if (action === "in") return Math.min(300, z + 10);
      return Math.max(30, z - 10);
    });
  }

  async function copyCurrentUrl() {
    const url = state.url || urlInput;
    if (!url) return;
    try {
      await pig.clipboardWrite(url);
      showInspectMsg("URL copied");
    } catch {
      showInspectMsg("Copy failed");
    }
    closeMoreMenu();
  }

  async function clearBrowsing(kind: "history" | "cookies" | "cache") {
    try {
      await pig.browserClearData(kind);
      const label =
        kind === "history" ? "History cleared" : kind === "cookies" ? "Cookies cleared" : "Cache cleared";
      showInspectMsg(label);
    } catch (err) {
      showInspectMsg((err as Error).message || "Clear failed");
    }
    closeMoreMenu();
  }

  async function handleStopBrowser() {
    setInspecting(false);
    setDevtoolsOpen(false);
    await pig.browserInspectStop();
    await pig.browserStop();
    setReady(false);
    setStopped(true);
    setState({ url: "", title: "", loading: false, canGoBack: false, canGoForward: false });
  }

  if (stopped) {
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
            Embedded Chromium is hidden. Launch it to browse inside the editor.
          </p>
          <button type="button" className="browser-install-btn" onClick={() => { void launchBrowser(); }}>
            Launch Browser
          </button>
        </div>
      </div>
    );
  }

  if (error && !ready) {
    return (
      <div className="browser-panel browser-panel--setup">
        <div className="browser-setup-card">
          <p className="browser-error">{error}</p>
          <button type="button" className="browser-install-btn" onClick={() => { setError(null); void launchBrowser(); }}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={panelRef} className="browser-panel browser-panel--active">
      <div className={`browser-progress-bar ${state.loading ? "browser-progress-bar--loading" : ""}`} />

      <div className="browser-toolbar">
        <button
          type="button"
          className="browser-nav-btn"
          title="Back (Alt+←)"
          disabled={!state.canGoBack}
          onClick={() => { void pig.browserBack().then(setState); }}
        >
          <IconArrowLeft size={16} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="browser-nav-btn"
          title="Forward (Alt+→)"
          disabled={!state.canGoForward}
          onClick={() => { void pig.browserForward().then(setState); }}
        >
          <IconArrowRight size={16} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="browser-nav-btn"
          title="Reload (F5)"
          onClick={() => { void pig.browserReload().then(setState); }}
        >
          {state.loading ? <IconX size={15} strokeWidth={1.8} /> : <IconRotateCw size={15} strokeWidth={1.8} />}
        </button>

        <form className="browser-url-form" onSubmit={handleNavigate}>
          <span className="browser-url-icon" aria-hidden>
            {state.url.startsWith("https://")
              ? <IconLock size={12} strokeWidth={1.8} />
              : <IconGlobe size={12} strokeWidth={1.8} />}
          </span>
          <input
            className="browser-url-input"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Enter URL…"
            spellCheck={false}
          />
          {state.loading && <div className="browser-url-spinner" />}
        </form>

        <div className="browser-zoom-inline" role="group" aria-label="Page zoom">
          <button
            type="button"
            className="browser-nav-btn"
            title="Zoom out"
            onClick={() => { void handlePageZoom("out"); }}
          >
            <IconZoomOut size={15} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="browser-zoom-pct"
            title="Reset zoom"
            onClick={() => { void handlePageZoom("reset"); }}
          >
            {pageZoomPct}%
          </button>
          <button
            type="button"
            className="browser-nav-btn"
            title="Zoom in"
            onClick={() => { void handlePageZoom("in"); }}
          >
            <IconZoomIn size={15} strokeWidth={1.8} />
          </button>
        </div>

        <div className="browser-toolbar-tools">
          {onAddElementToChat && (
            <button
              type="button"
              className={`browser-nav-btn${inspecting ? " browser-nav-btn--active" : ""}`}
              title={
                inspecting
                  ? "Select element (on) — click again to turn off"
                  : "Select element — stays on until you click again"
              }
              aria-pressed={inspecting}
              onClick={() => { void toggleInspect(); }}
            >
              <IconSelectElement size={15} strokeWidth={1.8} />
            </button>
          )}
          <button
            type="button"
            className={`browser-nav-btn${devtoolsOpen ? " browser-nav-btn--active" : ""}`}
            title="Toggle DevTools (debug page)"
            aria-pressed={devtoolsOpen}
            onClick={() => { void toggleDevTools(); }}
          >
            <IconBug size={15} strokeWidth={1.8} />
          </button>
          <div className="browser-more-wrap" ref={moreWrapRef}>
            <button
              type="button"
              className={`browser-nav-btn${moreOpen ? " browser-nav-btn--active" : ""}`}
              title="More browser actions"
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              onClick={() => setMoreOpen((o) => !o)}
            >
              <IconMoreHorizontal size={16} strokeWidth={2} />
            </button>
            {moreOpen && (
              <div ref={moreDropdownRef} className="browser-more-menu" role="menu">
                <button
                  type="button"
                  className="browser-more-item"
                  role="menuitem"
                  disabled={!onAddToChat}
                  onClick={() => {
                    if (!onAddToChat) return;
                    closeMoreMenu();
                    void handleAddPageToChat();
                  }}
                >
                  Take Screenshot
                </button>
                <button type="button" className="browser-more-item" role="menuitem" disabled title="Coming soon">
                  Capture Area Screenshot
                </button>
                <div className="browser-more-sep" />
                <button
                  type="button"
                  className="browser-more-item"
                  role="menuitem"
                  onClick={() => {
                    closeMoreMenu();
                    void pig.browserHardReload().then(setState);
                  }}
                >
                  Hard Reload
                </button>
                <button
                  type="button"
                  className="browser-more-item"
                  role="menuitem"
                  onClick={() => { void copyCurrentUrl(); }}
                >
                  Copy Current URL
                </button>
                <div className="browser-more-sep" />
                <button
                  type="button"
                  className="browser-more-item"
                  role="menuitem"
                  onClick={() => { void clearBrowsing("history"); }}
                >
                  Clear Browsing History
                </button>
                <button
                  type="button"
                  className="browser-more-item"
                  role="menuitem"
                  onClick={() => { void clearBrowsing("cookies"); }}
                >
                  Clear Cookies
                </button>
                <button
                  type="button"
                  className="browser-more-item"
                  role="menuitem"
                  onClick={() => { void clearBrowsing("cache"); }}
                >
                  Clear Cache
                </button>
                <div className="browser-more-sep" />
                <button
                  type="button"
                  className="browser-more-item browser-more-item--danger"
                  role="menuitem"
                  onClick={() => { closeMoreMenu(); void handleStopBrowser(); }}
                >
                  Hide Browser
                </button>
              </div>
            )}
          </div>
        </div>
      </div>


      <div
        className={`browser-viewport${inspecting ? " browser-viewport--inspect" : ""}${ready ? " browser-viewport--live" : ""}`}
        title={ready ? state.title || state.url : "Loading browser…"}
      >
        {pageShot && moreOpen && (
          <img className="browser-frozen-shot" src={pageShot} alt="" draggable={false} />
        )}
        {!ready && (
          <div className="browser-connecting">
            <div className="browser-install-spinner" />
            <span>Starting embedded browser…</span>
          </div>
        )}
        <webview
          ref={onWebviewRef}
          className={`browser-webview${webviewHidden ? " browser-webview--hidden" : ""}`}
          src="about:blank"
          partition="persist:pig-browser"
          allowpopups=""
          webpreferences={WEBVIEW_PREFS}
        />
        {(inspecting || inspectMsg) && (
          <div className={`browser-inspect-banner${inspectMsg && !inspecting ? " browser-inspect-banner--msg" : ""}`}>
            {inspecting
              ? "Select mode on — click elements to add to Chat · click the select icon again to turn off · Esc to exit"
              : inspectMsg}
          </div>
        )}
      </div>
    </div>
  );
}
