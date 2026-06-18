import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { FileTree } from "./components/FileTree";
import { FileEditor, invalidateEditorCache, isPathDirtyInBuffer, type FileEditorHandle } from "./components/Editor";
import { Terminals, type TerminalsHandle } from "./components/Terminals";
import { Chat } from "./components/Chat";
import { type DiffItem } from "./components/DiffViewer";
import { DiffEditorView } from "./components/DiffEditorView";
import { SearchPanel } from "./components/SearchPanel";
import { FolderPicker } from "./components/FolderPicker";
import { SettingsModal } from "./components/SettingsModal";
import { FileIcon } from "./components/FileIcon";
import { EditorWelcome } from "./components/EditorWelcome";
import { GitPanel } from "./components/GitPanel";
import { WorkspaceManager } from "./components/WorkspaceManager";
import BrowserPanel from "./components/BrowserPanel";
import { WindowControls } from "./components/WindowControls";
import { useDialogs } from "./components/DialogProvider";
import {
  IconX, IconCheck, IconRotateCcw, IconRefreshCw, IconSettings,
  IconTerminal, IconFolderOpen, IconSearch, IconEye, IconDot,
} from "./components/Icons";
import { api, getSessionWorkspace, setSessionWorkspace, type SettingsPayload, type ChatSessionMeta } from "./lib/api";
import {
  isChatNotFoundError,
  readChatBootstrap,
  rpcWithRetry,
  writeChatBootstrap,
} from "./lib/chatBootstrap";
import { pig } from "./lib/pig.js";
import { useBrowserOverlayGuard } from "./lib/useBrowserOverlayGuard.js";
import { dispatchBrowserElementPick } from "./lib/browserElementPick.js";
import type { BrowserElementPickDetail } from "./lib/browserElementRefs.js";
import { newSession, type ChatSession } from "./lib/sessions";
import { pushRecent } from "./lib/recents";
import { useFsWatcher } from "./lib/useFsWatcher";
import { tabAffectedByDelete } from "./lib/tabPaths";
import { useVisibleInterval } from "./lib/useVisibleInterval";
import { useReleaseInitialFocus } from "./lib/startupFocus";
import { useUiZoomShortcuts } from "./lib/useUiZoom";
import { revertTargetFileMissing } from "./lib/diffErrors";
import { diffPathFromUnified, mergeUnifiedDiffs, normalizeDiffPath } from "./lib/diffMerge";

type ActivityView = "explorer" | "search" | "source";
const BROWSER_TAB_PATH = "__browser__";
type BottomTab = "terminal";

/**
 * Drop a single hunk from a unified diff string, returning the new diff (or
 * `null` if no hunks remain — in which case the caller should delete the
 * DiffItem entirely).
 *
 * When `shiftRest` is true (per-hunk UNDO), the file's "after" line numbers
 * shift because the on-disk file shrank/grew by `oldLines - newLines` of the
 * removed hunk; we patch the `+start` of every subsequent hunk header so the
 * remaining inline highlights still line up with disk content.
 */
function removeHunkFromDiff(diff: string, hunkIndex: number, shiftRest: boolean): string | null {
  const lines = diff.split("\n");
  const headerRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  // 1) Locate hunk boundaries in the line array.
  const hunkStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) hunkStarts.push(i);
  }
  if (hunkIndex < 0 || hunkIndex >= hunkStarts.length) return diff;

  const removeStart = hunkStarts[hunkIndex];
  const removeEnd = hunkIndex + 1 < hunkStarts.length ? hunkStarts[hunkIndex + 1] : lines.length;

  const removedHeader = headerRe.exec(lines[removeStart])!;
  const oldLines = removedHeader[2] ? parseInt(removedHeader[2], 10) : 1;
  const newLines = removedHeader[4] ? parseInt(removedHeader[4], 10) : 1;
  const shift = shiftRest ? oldLines - newLines : 0;

  const kept = [...lines.slice(0, removeStart), ...lines.slice(removeEnd)];

  if (shift !== 0) {
    for (let i = 0; i < kept.length; i++) {
      const m = headerRe.exec(kept[i]);
      if (!m) continue;
      // Only shift hunks that originally lived AFTER the removed one.
      const newStart = parseInt(m[3], 10);
      const removedNewStart = parseInt(removedHeader[3], 10);
      if (newStart > removedNewStart) {
        const shiftedStart = newStart + shift;
        const oldPart = m[2] ? `,${m[2]}` : "";
        const newPart = m[4] ? `,${m[4]}` : "";
        kept[i] = `@@ -${m[1]}${oldPart} +${shiftedStart}${newPart} @@${kept[i].slice(m[0].length)}`;
      }
    }
  }

  // Detect whether any hunk headers remain.
  const stillHasHunk = kept.some((l) => headerRe.test(l));
  if (!stillHasHunk) return null;
  return kept.join("\n");
}

interface OpenTab {
  path: string;
  dirty: boolean;
  gotoLine?: number;
  gotoNonce?: number;
  // For diff tabs we keep the patch payload + an id, and prefix the path
  // with "diff:<id>:" so it gets its own tab even when the file tab is also
  // open. The display path stays clean via `displayPath`.
  kind?: "file" | "diff" | "browser";
  diff?: string;
  diffId?: string;
  displayPath?: string;
}

function initialWorkspacePath(): string {
  const saved = getSessionWorkspace();
  if (saved) return saved;
  try {
    return localStorage.getItem("pig-agents.ws.path.v1") || "";
  } catch {
    return "";
  }
}

function initialChatFromBootstrap(ws: string): {
  chatList: ChatSessionMeta[];
  activeSessionId: string;
  activeSession: ChatSession | null;
} {
  if (!ws) return { chatList: [], activeSessionId: "", activeSession: null };
  const boot = readChatBootstrap(ws);
  if (!boot) return { chatList: [], activeSessionId: "", activeSession: null };
  return {
    chatList: boot.chatList,
    activeSessionId: boot.activeSessionId,
    activeSession: boot.activeSession,
  };
}

function shellSessionFromMeta(meta: ChatSessionMeta, ws: string): ChatSession {
  return {
    id: meta.id,
    title: meta.title,
    workspace: ws,
    mode: meta.mode,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    turns: [],
    pendingDiffs: [],
  };
}

export default function App() {
  useReleaseInitialFocus();
  useUiZoomShortcuts();
  const [winMaximized, setWinMaximized] = useState(false);
  useEffect(() => {
    void pig.windowIsMaximized().then(setWinMaximized);
    return pig.onWindowMaximized(setWinMaximized);
  }, []);
  const dlg = useDialogs();
  const initialWs = initialWorkspacePath();
  const [workspace, setWorkspace] = useState<string>(initialWs);
  /** Main process has confirmed workspace via IPC (avoids listFiles before setWorkspace). */
  const [workspaceReady, setWorkspaceReady] = useState(!initialWs);
  const [view, setView] = useState<ActivityView>("explorer");
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const tabsRef = useRef<OpenTab[]>([]);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  const [active, setActive] = useState<string | undefined>(undefined);
  const [tabDragPath, setTabDragPath] = useState<string | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{ path: string; before: boolean } | null>(null);
  const [diffs, setDiffs] = useState<DiffItem[]>([]);
  /** Kept in sync with `diffs` for chat PUT payloads (flushSave / updateSession). */
  const diffsRef = useRef<DiffItem[]>([]);
  useEffect(() => { diffsRef.current = diffs; }, [diffs]);
  const [refreshKey, setRefreshKey] = useState(0);
  /** Per-file disk reload (revert hunk, etc.) — must not reload unrelated open tabs. */
  const [editorReloadPath, setEditorReloadPath] = useState<string | null>(null);
  const [editorReloadSeq, setEditorReloadSeq] = useState(0);
  // Count of changed files (staged + unstaged + untracked) used to render the
  // little badge on the Source Control activity-bar button. Polled in the
  // background so the badge updates even when the panel itself is not open.
  const [gitChangeCount, setGitChangeCount] = useState(0);

  // Chat history is now backend-backed. We keep:
  //   - `chatList` : lightweight metadata for the sidebar (cheap to render)
  //   - `activeSession` : the full session (turns + events), loaded on demand
  // Saving is debounced so streaming agent events don't hammer the disk.
  const initialChatBootRef = useRef(initialChatFromBootstrap(initialWorkspacePath()));
  const initialChatBoot = initialChatBootRef.current;
  const [chatList, setChatList] = useState<ChatSessionMeta[]>(initialChatBoot.chatList);
  const chatListRef = useRef<ChatSessionMeta[]>([]);
  useEffect(() => {
    chatListRef.current = chatList;
  }, [chatList]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(initialChatBoot.activeSession);
  const [activeSessionId, setActiveSessionId] = useState<string>(initialChatBoot.activeSessionId);
  const sessionCacheRef = useRef<Map<string, ChatSession>>(new Map());
  const chatLoadGenRef = useRef(0);
  const prevWorkspaceRef = useRef("");
  useEffect(() => {
    if (initialChatBoot.activeSession) {
      sessionCacheRef.current.set(initialChatBoot.activeSession.id, initialChatBoot.activeSession);
    }
  }, []);
  const saveTimerRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<ChatSession | null>(null);
  /** Block debounced saves for sessions the user deleted (prevents ghost index rows). */
  const deletedChatIdsRef = useRef<Set<string>>(new Set());
  // Coalesce parent re-renders during agent runs. SSE pushes many `action`
  // events per second; calling `setActiveSession` (and resorting `chatList`)
  // synchronously on every one of them re-renders the entire App tree
  // (FileTree, Editor, Terminals, …) and freezes the UI. We accumulate the
  // latest session into a ref and let rAF flush at most once per frame.
  const pendingActiveSessionRef = useRef<ChatSession | null>(null);
  const activeSessionRafRef = useRef<number | null>(null);

  const [pickerOpen, setPickerOpen] = useState(() => !initialWorkspacePath());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [pendingChatInject, setPendingChatInject] = useState<string>("");
  const [pendingChatImage, setPendingChatImage] = useState<string>("");
  // Bumped whenever a file is opened so the welcome screen re-reads the
  // recents list from localStorage without us needing to lift it into state.
  const [recentsVersion, setRecentsVersion] = useState(0);

  const terminalsRef = useRef<TerminalsHandle | null>(null);
  const bottomPanelRef = useRef<ImperativePanelHandle | null>(null);
  const editorRef = useRef<FileEditorHandle | null>(null);
  const [bottomCollapsed, setBottomCollapsed] = useState(false);

  function toggleBottom() {
    const p = bottomPanelRef.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand();
    else p.collapse();
  }
  function showBottom(_tab: BottomTab) {
    const p = bottomPanelRef.current;
    if (p && p.isCollapsed()) p.expand();
  }

  // One-time migration: older builds persisted the panel layout under
  // `react-resizable-panels:ba-main-v2` / `ba-center-v2`. A stored value below
  // a panel's `minSize` could leak through (the lib didn't always re-clamp on
  // load), squashing the chat panel down to ~50px and letting it bleed off
  // the right edge of the viewport. We've bumped the autoSaveId to v3; nuke
  // the v2 keys so anyone with stale state automatically gets the sane
  // defaults instead of having to find the "Reset layout" button.
  useEffect(() => {
    try {
      const flag = "pig-agents.layout-migration.v3";
      if (localStorage.getItem(flag) === "1") return;
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("react-resizable-panels:ba-main-v2") ||
          k.startsWith("react-resizable-panels:ba-center-v2")) {
          localStorage.removeItem(k);
        }
      }
      localStorage.setItem(flag, "1");
    } catch { /* private mode / quota — non-fatal */ }
  }, []);

  // Restore workspace + sync to main before any filesystem RPC.
  useEffect(() => {
    let cancelled = false;
    void api.getSettings().then(setSettings).catch(() => { /* noop */ });

    const saved = getSessionWorkspace();
    const savedPath =
      saved ||
      (() => {
        try {
          return localStorage.getItem("pig-agents.ws.path.v1") || "";
        } catch {
          return "";
        }
      })();

    if (!savedPath) {
      setPickerOpen(true);
      setWorkspaceReady(true);
      return;
    }

    if (!saved) setSessionWorkspace(savedPath);
    setWorkspace((cur) => cur || savedPath);
    setPickerOpen(false);
    setWorkspaceReady(false);

    void (async () => {
      try {
        const r = await api.setWorkspace(savedPath);
        if (cancelled) return;
        setWorkspace(r.workspace);
        setSessionWorkspace(r.workspace);
        setWorkspaceReady(true);
      } catch (err) {
        if (cancelled) return;
        console.warn("setWorkspace on restore failed:", err);
        setWorkspace("");
        setSessionWorkspace("");
        setPickerOpen(true);
        setWorkspaceReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  function sanitizePendingDiffs(raw: unknown): DiffItem[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (d): d is DiffItem =>
        d !== null &&
        typeof d === "object" &&
        typeof (d as DiffItem).id === "string" &&
        typeof (d as DiffItem).diff === "string" &&
        !(d as DiffItem).reverted,
    );
  }

  /** One-time: move legacy per-workspace browser diffs into the active chat session file. */
  function migrateLegacyBrowserDiffsOnce(ws: string, session: ChatSession) {
    const FLAG = `pig-agents.diffs.migrated-to-chat.v1::${ws}`;
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem(FLAG)) return;
    try {
      const legacyKey = `pig-agents.diffs.v1::${ws}`;
      const raw = localStorage.getItem(legacyKey);
      localStorage.setItem(FLAG, "1");
      localStorage.removeItem(legacyKey);
      if (!raw) return;
      const safe = sanitizePendingDiffs(JSON.parse(raw));
      if (safe.length === 0) return;
      const merged = { ...session, pendingDiffs: safe, updatedAt: Date.now() };
      sessionCacheRef.current.set(merged.id, merged);
      setActiveSession(merged);
      setDiffs(safe);
      api.putChat(ws, merged).catch(() => { /* non-fatal */ });
    } catch {
      try { localStorage.setItem(FLAG, "1"); } catch { /* noop */ }
    }
  }

  // Re-fetch settings whenever the modal closes (so model chip refreshes)
  useEffect(() => {
    if (!settingsOpen) {
      api.getSettings().then(setSettings).catch(() => { /* noop */ });
    }
  }, [settingsOpen]);

  // Background heartbeat for the activity-bar Source Control badge so it stays
  // roughly in sync without keeping GitPanel mounted. The FS watcher already
  // bumps `refreshKey` on disk activity — this 10s tick only catches things
  // the watcher can't see (e.g. a `git commit` that doesn't touch the worktree).
  // Visibility-gated so background tabs don't pile up requests.
  useVisibleInterval(
    () => {
      if (!workspace || !workspaceReady) return;
      void api.gitStatus().then((s) => {
        setGitChangeCount(s.ok && s.files ? s.files.length : 0);
      }).catch(() => { /* offline / not a repo */ });
    },
    10000,
    !!workspace && workspaceReady,
    true,
  );

  useEffect(() => {
    if (!workspace) setGitChangeCount(0);
  }, [workspace, refreshKey]);

  // Live filesystem watch: bump `refreshKey` whenever the workspace tree
  // changes on disk so the file tree, git badge, and other refreshKey-bound
  // panels refresh without the user having to click ↻. Catches everything:
  //   - agent's write_patch (mid-stream, before onAfterRun fires)
  //   - terminal commands that create/move files
  //   - external edits (git pull, IDE-side saves, etc.)
  // The hook itself debounces, so we don't risk a refresh-storm.
  useFsWatcher({
    enabled: !!workspace && workspaceReady,
    workspace,
    onChanges: () => setRefreshKey((k) => k + 1),
  });

  // Broadcast the currently active editor file so chat code blocks can
  // light up their Insert/Apply buttons targeting the right file.
  useEffect(() => {
    (window as unknown as { __ba_activeFile?: string | null }).__ba_activeFile = active ?? null;
    window.dispatchEvent(new CustomEvent("ba:active-file", { detail: { path: active ?? null } }));
  }, [active]);

  // Handle Insert/Apply actions emitted by chat code blocks.
  useEffect(() => {
    function onAction(e: Event) {
      const detail = (e as CustomEvent<{ kind: "insert" | "replace"; text: string; target: string | null }>).detail;
      if (!detail) return;
      const wantPath = detail.target || active;
      if (!wantPath) return;
      const apply = () => {
        const ed = editorRef.current;
        if (!ed || ed.getPath() !== wantPath) return;
        if (detail.kind === "insert") ed.insertAtCursor(detail.text);
        else ed.replaceAll(detail.text);
      };
      // If the target file isn't the active tab yet, open it first then apply on next tick.
      if (wantPath !== active) {
        openFile(wantPath);
        setTimeout(apply, 250);
      } else {
        apply();
      }
    }
    window.addEventListener("ba:editor-action", onAction as EventListener);
    return () => window.removeEventListener("ba:editor-action", onAction as EventListener);
  }, [active]);

  // ---- Backend-backed chat history ---------------------------------------
  function metaFromSession(s: ChatSession): ChatSessionMeta {
    return {
      id: s.id,
      title: s.title,
      workspace: s.workspace,
      mode: s.mode,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      turnCount: s.turns.length,
    };
  }

  const chatPanelSession = useMemo(() => {
    if (!workspace || !activeSessionId) return null;
    if (activeSession?.id === activeSessionId) return activeSession;
    const cached = sessionCacheRef.current.get(activeSessionId);
    if (cached) return cached;
    const meta = chatList.find((m) => m.id === activeSessionId);
    if (meta) return shellSessionFromMeta(meta, workspace);
    if (chatList.length > 0) return shellSessionFromMeta(chatList[0], workspace);
    return null;
  }, [workspace, activeSessionId, activeSession, chatList]);

  function flushSave() {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const payload = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (!payload || deletedChatIdsRef.current.has(payload.id)) return;
    const merged = { ...payload, pendingDiffs: diffsRef.current };
    api.putChat(merged.workspace, merged).catch((err) => {
      console.warn("chat save failed:", err);
    });
  }

  function scheduleSave(session: ChatSession, delay = 350) {
    if (deletedChatIdsRef.current.has(session.id)) return;
    pendingSaveRef.current = session;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(flushSave, delay);
  }

  // One-shot migration: if the user has chats in the legacy localStorage
  // bucket, ship them to the backend exactly once. Idempotent — guarded by
  // a flag key so reload won't re-import.
  async function migrateLegacyChatsOnce(ws: string) {
    const FLAG = "pig-agents.sessions.migrated.v1";
    const SRC = "pig-agents.sessions.v1";
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem(FLAG)) return;
    let raw: string | null = null;
    try { raw = localStorage.getItem(SRC); } catch { return; }
    if (!raw) { localStorage.setItem(FLAG, "1"); return; }
    try {
      const parsed = JSON.parse(raw);
      const all: ChatSession[] = Array.isArray(parsed) ? parsed : [];
      const forWs = all.filter((s) => s && s.workspace === ws && Array.isArray(s.turns));
      if (forWs.length > 0) {
        await api.importChats(ws, forWs);
      }
      // Mark migrated regardless of how many sessions matched this workspace —
      // we'll have a chance to migrate other workspaces on their first visit
      // since we filter by workspace, but the legacy key only stores one
      // workspace's sessions in practice. Clear it either way.
      localStorage.removeItem(SRC);
      localStorage.setItem(FLAG, "1");
    } catch {
      localStorage.setItem(FLAG, "1");
    }
  }

  function persistChatBootstrap(
    ws: string,
    list: ChatSessionMeta[],
    sessionId: string,
    session: ChatSession | null,
  ) {
    writeChatBootstrap(ws, {
      chatList: list,
      activeSessionId: sessionId,
      activeSession: session,
    });
  }

  // Load chat list whenever the workspace changes. Keeps cached UI visible while refreshing.
  useEffect(() => {
    if (!workspace) {
      sessionCacheRef.current.clear();
      setChatList([]);
      setActiveSessionId("");
      setActiveSession(null);
      setDiffs([]);
      prevWorkspaceRef.current = "";
      return;
    }

    const wsChanged = prevWorkspaceRef.current !== workspace;
    prevWorkspaceRef.current = workspace;

    if (wsChanged) {
      const boot = readChatBootstrap(workspace);
      if (boot) {
        setChatList(boot.chatList);
        setActiveSessionId(boot.activeSessionId);
        if (boot.activeSession) {
          sessionCacheRef.current.set(boot.activeSession.id, boot.activeSession);
          setActiveSession(boot.activeSession);
          setDiffs(sanitizePendingDiffs(boot.activeSession.pendingDiffs));
        } else {
          setActiveSession(null);
        }
      } else {
        sessionCacheRef.current.clear();
        setChatList([]);
        setActiveSessionId("");
        setActiveSession(null);
        setDiffs([]);
      }
    }

    const gen = ++chatLoadGenRef.current;
    let cancelled = false;

    (async () => {
      try {
        await migrateLegacyChatsOnce(workspace);
        if (cancelled || gen !== chatLoadGenRef.current) return;

        const r = await rpcWithRetry(() => api.listChats(workspace));
        if (cancelled || gen !== chatLoadGenRef.current) return;

        if (r.sessions.length === 0) {
          const s = newSession(workspace);
          await rpcWithRetry(() => api.putChat(workspace, s));
          if (cancelled || gen !== chatLoadGenRef.current) return;
          sessionCacheRef.current.set(s.id, s);
          setChatList([metaFromSession(s)]);
          setActiveSessionId(s.id);
          setActiveSession(s);
          setDiffs([]);
          persistChatBootstrap(workspace, [metaFromSession(s)], s.id, s);
          return;
        }

        const sorted = r.sessions
          .slice()
          .sort((a, b) => (b.updatedAt - a.updatedAt) || (b.createdAt - a.createdAt));
        setChatList(sorted);
        setActiveSessionId((current) => {
          const pick =
            current && sorted.some((s) => s.id === current) ? current : sorted[0].id;
          return pick;
        });
      } catch (err) {
        console.warn("listChats failed:", err);
        if (cancelled || gen !== chatLoadGenRef.current) return;
        if (chatListRef.current.length === 0) {
          const s = newSession(workspace);
          sessionCacheRef.current.set(s.id, s);
          setChatList([metaFromSession(s)]);
          setActiveSessionId(s.id);
          setActiveSession(s);
          api.putChat(workspace, s).catch(() => { /* noop */ });
        }
      }
    })();

    return () => {
      cancelled = true;
      flushSave();
    };
  }, [workspace]);

  // Load full session whenever the active id changes (lazy, with cache).
  useEffect(() => {
    if (!workspace || !activeSessionId) return;
    const idLoading = activeSessionId;
    const cached = sessionCacheRef.current.get(idLoading);
    if (cached) {
      setActiveSession(cached);
      const d = sanitizePendingDiffs(cached.pendingDiffs);
      setDiffs(d);
      if (d.length === 0) migrateLegacyBrowserDiffsOnce(workspace, cached);
      persistChatBootstrap(workspace, chatListRef.current, idLoading, cached);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const s = await rpcWithRetry(() => api.getChat<ChatSession>(workspace, idLoading));
        if (cancelled) return;
        if (!Array.isArray(s.turns)) s.turns = [];
        const d = sanitizePendingDiffs(s.pendingDiffs);
        const normalized = { ...s, pendingDiffs: d };
        sessionCacheRef.current.set(s.id, normalized);
        setActiveSession(normalized);
        setDiffs(d);
        if (d.length === 0) migrateLegacyBrowserDiffsOnce(workspace, normalized);
        persistChatBootstrap(workspace, chatListRef.current, idLoading, normalized);
      } catch (err) {
        console.warn("getChat failed:", err);
        if (cancelled) return;
        if (!isChatNotFoundError(err)) {
          return;
        }
        deletedChatIdsRef.current.add(idLoading);
        sessionCacheRef.current.delete(idLoading);
        try {
          await api.deleteChat(workspace, idLoading);
        } catch {
          /* prune stale sidebar row */
        }
        setChatList((cur) => {
          const next = cur.filter((m) => m.id !== idLoading);
          if (next.length === 0) {
            const s = newSession(workspace);
            sessionCacheRef.current.set(s.id, s);
            api.putChat(workspace, s).catch(() => { /* noop */ });
            setActiveSessionId(s.id);
            setActiveSession(s);
            persistChatBootstrap(workspace, [metaFromSession(s)], s.id, s);
            return [metaFromSession(s)];
          }
          if (activeSessionId === idLoading) setActiveSessionId(next[0].id);
          return next;
        });
        setActiveSession(null);
        setDiffs([]);
      }
    })();
    return () => { cancelled = true; };
  }, [workspace, activeSessionId]);

  // Persist sidebar + active chat for instant restore on next app open.
  useEffect(() => {
    if (!workspace || !activeSessionId) return;
    const t = window.setTimeout(() => {
      persistChatBootstrap(workspace, chatList, activeSessionId, activeSession);
    }, 600);
    return () => window.clearTimeout(t);
  }, [workspace, chatList, activeSessionId, activeSession]);

  // If IPC failed on cold start, retry when the window regains focus.
  useEffect(() => {
    if (!workspace) return;
    const retryIfEmpty = () => {
      if (document.visibilityState === "hidden") return;
      if (chatListRef.current.length > 0) return;
      void rpcWithRetry(() => api.listChats(workspace), { attempts: 2, delayMs: 200 })
        .then((r) => {
          if (r.sessions.length === 0) return;
          const sorted = r.sessions
            .slice()
            .sort((a, b) => (b.updatedAt - a.updatedAt) || (b.createdAt - a.createdAt));
          setChatList(sorted);
          setActiveSessionId((cur) =>
            cur && sorted.some((s) => s.id === cur) ? cur : sorted[0].id,
          );
        })
        .catch(() => { /* noop */ });
    };
    document.addEventListener("visibilitychange", retryIfEmpty);
    window.addEventListener("focus", retryIfEmpty);
    return () => {
      document.removeEventListener("visibilitychange", retryIfEmpty);
      window.removeEventListener("focus", retryIfEmpty);
    };
  }, [workspace]);

  // Persist pending diff tray on change (same session file as chat).
  useEffect(() => {
    if (!workspace || !activeSessionId) return;
    setActiveSession((prev) => {
      if (!prev || prev.id !== activeSessionId) return prev;
      const merged = { ...prev, pendingDiffs: diffs, updatedAt: Date.now() };
      sessionCacheRef.current.set(merged.id, merged);
      scheduleSave(merged, 400);
      return merged;
    });
  }, [diffs, activeSessionId, workspace]);

  useEffect(() => {
    const onUnload = () => flushSave();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  function updateSession(updated: ChatSession) {
    const merged: ChatSession = { ...updated, pendingDiffs: diffsRef.current };
    sessionCacheRef.current.set(merged.id, merged);
    // Save debouncing still uses the freshest payload and runs on its own
    // timer — only React state updates are coalesced here. This keeps the
    // sidebar metadata, header banners, etc. responsive without thrashing
    // the React tree on every SSE event during a run.
    pendingActiveSessionRef.current = merged;
    if (activeSessionRafRef.current == null) {
      activeSessionRafRef.current = requestAnimationFrame(() => {
        activeSessionRafRef.current = null;
        const latest = pendingActiveSessionRef.current;
        pendingActiveSessionRef.current = null;
        if (!latest) return;
        // Guard against the user switching chats while a frame was pending —
        // we'd otherwise clobber the freshly-loaded active session.
        if (latest.id !== activeSessionId) return;
        setActiveSession(latest);
        persistChatBootstrap(workspace, chatListRef.current, latest.id, latest);
        // Only touch chatList when the metadata that's actually rendered in
        // the sidebar changed — avoids a full re-sort + Chats re-render on
        // every event-level updatedAt bump.
        setChatList((cur) => {
          const idx = cur.findIndex((m) => m.id === latest.id);
          const meta = metaFromSession(latest);
          if (idx === -1) {
            const next = [meta, ...cur];
            next.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.createdAt - a.createdAt));
            return next;
          }
          const prev = cur[idx];
          const sameMeta = prev.title === meta.title
            && prev.turnCount === meta.turnCount
            && prev.mode === meta.mode
            // updatedAt always changes; tolerate sub-second drift so we don't
            // re-sort the whole list mid-stream when nothing user-visible moved.
            && Math.floor(prev.updatedAt / 1000) === Math.floor(meta.updatedAt / 1000);
          if (sameMeta && idx === 0) return cur;
          const next = cur.slice();
          next[idx] = meta;
          next.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.createdAt - a.createdAt));
          return next;
        });
      });
    }
    // Save more aggressively (~120ms) after a turn finishes; debounce more
    // (~600ms) while a turn is still streaming events. Force-save immediately
    // (0ms) when turn is fully done so index is fresh before any F5.
    const lastTurn = merged.turns[merged.turns.length - 1];
    const isRunning = lastTurn && lastTurn.status === "running";
    const delay = isRunning ? 600 : 0;
    scheduleSave(merged, delay);
  }

  function newChat() {
    if (!workspace) return;
    const s = newSession(workspace);
    sessionCacheRef.current.set(s.id, s);
    setChatList((cur) => [metaFromSession(s), ...cur]);
    setActiveSessionId(s.id);
    setActiveSession(s);
    api.putChat(workspace, s).catch((err) => console.warn("create chat failed:", err));
  }

  async function deleteChat(id: string) {
    if (!workspace) return;

    deletedChatIdsRef.current.add(id);
    sessionCacheRef.current.delete(id);

    if (pendingSaveRef.current?.id === id) {
      pendingSaveRef.current = null;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    } else {
      flushSave();
    }

    try {
      await api.deleteChat(workspace, id);
    } catch (err) {
      deletedChatIdsRef.current.delete(id);
      void dlg.alert(`Could not delete chat: ${(err as Error).message}`);
      try {
        const r = await api.listChats(workspace);
        setChatList(r.sessions);
      } catch {
        /* noop */
      }
      return;
    }

    setChatList((cur) => {
      const next = cur.filter((m) => m.id !== id);
      if (next.length === 0) {
        const s = newSession(workspace);
        sessionCacheRef.current.set(s.id, s);
        api.putChat(workspace, s).catch((err) => console.warn("create chat failed:", err));
        setActiveSessionId(s.id);
        setActiveSession(s);
        return [metaFromSession(s)];
      }
      if (activeSessionId === id) {
        setActiveSessionId(next[0].id);
        setActiveSession(null);
      }
      return next;
    });
  }

  async function exportChats() {
    if (!workspace) return;
    // Desktop: fetch the bundle over IPC and trigger a client-side download
    // via a Blob URL (no HTTP / Content-Disposition involved).
    const bundle = await api.exportChats(workspace);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pig-agents-chats-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function importChatsFromFile() {
    if (!workspace) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        const parsed = JSON.parse(text);
        const sessions: ChatSession[] = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.sessions)
            ? parsed.sessions
            : [];
        if (sessions.length === 0) {
          await dlg.alert("No sessions found in this file.");
          return;
        }
        const r = await api.importChats(workspace, sessions);
        // Refresh the sidebar after import.
        const list = await api.listChats(workspace);
        setChatList(list.sessions);
        await dlg.alert(`Imported ${r.imported} of ${r.total} session${r.total === 1 ? "" : "s"}.`);
      } catch (err) {
        await dlg.alert(`Import failed: ${(err as Error).message}`);
      }
    };
    input.click();
  }

  function renameChat(id: string, title: string) {
    if (!workspace) return;
    setChatList((cur) => cur.map((m) => (m.id === id ? { ...m, title } : m)));
    const cached = sessionCacheRef.current.get(id);
    if (cached) {
      const next = { ...cached, title, updatedAt: Date.now() };
      sessionCacheRef.current.set(id, next);
      if (activeSessionId === id) setActiveSession(next);
    }
    api.patchChat(workspace, id, { title }).catch((err) => console.warn("rename failed:", err));
  }

  function openFile(p: string, line?: number) {
    setTabs((cur) => {
      const idx = cur.findIndex((t) => t.path === p && t.kind !== "diff");
      if (idx === -1) return [...cur, {
        path: p, dirty: false, kind: "file",
        gotoLine: line, gotoNonce: line ? Date.now() : undefined,
      }];
      const next = cur.slice();
      next[idx] = {
        ...next[idx],
        dirty: isPathDirtyInBuffer(p),
        gotoLine: line ?? next[idx].gotoLine,
        gotoNonce: line ? Date.now() : next[idx].gotoNonce,
      };
      return next;
    });
    setActive(p);
    // Track this open in the per-workspace recents list so the welcome
    // screen can offer one-click reopen later.
    if (workspace) {
      pushRecent(workspace, p);
      setRecentsVersion((v) => v + 1);
    }
  }

  function openDiff(item: DiffItem, displayPath: string) {
    const tabKey = `diff:${item.id}:${displayPath}`;
    setTabs((cur) => {
      const idx = cur.findIndex((t) => t.path === tabKey);
      if (idx === -1) return [...cur, {
        path: tabKey, dirty: false, kind: "diff",
        diff: item.diff, diffId: item.id, displayPath,
      }];
      const next = cur.slice();
      next[idx] = { ...next[idx], diff: item.diff };
      return next;
    });
    setActive(tabKey);
  }

  /**
   * Open a git diff (working-tree, index, or untracked) as a diff tab in the
   * main editor. For untracked files we just open the file directly — there
   * is no "previous" version to diff against and DiffEditorView's parser
   * doesn't speak `--- /dev/null` headers.
   */
  function openGitDiff(req: { path: string; staged: boolean; untracked: boolean; diff: string }) {
    if (req.untracked) {
      openFile(req.path);
      return;
    }
    if (!req.diff || !req.diff.trim()) {
      // No textual diff (binary, mode-only, etc.) — fall back to plain open.
      openFile(req.path);
      return;
    }
    // Synthetic id keys the tab and seeds DiffEditorView's parser cache.
    const id = `git:${req.staged ? "idx" : "wt"}:${req.path}`;
    openDiff({ id, diff: req.diff, reverted: false } as DiffItem, req.path);
  }

  const reorderTabs = useCallback((fromPath: string, toPath: string, insertBefore: boolean) => {
    setTabs((cur) => {
      const fromIdx = cur.findIndex((t) => t.path === fromPath);
      let toIdx = cur.findIndex((t) => t.path === toPath);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return cur;
      if (!insertBefore) toIdx += 1;
      const next = [...cur];
      const [item] = next.splice(fromIdx, 1);
      if (fromIdx < toIdx) toIdx -= 1;
      next.splice(toIdx, 0, item);
      return next;
    });
  }, []);

  /** Close one or more tabs by path (e.g. after delete); picks a sensible next active tab. */
  const closeTabPath = useCallback((pathToClose: string) => {
    invalidateEditorCache(pathToClose);
    setTabs((cur) => {
      const idx = cur.findIndex((t) => t.path === pathToClose);
      if (idx === -1) return cur;
      const next = cur.filter((x) => x.path !== pathToClose);
      if (active === pathToClose) {
        setActive(next[Math.min(idx, next.length - 1)]?.path);
      }
      return next;
    });
  }, [active]);

  const saveFileTab = useCallback(async (path: string): Promise<boolean> => {
    if (active !== path) setActive(path);
    const deadline = performance.now() + 2500;
    while (performance.now() < deadline) {
      if (editorRef.current?.getPath() === path) break;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    if (editorRef.current?.getPath() !== path) {
      void dlg.alert("Could not save — editor is not ready.");
      return false;
    }
    try {
      await editorRef.current.save();
    } catch (err) {
      void dlg.alert((err as Error).message);
      return false;
    }
    await new Promise<void>((r) => setTimeout(r, 0));
    return !tabsRef.current.some((t) => t.path === path && t.dirty);
  }, [active, dlg]);

  const requestCloseTab = useCallback(async (pathToClose: string) => {
    const tab = tabsRef.current.find((t) => t.path === pathToClose);
    if (!tab) return;
    const needsSave = tab.kind === "file" && (tab.dirty || isPathDirtyInBuffer(tab.path));
    if (needsSave) {
      const name = tab.path.split("/").pop() || tab.path;
      const choice = await dlg.unsavedChanges({ fileName: name });
      if (choice === "cancel") return;
      if (choice === "save") {
        const ok = await saveFileTab(pathToClose);
        if (!ok) return;
      }
    }
    if (pathToClose === BROWSER_TAB_PATH) {
      try {
        await pig.browserStop();
      } catch { /* best-effort */ }
    }
    closeTabPath(pathToClose);
  }, [dlg, saveFileTab, closeTabPath]);

  const closeTabsForDeletedPaths = useCallback((deletedPaths: string[]) => {
    if (deletedPaths.length === 0) return;
    for (const p of deletedPaths) invalidateEditorCache(p);
    setTabs((cur) => {
      const next = cur.filter((t) => !tabAffectedByDelete(t, deletedPaths));
      if (next.length === cur.length) return cur;
      if (active && !next.some((t) => t.path === active)) {
        const oldIdx = cur.findIndex((t) => t.path === active);
        setActive(next[Math.min(oldIdx, Math.max(0, next.length - 1))]?.path);
      }
      return next;
    });
  }, [active]);

  const setDirty = useCallback((p: string, dirty: boolean) => {
    setTabs((cur) => {
      const tab = cur.find((t) => t.path === p);
      if (!tab || tab.dirty === dirty) return cur;
      return cur.map((t) => (t.path === p ? { ...t, dirty } : t));
    });
  }, []);

  const appendDiffs = useCallback((newDiffs: string[]) => {
    // Backend returns "" when a patch was a no-op (before === after); skip
    // those so the UI doesn't show ghost rows or empty inline highlights.
    const filtered = newDiffs.filter((d) => d && d.includes("@@"));
    if (!filtered.length) return;
    setDiffs((cur) => {
      const next = [...cur];
      for (const d of filtered) {
        const path = diffPathFromUnified(d);
        const norm = path ? normalizeDiffPath(path) : "";
        const matchIdx =
          norm
            ? next.findIndex(
              (item) =>
                !item.reverted &&
                normalizeDiffPath(diffPathFromUnified(item.diff) ?? "") === norm,
            )
            : -1;
        if (matchIdx >= 0) {
          const merged = mergeUnifiedDiffs(next[matchIdx].diff, d);
          next[matchIdx] = { ...next[matchIdx], diff: merged };
        } else {
          next.push({
            id: `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
            diff: d,
          });
        }
      }
      return next;
    });
  }, []);

  function updateDiff(id: string, patch: Partial<DiffItem>) {
    setDiffs((cur) => cur.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    setRefreshKey((k) => k + 1);
  }

  /** Remove a diff from the review list and close any open side-by-side diff tab for it. */
  function removeDiffId(id: string) {
    setDiffs((cur) => cur.filter((d) => d.id !== id));
    setTabs((cur) => {
      const closing = cur.filter((t) => t.kind === "diff" && t.diffId === id);
      if (closing.length === 0) return cur;
      const closingPaths = new Set(closing.map((t) => t.path));
      const next = cur.filter((t) => !closingPaths.has(t.path));
      if (active && closingPaths.has(active)) {
        const idx = cur.findIndex((t) => t.path === active);
        setActive(next[Math.min(idx, next.length - 1)]?.path);
      }
      return next;
    });
    setRefreshKey((k) => k + 1);
  }

  // Per-hunk Keep / Undo emitted by inline widgets in the editor. We mutate
  // the in-memory DiffItem to drop the targeted hunk and (when undoing) call
  // the backend to revert just that hunk on disk. If no hunks remain after
  // the operation, the whole DiffItem is removed from the pending list.
  useEffect(() => {
    async function onHunkAction(e: Event) {
      const detail = (e as CustomEvent<{ diffId: string; hunkIndex: number; action: "keep" | "undo" }>).detail;
      if (!detail) return;
      const target = diffs.find((d) => d.id === detail.diffId);
      if (!target || target.reverted) return;

      if (detail.action === "undo") {
        try {
          await api.revertHunk(target.diff, detail.hunkIndex);
        } catch (err) {
          if (revertTargetFileMissing(err)) {
            removeDiffId(detail.diffId);
            setRefreshKey((k) => k + 1);
            return;
          }
          void dlg.alert((err as Error).message);
          return;
        }
      }

      const next = removeHunkFromDiff(target.diff, detail.hunkIndex, detail.action === "undo");
      setDiffs((cur) => {
        if (!next) return cur.filter((d) => d.id !== detail.diffId);
        return cur.map((d) => (d.id === detail.diffId ? { ...d, diff: next } : d));
      });
      if (detail.action === "undo") {
        const fp = diffPathFromUnified(target.diff);
        if (fp) {
          setEditorReloadPath(fp);
          setEditorReloadSeq((n) => n + 1);
        }
      }
      setRefreshKey((k) => k + 1);
    }
    window.addEventListener("ba:hunk-action", onHunkAction as EventListener);
    return () => window.removeEventListener("ba:hunk-action", onHunkAction as EventListener);
  }, [diffs, dlg]);

  async function pickWorkspace(p: string, targetSessionId?: string) {
    setWorkspaceReady(false);
    try {
      const r = await api.setWorkspace(p);
      setSessionWorkspace(r.workspace);
      setWorkspace(r.workspace);
      if (targetSessionId) setActiveSessionId(targetSessionId);
      invalidateEditorCache();
      if (tabsRef.current.some((t) => t.path === BROWSER_TAB_PATH)) {
        try {
          await pig.browserStop();
        } catch { /* best-effort */ }
      }
      setTabs([]);
      setActive(undefined);
      setRefreshKey((k) => k + 1);
      setPickerOpen(false);
      setWorkspaceReady(true);
      try {
        localStorage.setItem("pig-agents.ws.confirmed.v1", "1");
        localStorage.setItem("pig-agents.ws.path.v1", r.workspace);
      } catch { /* noop */ }
    } catch (err) {
      setWorkspaceReady(!!workspace);
      void dlg.alert((err as Error).message);
    }
  }

  const activeTab = tabs.find((t) => t.path === active);
  useBrowserOverlayGuard(activeTab?.kind === "browser");

  useEffect(() => {
    return pig.onBrowserAgentActivate(() => {
      setTabs((prev) => {
        if (prev.some((t) => t.path === BROWSER_TAB_PATH)) return prev;
        return [...prev, { path: BROWSER_TAB_PATH, kind: "browser" as const, dirty: false }];
      });
      setActive(BROWSER_TAB_PATH);
      void pig.browserSetTabActive(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          void pig.browserSetVisible(true);
        });
      });
    });
  }, []);

  // Find the most recent pending (non-reverted) diff for the active file so
  // we can highlight changed lines inline + show a Keep/Undo banner.
  const activePendingDiff = useMemo(() => {
    if (!activeTab || activeTab.kind === "diff") return null;
    const target = activeTab.path;
    for (let i = diffs.length - 1; i >= 0; i--) {
      const d = diffs[i];
      if (d.reverted) continue;
      const m = /^\+\+\+\s+b\/(.+)$/m.exec(d.diff);
      if (!m) continue;
      if (m[1] === target) {
        let adds = 0; let dels = 0;
        for (const ln of d.diff.split("\n")) {
          if (ln.startsWith("+++") || ln.startsWith("---")) continue;
          if (ln.startsWith("+")) adds++;
          else if (ln.startsWith("-")) dels++;
        }
        return { item: d, adds, dels };
      }
    }
    return null;
  }, [activeTab, diffs]);

  return (
    <div className={`app-shell${winMaximized ? " app-shell--maximized" : ""}`}>
      <div className="app">
        <div
          className="titlebar"
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest(".window-controls, button, .ws-path")) return;
            void pig.windowMaximize();
          }}
        >
          <span className="title">Pig Agents</span>
          <span className="ws-path" title="Click to change workspace" onClick={() => setPickerOpen(true)}>
            <IconFolderOpen size={13} style={{ opacity: 0.7, marginRight: 4 }} />{workspace || "(no workspace)"}
          </span>
          <div className="spacer" />
          <button
            type="button"
            tabIndex={-1}
            title="Reset layout"
            onClick={() => {
              try {
                for (const k of Object.keys(localStorage)) {
                  if (k.startsWith("react-resizable-panels")) localStorage.removeItem(k);
                }
              } catch { /* noop */ }
              location.reload();
            }}
          ><IconRefreshCw size={13} style={{ marginRight: 5 }} />Reset layout</button>
          <button
            type="button"
            tabIndex={-1}
            className={bottomCollapsed ? "" : "active"}
            title={bottomCollapsed ? "Show terminal" : "Hide terminal"}
            onClick={() => {
              if (bottomCollapsed) showBottom("terminal");
              else toggleBottom();
            }}
          >
            <IconTerminal size={14} style={{ marginRight: 5 }} />Terminal
          </button>
          <button
            type="button"
            tabIndex={-1}
            className={active === BROWSER_TAB_PATH ? "active" : ""}
            title="Browser"
            onClick={() => {
              const exists = tabs.find((t) => t.path === BROWSER_TAB_PATH);
              if (!exists) setTabs((prev) => [...prev, { path: BROWSER_TAB_PATH, kind: "browser" as const, dirty: false }]);
              setActive(BROWSER_TAB_PATH);
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ marginRight: 5, verticalAlign: "middle" }}>
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>Browser
          </button>
          <WorkspaceManager
            currentWorkspace={workspace}
            onSwitchWorkspace={(ws) => {
              void pickWorkspace(ws);
            }}
            onSelectSession={(ws, sessionId) => {
              if (ws === workspace) {
                setActiveSessionId(sessionId);
              } else {
                void pickWorkspace(ws, sessionId);
              }
            }}
          />
          <WindowControls />
        </div>

        <div className="workbench">
          <div className="activity">
            <button type="button" tabIndex={-1} className={view === "explorer" ? "active" : ""} title="Explorer" onClick={() => setView("explorer")}><IconFolderOpen size={18} /></button>
            <button type="button" tabIndex={-1} className={view === "search" ? "active" : ""} title="Search" onClick={() => setView("search")}><IconSearch size={18} /></button>
            <button
              type="button"
              tabIndex={-1}
              className={`activity-source${view === "source" ? " active" : ""}`}
              title="Source Control"
              onClick={() => setView("source")}
            >
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden>
                <path
                  d="M11.75 2.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM4.25 13.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5zM4.25 2.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5z"
                  fill="currentColor"
                />
                <path d="M4.25 6v4M11.75 6v.75A3.75 3.75 0 0 1 8 10.5H4.25" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
              </svg>
              {gitChangeCount > 0 ? <span className="activity-badge">{gitChangeCount > 99 ? "99+" : gitChangeCount}</span> : null}
            </button>
            <div className="spacer" />
            <button type="button" tabIndex={-1} title="Settings" onClick={() => setSettingsOpen(true)}><IconSettings size={18} /></button>
          </div>

          <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
            <PanelGroup direction="horizontal" autoSaveId="ba-main-v3">
              <Panel defaultSize={18} minSize={12}>
                <div className="sidebar">
                  {!workspace ? (
                    <div className="ws-empty">
                      <div className="ws-empty-title">No folder opened</div>
                      <div className="ws-empty-msg">
                        Pick a folder to start exploring, editing, and chatting.
                      </div>
                      <button className="ws-empty-btn" onClick={() => setPickerOpen(true)}><IconFolderOpen size={14} style={{ marginRight: 6 }} />Open folder…</button>
                    </div>
                  ) : (
                    <>
                      {view === "explorer" && (
                        <FileTree
                          selected={active}
                          workspace={workspaceReady ? workspace : undefined}
                          onOpen={(p) => openFile(p)}
                          refreshKey={refreshKey}
                          onPathsDeleted={closeTabsForDeletedPaths}
                          onRevealInTerminal={(p) => terminalsRef.current?.reveal(p.startsWith("/") ? p : `${workspace}/${p}`)}
                        />
                      )}
                      {view === "search" && <SearchPanel onOpen={openFile} active />}
                      {view === "source" && (
                        <GitPanel
                          workspace={workspace}
                          refreshKey={refreshKey}
                          onOpenGitDiff={openGitDiff}
                        />
                      )}

                    </>
                  )}
                </div>
              </Panel>
              <PanelResizeHandle />

              <Panel minSize={20}>
                <div className="center">
                  <PanelGroup direction="vertical" autoSaveId="ba-center-v3">
                    <Panel minSize={20} defaultSize={65}>
                      <div className="editor-area" style={activeTab?.kind === "browser" ? { overflow: "hidden" } : undefined}>
                        <div className="editor-tabs">
                          <div
                            className="editor-tabs-list"
                            onDragLeave={(e) => {
                              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                              setTabDropTarget(null);
                            }}
                          >
                            {tabs.map((t) => {
                              const isDiff = t.kind === "diff";
                              const isBrowser = t.kind === "browser";
                              const isFile = !isDiff && !isBrowser;
                              const display = isDiff
                                ? (t.displayPath?.split("/").pop() || "diff")
                                : isBrowser ? "Browser"
                                  : t.path.split("/").pop();
                              const showDirty = isFile && t.dirty;
                              const dropBefore =
                                tabDropTarget?.path === t.path && tabDropTarget.before;
                              const dropAfter =
                                tabDropTarget?.path === t.path && !tabDropTarget.before;
                              return (
                                <div
                                  key={t.path}
                                  className={[
                                    "editor-tab",
                                    active === t.path ? "active" : "",
                                    isDiff ? "is-diff" : "",
                                    showDirty ? "is-dirty" : "",
                                    tabDragPath === t.path ? "is-dragging" : "",
                                    dropBefore ? "tab-drop-before" : "",
                                    dropAfter ? "tab-drop-after" : "",
                                  ].filter(Boolean).join(" ")}
                                  onClick={() => {
                                    setActive(t.path);
                                    if (isFile) setDirty(t.path, isPathDirtyInBuffer(t.path));
                                  }}
                                  draggable
                                  onDragStart={(e) => {
                                    e.dataTransfer.setData("application/x-ba-tab", t.path);
                                    if (isFile) {
                                      e.dataTransfer.setData("application/x-ba-file", t.path);
                                      e.dataTransfer.setData("text/plain", `@${t.path}`);
                                    }
                                    e.dataTransfer.effectAllowed = "move";
                                    setTabDragPath(t.path);
                                  }}
                                  onDragEnd={() => {
                                    setTabDragPath(null);
                                    setTabDropTarget(null);
                                  }}
                                  onDragOver={(e) => {
                                    if (!e.dataTransfer.types.includes("application/x-ba-tab")) return;
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = "move";
                                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                    const before = e.clientX < rect.left + rect.width / 2;
                                    setTabDropTarget({ path: t.path, before });
                                  }}
                                  onDrop={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    const from = e.dataTransfer.getData("application/x-ba-tab");
                                    if (!from || from === t.path) return;
                                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                    const before = e.clientX < rect.left + rect.width / 2;
                                    reorderTabs(from, t.path, before);
                                    setTabDragPath(null);
                                    setTabDropTarget(null);
                                  }}
                                >
                                  {isDiff && <span className="tab-tag">DIFF</span>}
                                  {isBrowser ? (
                                    <span className="tab-icon" style={{ display: "flex", alignItems: "center" }}>
                                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
                                    </span>
                                  ) : (
                                    <span className="tab-icon"><FileIcon name={display || ""} size={14} /></span>
                                  )}
                                  <span className="tab-label">{display}</span>
                                  <span
                                    className="tab-status"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void requestCloseTab(t.path);
                                    }}
                                    title="Close"
                                  >
                                    {showDirty && (
                                      <span className="dirty-indicator" aria-hidden="true">
                                        <IconDot size={8} />
                                      </span>
                                    )}
                                    <span className="close" aria-label="Close tab">
                                      <IconX size={12} />
                                    </span>
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                          {activeTab && activeTab.kind !== "diff" && activeTab.kind !== "browser" && (
                            <div className="editor-tabs-actions">
                              <button
                                className="editor-save-btn"
                                disabled={!activeTab.dirty}
                                title="Save (Ctrl/⌘+S)"
                                onClick={() => { void editorRef.current?.save(); }}
                              >
                                {activeTab.dirty ? <><IconDot size={6} style={{ marginRight: 4 }} />Save</> : "Saved"}
                              </button>
                            </div>
                          )}
                        </div>
                        {tabs.some(t => t.kind === "browser") && (
                          <div
                            className="editor-pane editor-pane--browser"
                            style={
                              activeTab?.kind === "browser"
                                ? { display: "flex", flex: 1, width: "100%", height: "100%" }
                                : { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", opacity: 0, pointerEvents: "none", zIndex: -1 }
                            }
                          >
                            <BrowserPanel
                              onAddToChat={(text) => { setPendingChatInject(text); }}
                              onAddPageImage={(dataUrl) => { setPendingChatImage(dataUrl); }}
                              onAddElementToChat={(pick: BrowserElementPickDetail) => {
                                dispatchBrowserElementPick(pick);
                              }}
                            />
                          </div>
                        )}
                        {activeTab && activeTab.kind !== "browser" ? (
                          activeTab.kind === "diff" ? (
                            <div className="editor-pane">
                              {(() => {
                                const diffId = activeTab.diffId || "";
                                const gitCtx: "staged" | "unstaged" | null =
                                  diffId.startsWith("git:idx:") ? "staged"
                                    : diffId.startsWith("git:wt:") ? "unstaged"
                                      : null;
                                const displayPath = activeTab.displayPath || "";
                                const diffTabKey = activeTab.path;
                                const isAgentDiff = !gitCtx && !!activeTab.diffId;
                                return (
                                  <DiffEditorView
                                    key={diffTabKey}
                                    path={displayPath}
                                    diff={activeTab.diff || ""}
                                    reverted={diffs.find((d) => d.id === activeTab.diffId)?.reverted}
                                    gitContext={gitCtx}
                                    onHunkAction={gitCtx ? async (mode, patch) => {
                                      try {
                                        await api.gitApply(patch, mode);
                                      } catch (err) {
                                        void dlg.alert((err as Error).message);
                                        return;
                                      }
                                      // Bump refresh key so GitPanel + activity-bar badge update.
                                      setRefreshKey((k) => k + 1);
                                      // Re-fetch the diff for this tab; close it if nothing remains.
                                      try {
                                        const res = await api.gitDiff(displayPath, { staged: gitCtx === "staged" });
                                        if (!res.diff || !res.diff.trim()) {
                                          void requestCloseTab(diffTabKey);
                                        } else {
                                          setTabs((cur) => cur.map((t) =>
                                            t.path === diffTabKey ? { ...t, diff: res.diff } : t,
                                          ));
                                        }
                                      } catch {
                                        // Non-fatal: worst case the stale diff stays until next poll.
                                      }
                                    } : undefined}
                                    onClose={() => { void requestCloseTab(diffTabKey); }}
                                    onOpenFile={(p) => {
                                      // Replace the diff tab with the file tab so we
                                      // don't end up with both side-by-side. Cursor /
                                      // VSCode behaves the same way for "Edit file".
                                      openFile(p);
                                      void requestCloseTab(diffTabKey);
                                    }}
                                    onRevert={isAgentDiff ? async () => {
                                      if (!activeTab.diffId) return;
                                      try {
                                        await api.revertDiff(activeTab.diff || "");
                                        removeDiffId(activeTab.diffId);
                                      } catch (err) {
                                        if (revertTargetFileMissing(err)) {
                                          removeDiffId(activeTab.diffId);
                                          return;
                                        }
                                        void dlg.alert((err as Error).message);
                                      }
                                    } : undefined}
                                  />
                                );
                              })()}
                            </div>
                          ) : (
                            <div className="editor-pane">
                              {(() => {
                                const pending = activePendingDiff;
                                return pending ? (
                                  <div className="pending-diff-bar">
                                    <span className="pdb-tag">PENDING</span>
                                    <span className="pdb-msg">Agent changes — Keep / Undo per hunk inline, or all at once below.</span>
                                    <span className="pdb-stats">
                                      {pending.adds > 0 && <span className="add">+{pending.adds}</span>}
                                      {pending.dels > 0 && <span className="del">−{pending.dels}</span>}
                                    </span>
                                    <span className="spacer" />
                                    <button
                                      className="pdb-btn"
                                      onClick={() => {
                                        if (pending.item) openDiff(pending.item, activeTab.path);
                                      }}
                                      title="Open side-by-side DIFF view"
                                    ><IconEye size={12} style={{ marginRight: 4 }} />Diff view</button>
                                    <button
                                      className="pdb-btn"
                                      onClick={() => {
                                        if (!pending.item) return;
                                        setDiffs((cur) => cur.filter((d) => d.id !== pending.item.id));
                                      }}
                                      title="Accept these changes — remove from list, keep file as-is"
                                    ><IconCheck size={12} style={{ marginRight: 4 }} />Keep</button>
                                    <button
                                      className="pdb-btn warn"
                                      onClick={async () => {
                                        if (!pending.item) return;
                                        try {
                                          await api.revertDiff(pending.item.diff);
                                          invalidateEditorCache(activeTab.path);
                                          removeDiffId(pending.item.id);
                                        } catch (err) {
                                          if (revertTargetFileMissing(err)) {
                                            removeDiffId(pending.item.id);
                                            return;
                                          }
                                          void dlg.alert((err as Error).message);
                                        }
                                      }}
                                      title="Undo these changes on disk"
                                    ><IconRotateCcw size={12} style={{ marginRight: 4 }} />Undo</button>
                                  </div>
                                ) : null;
                              })()}
                              <FileEditor
                                ref={editorRef}
                                key={activeTab.path}
                                path={activeTab.path}
                                gotoLine={activeTab.gotoNonce ? activeTab.gotoLine : undefined}
                                onSaved={() => setRefreshKey((k) => k + 1)}
                                onDirtyChange={(filePath, d) => setDirty(filePath, d)}
                                pendingDiff={activePendingDiff?.item.diff ?? null}
                                pendingDiffId={activePendingDiff?.item.id ?? null}
                                reloadPath={editorReloadPath}
                                reloadSeq={editorReloadSeq}
                                onMissing={() => closeTabPath(activeTab.path)}
                              />
                            </div>
                          )
                        ) : !activeTab ? (
                          <EditorWelcome
                            workspace={workspace}
                            recentsVersion={recentsVersion}
                            onOpenFolder={() => setPickerOpen(true)}
                            onOpenFile={openFile}
                            onShowSearch={() => setView("search")}
                            onToggleTerminal={toggleBottom}
                          />
                        ) : null}
                      </div>
                    </Panel>
                    <PanelResizeHandle />
                    <Panel
                      ref={bottomPanelRef}
                      minSize={15}
                      defaultSize={35}
                      collapsible
                      collapsedSize={0}
                      onCollapse={() => setBottomCollapsed(true)}
                      onExpand={() => setBottomCollapsed(false)}
                    >
                      <div className={`bottom-panel ${bottomCollapsed ? "collapsed" : ""}`}>
                        <Terminals
                          registerHandle={(h) => { terminalsRef.current = h; }}
                          onClose={() => bottomPanelRef.current?.collapse()}
                          workspace={workspace}
                        />
                      </div>
                    </Panel>
                  </PanelGroup>
                </div>
              </Panel>
              <PanelResizeHandle />

              <Panel defaultSize={28} minSize={20}>
                {!workspace ? (
                  <div className="chat">
                    <div className="ws-empty">
                      <div className="ws-empty-title">No folder opened</div>
                      <div className="ws-empty-msg">
                        Open a folder to start chatting with the agent.
                      </div>
                      <button className="ws-empty-btn" onClick={() => setPickerOpen(true)}><IconFolderOpen size={14} style={{ marginRight: 6 }} />Open folder…</button>
                    </div>
                  </div>
                ) : chatPanelSession ? (
                  <Chat
                    key={chatPanelSession.id}
                    session={chatPanelSession}
                    onUpdate={updateSession}
                    onDiffs={appendDiffs}
                    onAfterRun={() => setRefreshKey((k) => k + 1)}
                    refreshKey={refreshKey}
                    diffs={diffs}
                    onUpdateDiff={updateDiff}
                    onClearDiffs={() => setDiffs([])}
                    onRemoveDiff={removeDiffId}
                    onOpenFile={(p) => openFile(p)}
                    onOpenDiff={(item, path) => openDiff(item, path)}
                    activeFile={active}
                    modelLabel={settings?.MODEL || undefined}
                    llmSettings={settings}
                    onModelChange={async (model) => {
                      // Optimistic: paint the new label instantly so the menu
                      // (which closes synchronously after this call) doesn't
                      // hang for the duration of two network roundtrips. If the
                      // server rejects we'll just re-paint with whatever it
                      // returns; the worst case is a brief flicker, which is
                      // far better than the UI freezing on every model switch.
                      setSettings((cur) => (cur ? { ...cur, MODEL: model } : cur));
                      try {
                        await api.saveSettings({ MODEL: model });
                        const fresh = await api.getSettings();
                        setSettings(fresh);
                      } catch (err) {
                        // Re-fetch to recover the truth from the server.
                        try { setSettings(await api.getSettings()); } catch { /* noop */ }
                        console.warn("[App] saveSettings(MODEL) failed:", err);
                      }
                    }}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onNewChat={newChat}
                    workspace={workspace}
                    chatList={chatList}
                    onSelectChat={setActiveSessionId}
                    onDeleteChat={deleteChat}
                    onRenameChat={renameChat}
                    onExportChats={exportChats}
                    onImportChats={importChatsFromFile}
                    pendingInject={pendingChatInject || undefined}
                    onInjectConsumed={() => setPendingChatInject("")}
                    pendingInjectImage={pendingChatImage || undefined}
                    onInjectImageConsumed={() => setPendingChatImage("")}
                  />
                ) : (
                  <div className="chat"><div className="chat-empty">Loading…</div></div>
                )}
              </Panel>
            </PanelGroup>
          </div>
        </div>

        <div className="statusbar">
          <span><IconDot size={6} style={{ marginRight: 4 }} />{workspace || "no workspace"}</span>
          <span>{tabs.length} open</span>
          <span>{diffs.filter((d) => !d.reverted).length} diff{diffs.filter((d) => !d.reverted).length === 1 ? "" : "s"}</span>
          <span className="right">© 2026 DEV BETA., JSC · Pig Agents</span>
        </div>

        {pickerOpen && (
          <FolderPicker
            initialPath={workspace}
            onClose={() => setPickerOpen(false)}
            onSelect={pickWorkspace}
          />
        )}
        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      </div>
    </div>
  );
}
