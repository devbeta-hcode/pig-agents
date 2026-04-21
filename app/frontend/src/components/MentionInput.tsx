import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type FileEntry } from "../lib/api";
import { FileIcon } from "./FileIcon";

interface SlashCommand {
  name: string;
  desc: string;
  hint?: string;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
  refreshKey?: number;
  slashCommands?: SlashCommand[];
  onSlashCommand?: (name: string) => boolean | void;
}

interface FlatItem { path: string; isDir: boolean; }

async function flatten(dir: string, depth: number, out: FlatItem[]) {
  if (depth < 0 || out.length > 800) return;
  try {
    const r = await api.listFiles(dir);
    for (const it of r.items) {
      out.push({ path: it.path, isDir: it.isDir });
      if (it.isDir && depth > 0) await flatten(it.path, depth - 1, out);
    }
  } catch { /* ignore */ }
}

export function MentionInput({
  value, onChange, onSubmit, disabled, placeholder, refreshKey,
  slashCommands, onSlashCommand,
}: Props) {
  const [files, setFiles] = useState<FlatItem[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashActive, setSlashActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Track if we've loaded files to avoid redundant fetches
  const filesLoadedRef = useRef(false);
  const loadingRef = useRef(false);

  // Load files lazily when mention popup opens (not eagerly on mount)
  const loadFilesIfNeeded = useCallback(() => {
    if (filesLoadedRef.current || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    const out: FlatItem[] = [];
    flatten(".", 3, out).then(() => {
      setFiles(out);
      filesLoadedRef.current = true;
      loadingRef.current = false;
      setLoading(false);
    });
  }, []);

  // Invalidate cache on ANY refreshKey change (FS watcher events)
  // This way, next time user types @, it will reload the file list
  const lastRefreshRef = useRef<number>(0);
  useEffect(() => {
    if (refreshKey === undefined) return;
    if (refreshKey !== lastRefreshRef.current) {
      // Invalidate cache - don't reload immediately, wait for next @ mention
      filesLoadedRef.current = false;
    }
    lastRefreshRef.current = refreshKey;
  }, [refreshKey]);

  const matches = useMemo(() => {
    if (!query) return files.filter((f) => !f.isDir).slice(0, 20);
    const q = query.toLowerCase();
    return files
      .filter((f) => !f.isDir && f.path.toLowerCase().includes(q))
      .slice(0, 20);
  }, [files, query]);

  const slashMatches = useMemo(() => {
    const all = slashCommands ?? [];
    if (!slashQuery) return all;
    const q = slashQuery.toLowerCase();
    return all.filter((c) => c.name.toLowerCase().includes(q));
  }, [slashCommands, slashQuery]);

  function handleChange(v: string) {
    onChange(v);
    const ta = taRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = v.slice(0, pos);
    // Slash commands only when the input STARTS with "/" and there's no space yet.
    const slashMatch = /^\/([\w-]*)$/.exec(v.trim());
    if (slashMatch && (slashCommands?.length ?? 0) > 0) {
      setSlashQuery(slashMatch[1]);
      setSlashOpen(true);
      setSlashActive(0);
      setOpen(false);
      return;
    }
    setSlashOpen(false);
    const m = /(?:^|\s)@([\w/.\-]*)$/.exec(before);
    if (m) {
      setQuery(m[1]);
      setOpen(true);
      setActive(0);
      // Load files lazily when user starts typing @mention
      loadFilesIfNeeded();
    } else {
      setOpen(false);
    }
  }

  function pickSlash(cmd: SlashCommand) {
    setSlashOpen(false);
    const handled = onSlashCommand?.(cmd.name);
    // Contract:
    //   true  → command was instant; clear input
    //   false → caller wants the literal `/cmd ` left as a prefix
    //   undefined / void → caller manipulated the input itself; leave it
    if (handled === true) onChange("");
    else if (handled === false) onChange(`/${cmd.name} `);
    requestAnimationFrame(() => taRef.current?.focus());
  }

  function pick(item: FlatItem) {
    const ta = taRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = value.slice(0, pos);
    const after = value.slice(pos);
    const replaced = before.replace(/(?:^|\s)@([\w/.\-]*)$/, (m) => {
      const lead = m.startsWith("@") ? "" : m[0];
      return `${lead}@${item.path} `;
    });
    onChange(replaced + after);
    setOpen(false);
    requestAnimationFrame(() => {
      ta.focus();
      const newPos = replaced.length;
      ta.setSelectionRange(newPos, newPos);
    });
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slashOpen && slashMatches.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashActive((a) => (a + 1) % slashMatches.length); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setSlashActive((a) => (a - 1 + slashMatches.length) % slashMatches.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(slashMatches[slashActive]); return; }
      if (e.key === "Escape") { setSlashOpen(false); return; }
    }
    if (open && matches.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % matches.length); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setActive((a) => (a - 1 + matches.length) % matches.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[active]); return; }
      if (e.key === "Escape") { setOpen(false); return; }
    }
    const composing = (e.nativeEvent as { isComposing?: boolean })?.isComposing;
    if (e.key === "Enter" && !e.shiftKey && !composing) {
      e.preventDefault();
      if (!disabled) onSubmit();
    }
  }

  // auto-grow textarea — keep overflow hidden until max height so empty input
  // does not show a bogus inner scrollbar (scrollHeight vs clientHeight rounding).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const max = 220;
    ta.style.height = "auto";
    const next = Math.min(max, ta.scrollHeight);
    ta.style.height = `${next}px`;
    ta.style.overflowY = next >= max ? "auto" : "hidden";
  }, [value]);

  return (
    <>
      {slashOpen && slashMatches.length > 0 && (
        <div className="mention-dropdown slash-dropdown">
          {slashMatches.map((c, i) => (
            <div
              key={c.name}
              className={`mention-item slash-item ${i === slashActive ? "active" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); pickSlash(c); }}
              onMouseEnter={() => setSlashActive(i)}
            >
              <span className="slash-name">/{c.name}</span>
              <span className="slash-desc">{c.desc}</span>
              {c.hint && <span className="slash-hint">{c.hint}</span>}
            </div>
          ))}
        </div>
      )}
      {open && (
        <div className="mention-dropdown">
          {loading ? (
            <div className="mention-loading">
              <span className="mention-loading-spinner" />
              <span>Loading files…</span>
            </div>
          ) : matches.length > 0 ? (
            matches.map((m, i) => (
              <div
                key={m.path}
                className={`mention-item ${i === active ? "active" : ""}`}
                onMouseDown={(e) => { e.preventDefault(); pick(m); }}
                onMouseEnter={() => setActive(i)}
              >
                <FileIcon name={m.path.split("/").pop() || ""} size={14} /><span>{m.path}</span>
              </div>
            ))
          ) : (
            <div className="mention-empty">No files match "{query}"</div>
          )}
        </div>
      )}
      <textarea
        ref={taRef}
        value={value}
        disabled={disabled}
        rows={1}
        placeholder={placeholder ?? "Describe a coding task… use @ to reference files"}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={onKey}
      />
    </>
  );
}
