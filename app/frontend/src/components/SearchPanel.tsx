import { useMemo, useState } from "react";
import { api } from "../lib/api";

interface Props {
  onOpen: (path: string, line?: number) => void;
}

export function SearchPanel({ onOpen }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ file: string; line: number; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const grouped = useMemo(() => {
    const map = new Map<string, { file: string; line: number; text: string }[]>();
    for (const h of hits) {
      const arr = map.get(h.file) ?? [];
      arr.push(h);
      map.set(h.file, arr);
    }
    return Array.from(map.entries());
  }, [hits]);

  async function run() {
    const term = q.trim();
    if (!term) return;
    setBusy(true); setError(null); setSearched(true);
    try {
      const r = await api.search(term);
      setHits(r.hits);
    } catch (err) {
      setError((err as Error).message);
      setHits([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="search-panel">
      <div className="sidebar-header"><span>Search</span></div>
      <div className="search-input-row">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
          placeholder="Search in workspace…"
        />
      </div>
      {error && <div style={{ padding: "4px 12px", color: "var(--bad)", fontSize: 11 }}>{error}</div>}
      <div className="search-results">
        {busy && <div className="search-empty">Searching…</div>}
        {!busy && searched && hits.length === 0 && <div className="search-empty">No results.</div>}
        {!busy && !searched && <div className="search-empty">Type a query and press Enter.</div>}
        {grouped.map(([file, items]) => (
          <div key={file} className="search-file">
            <div className="search-file-header" onClick={() => onOpen(file)}>
              <span>{file}</span>
              <span>{items.length}</span>
            </div>
            {items.map((h, i) => (
              <div key={i} className="search-hit" onClick={() => onOpen(file, h.line)} title={h.text}>
                <span className="ln">{h.line}</span>
                <span>{h.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
