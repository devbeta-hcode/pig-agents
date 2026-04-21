import { useEffect, useState } from "react";
import { api, type BrowseResult } from "../lib/api";
import { Modal } from "./Modal";
import { FileIcon } from "./FileIcon";

interface Props {
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}

export function FolderPicker({ initialPath, onClose, onSelect }: Props) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [roots, setRoots] = useState<{ label: string; path: string }[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState("");

  async function load(p: string) {
    setError(null);
    try {
      const r = await api.fsBrowse(p, showHidden);
      setData(r);
      setManualPath(r.path);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    api.fsHome().then((r) => {
      setRoots(r.roots);
      void load(initialPath && initialPath.length > 0 ? initialPath : r.home);
    });
  }, []);

  useEffect(() => {
    if (data) void load(data.path);
  }, [showHidden]);

  return (
    <Modal
      title="Open Folder"
      onClose={onClose}
      footer={
        <>
          <label style={{ marginRight: "auto", display: "flex", gap: 6, alignItems: "center", color: "var(--fg-dim)", fontSize: 12 }}>
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Show hidden
          </label>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!data} onClick={() => data && onSelect(data.path)}>
            Open This Folder
          </button>
        </>
      }
    >
      <div className="fp-roots">
        {roots.map((r) => (
          <button key={r.path} onClick={() => load(r.path)}>{r.label}</button>
        ))}
      </div>

      {data && (
        <div className="fp-bar">
          {data.crumbs.map((c, i) => (
            <span key={c.path} style={{ display: "contents" }}>
              <span className={`crumb ${i === data.crumbs.length - 1 ? "last" : ""}`} onClick={() => load(c.path)}>
                {c.label || "/"}
              </span>
              {i < data.crumbs.length - 1 && <span className="sep">/</span>}
            </span>
          ))}
        </div>
      )}

      {error && <div style={{ color: "var(--bad)", fontSize: 12, marginBottom: 8 }}>{error}</div>}

      <div className="fp-list">
        {data?.parent && (
          <div className="fp-row up" onClick={() => load(data.parent!)}>
            <span>↑</span><span>..</span>
          </div>
        )}
        {data?.entries.filter((e) => e.isDir).map((e) => (
          <div key={e.path} className="fp-row" onClick={() => load(e.path)} onDoubleClick={() => onSelect(e.path)}>
            <FileIcon name={e.name} isDir size={16} /><span>{e.name}</span>
          </div>
        ))}
        {data?.entries.filter((e) => !e.isDir).map((e) => (
          <div key={e.path} className="fp-row" style={{ opacity: 0.5 }}>
            <FileIcon name={e.name} size={16} /><span>{e.name}</span>
          </div>
        ))}
      </div>

      <input
        className="fp-input"
        value={manualPath}
        onChange={(e) => setManualPath(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void load(manualPath); }}
        placeholder="/absolute/path/to/folder"
      />
    </Modal>
  );
}
