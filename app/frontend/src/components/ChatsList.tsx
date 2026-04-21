import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ChatSessionMeta } from "../lib/api";
import { useDialogs } from "./DialogProvider";
import { IconX } from "./Icons";

interface Hit {
  id: string;
  title: string;
  updatedAt: number;
  snippet: string;
  matches: number;
}

interface Props {
  sessions: ChatSessionMeta[];
  activeId: string;
  workspace: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onExport: () => void;
  onImport: () => void;
}

function ago(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export function ChatsList({
  sessions, activeId, workspace,
  onSelect, onNew, onDelete, onRename, onExport, onImport,
}: Props) {
  const dlg = useDialogs();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const debRef = useRef<number | null>(null);
  const reqIdRef = useRef(0);

  // Title-only filter is instant. Backend full-text search is debounced.
  const titleFiltered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(ql));
  }, [sessions, q]);

  useEffect(() => {
    if (debRef.current !== null) window.clearTimeout(debRef.current);
    const ql = q.trim();
    if (!ql || !workspace) {
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const myId = ++reqIdRef.current;
    debRef.current = window.setTimeout(async () => {
      try {
        const r = await api.searchChats(workspace, ql);
        if (myId !== reqIdRef.current) return; // stale
        setHits(r.hits);
      } catch {
        if (myId === reqIdRef.current) setHits([]);
      } finally {
        if (myId === reqIdRef.current) setSearching(false);
      }
    }, 250);
    return () => {
      if (debRef.current !== null) window.clearTimeout(debRef.current);
    };
  }, [q, workspace]);

  // Merge title-matches with backend body-matches into one ordered list,
  // de-duplicated by id. Title matches always win the top slot when both
  // exist for the same session.
  const merged = useMemo(() => {
    const ql = q.trim();
    if (!ql) return null;
    const map = new Map<string, { meta: ChatSessionMeta; snippet?: string }>();
    for (const s of titleFiltered) map.set(s.id, { meta: s });
    if (hits) {
      for (const h of hits) {
        const meta = sessions.find((s) => s.id === h.id);
        if (!meta) continue;
        const existing = map.get(h.id);
        if (existing) existing.snippet = h.snippet;
        else map.set(h.id, { meta, snippet: h.snippet });
      }
    }
    const arr = Array.from(map.values());
    arr.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt);
    return arr;
  }, [titleFiltered, hits, sessions, q]);

  const showResults = merged ?? sessions.map((s) => ({ meta: s, snippet: undefined as string | undefined }));

  return (
    <>
      <div className="sidebar-header">
        <span>Chats</span>
        <div className="sidebar-actions">
          <button title="Import chats from JSON" onClick={onImport}>⬆</button>
          <button title="Export all chats" onClick={onExport}>⬇</button>
          <button title="New chat" onClick={onNew}>＋</button>
        </div>
      </div>
      <div className="chats-search">
        <input
          type="search"
          placeholder="Search chats…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
        />
        {q && (
          <button
            className="chats-search-clear"
            title="Clear"
            onClick={() => setQ("")}
          >
            <IconX size={12} />
          </button>
        )}
      </div>
      <div className="chats-list">
        {q && searching && <div className="chats-empty">Searching…</div>}
        {q && !searching && showResults.length === 0 && (
          <div className="chats-empty">No chats match "{q}".</div>
        )}
        {!q && sessions.length === 0 && <div className="chats-empty">No chats yet.</div>}
        {showResults.map(({ meta: s, snippet }) => (
          <div
            key={s.id}
            className={`chats-row ${s.id === activeId ? "selected" : ""}`}
            onClick={() => onSelect(s.id)}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="title">{s.title}</span>
              <div className="actions">
                <button title="Rename" onClick={(e) => {
                  e.stopPropagation();
                  void (async () => {
                    const t = await dlg.prompt({
                      title: "Rename chat",
                      message: "Enter a new title:",
                      defaultValue: s.title,
                    });
                    if (t && t.trim()) onRename(s.id, t.trim());
                  })();
                }}>✎</button>
                <button title="Delete" onClick={(e) => {
                  e.stopPropagation();
                  void (async () => {
                    const ok = await dlg.confirm({
                      title: "Delete chat",
                      message: `Delete chat "${s.title}"?`,
                      danger: true,
                      confirmLabel: "Delete",
                    });
                    if (ok) onDelete(s.id);
                  })();
                }}><IconX size={12} /></button>
              </div>
            </div>
            <div className="meta">{s.turnCount} turn{s.turnCount === 1 ? "" : "s"} · {ago(s.updatedAt)}</div>
            {snippet && <div className="chats-snippet">{snippet}</div>}
          </div>
        ))}
      </div>
    </>
  );
}
