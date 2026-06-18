import { useEffect, useState, useCallback, useRef, type MouseEvent } from "react";
import { api, type FileEntry } from "../lib/api";
import { ContextMenu, type MenuItem, type MenuSeparator } from "./ContextMenu";
import { useDialogs } from "./DialogProvider";
import { IconFolderOpen, IconRefreshCw, IconPlus } from "./Icons";
import { ChevronExpand } from "./ChevronExpand";
import { FileIcon } from "./FileIcon";
import { pig } from "../lib/pig.js";

interface Props {
  selected?: string;
  workspace?: string;
  onOpen: (path: string) => void;
  refreshKey?: number;
  /** Called after successful delete so open editor tabs for removed paths can close. */
  onPathsDeleted?: (paths: string[]) => void;
  onRevealInTerminal?: (path: string) => void;
}

interface ClipboardItem {
  path: string;
  isDir: boolean;
}

interface Clipboard {
  items: ClipboardItem[];
  op: "copy" | "cut";
}

/** If both `foo` and `foo/bar` are selected, keep only `foo`. */
function pruneRedundantPaths(paths: string[]): string[] {
  const uniq = [...new Set(paths)].filter(Boolean).sort((a, b) => a.length - b.length);
  const keep: string[] = [];
  for (const p of uniq) {
    if (keep.some((k) => p === k || p.startsWith(`${k}/`))) continue;
    keep.push(p);
  }
  return keep;
}

interface Node extends FileEntry {
  children?: Node[];
  loaded?: boolean;
  expanded?: boolean;
  renaming?: boolean;
}

interface PendingNew {
  parent: string; // "" = root
  kind: "file" | "dir";
}

export function FileTree({ selected, workspace, onOpen, refreshKey, onPathsDeleted, onRevealInTerminal }: Props) {
  const dlg = useDialogs();
  const [root, setRoot] = useState<Node[]>([]);
  const rootRef = useRef<Node[]>([]);
  const loadingRef = useRef(false);
  // Track the workspace the current `root` belongs to. When it changes we
  // wipe the tree immediately so the user sees a loading state instead of the
  // previous workspace's stale tree (and we skip restoring expanded paths
  // that don't exist in the new workspace, which used to make the load hang).
  const loadedWorkspaceRef = useRef<string | undefined>(workspace);
  useEffect(() => { rootRef.current = root; }, [root]);
  const [busy, setBusy] = useState(false);
  const [operating, setOperating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; node: Node | null } | null>(null);
  const [pending, setPending] = useState<PendingNew | null>(null);
  // Clipboard for copy/cut/paste. A "cut" entry visually fades the source row
  // until pasted (then the row is gone after the rename round-trip).
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const clipboardRef = useRef<Clipboard | null>(null);
  const selectedRef = useRef<string | undefined>(selected);
  /** Last item clicked in the tree — used for ⌘C/⌘X and as shift-range anchor fallback. */
  const lastClickedPathRef = useRef<string | undefined>(selected);
  /** Anchor for Shift+click range (last plain or Ctrl/Cmd click, not updated on Shift+click). */
  const rangeAnchorPathRef = useRef<string | undefined>(selected);
  useEffect(() => { clipboardRef.current = clipboard; }, [clipboard]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() =>
    selected ? new Set([selected]) : new Set(),
  );

  const selectedPathsRef = useRef(selectedPaths);
  useEffect(() => { selectedPathsRef.current = selectedPaths; }, [selectedPaths]);

  const explorerRootRef = useRef<HTMLDivElement>(null);

  /** Click outside Explorer clears tree selection (open file may still show `.active`). */
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const root = explorerRootRef.current;
      const t = e.target;
      if (!(t instanceof globalThis.Node) || !root || root.contains(t)) return;
      setSelectedPaths(new Set());
      lastClickedPathRef.current = undefined;
      rangeAnchorPathRef.current = undefined;
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  useEffect(() => {
    if (selected) {
      setSelectedPaths(new Set([selected]));
      lastClickedPathRef.current = selected;
      rangeAnchorPathRef.current = selected;
    }
  }, [selected]);

  const findNode = useCallback((p: string): Node | null => {
    if (!p) return null;
    const segs = p.split("/");
    let list = root;
    let found: Node | null = null;
    for (let i = 0; i < segs.length; i++) {
      const cur = segs.slice(0, i + 1).join("/");
      const n = list.find((x) => x.path === cur);
      if (!n) return null;
      found = n;
      list = n.children || [];
    }
    return found;
  }, [root]);

  /** Depth-first order of visible rows (respects expanded dirs) — used for Shift+click ranges. */
  function flattenVisibleNodes(nodes: Node[]): string[] {
    const out: string[] = [];
    for (const n of nodes) {
      out.push(n.path);
      if (n.isDir && n.expanded && n.children?.length) {
        out.push(...flattenVisibleNodes(n.children));
      }
    }
    return out;
  }

  function absolutePath(p: string): string {
    // Workspace + relative path, joined cross-platform-friendly. The backend
    // already returns Posix-style relative paths in `node.path`.
    if (!workspace) return p;
    const ws = workspace.replace(/[\\/]+$/, "");
    return p ? `${ws}/${p}` : ws;
  }

  function writeClipboardText(text: string) {
    if (text) {
      pig.clipboardWrite(text).catch(() => {});
    }
  }

  const load = useCallback(async () => {
    if (!workspace) return;
    // Prevent concurrent loads
    if (loadingRef.current) return;
    loadingRef.current = true;
    setBusy(true);
    setError(null);
    // Detect a workspace switch: the previous tree's expanded paths refer to
    // a different filesystem and would all 404 in sequence (slow + jank).
    const isWorkspaceSwitch = loadedWorkspaceRef.current !== workspace;
    if (isWorkspaceSwitch) {
      setRoot([]);
      rootRef.current = [];
    }
    try {
      // Collect which paths were expanded before refresh
      const expandedPaths = new Set<string>();
      if (!isWorkspaceSwitch) {
        const collectExpanded = (ns: Node[]) => {
          for (const n of ns) {
            if (n.expanded) expandedPaths.add(n.path);
            if (n.children) collectExpanded(n.children);
          }
        };
        collectExpanded(rootRef.current);
      }

      // Recursively load a directory and its expanded children. Children are
      // fetched concurrently with `Promise.all` so a workspace with many
      // expanded folders doesn't N+1-await its way through the tree.
      async function loadDir(dirPath: string): Promise<Node[]> {
        const r = await api.listFiles(dirPath);
        const nodes: Node[] = await Promise.all(
          r.items.map(async (it) => {
            const wasExpanded = expandedPaths.has(it.path);
            let children: Node[] | undefined;
            let loaded = !it.isDir;
            if (it.isDir && wasExpanded) {
              try {
                children = await loadDir(it.path);
                loaded = true;
              } catch {
                loaded = false;
              }
            }
            return { ...it, expanded: wasExpanded, loaded, children };
          }),
        );
        return nodes;
      }

      const newRoot = await loadDir(".");
      setRoot(newRoot);
      loadedWorkspaceRef.current = workspace;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      loadingRef.current = false;
      setBusy(false);
    }
  }, [workspace]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  async function expand(node: Node, parentList: Node[], setParent: (n: Node[]) => void) {
    if (!node.isDir) { onOpen(node.path); return; }
    if (!node.loaded) {
      try {
        const r = await api.listFiles(node.path);
        node.children = r.items.map((it) => ({ ...it, expanded: false, loaded: !it.isDir }));
        node.loaded = true;
      } catch (err) {
        setError((err as Error).message);
        return;
      }
    }
    node.expanded = !node.expanded;
    setParent([...parentList]);
  }

  async function ensureExpanded(parentPath: string) {
    if (!parentPath) return; // root is always expanded
    // Walk down the tree expanding nodes; load children as needed.
    const segs = parentPath.split("/");
    let list = root;
    for (let i = 0; i < segs.length; i++) {
      const path = segs.slice(0, i + 1).join("/");
      const node = list.find((n) => n.path === path);
      if (!node) return;
      if (!node.loaded) {
        try {
          const r = await api.listFiles(node.path);
          node.children = r.items.map((it) => ({ ...it, expanded: false, loaded: !it.isDir }));
          node.loaded = true;
        } catch { return; }
      }
      node.expanded = true;
      list = node.children || [];
    }
    setRoot([...root]);
  }

  async function startNew(kind: "file" | "dir", parentPath: string) {
    await ensureExpanded(parentPath);
    setPending({ parent: parentPath, kind });
  }

  async function commitNew(name: string) {
    if (!pending) return;
    const trimmed = name.trim();
    const pendingKind = pending.kind;
    setPending(null);
    if (!trimmed) return;
    const p = pending.parent ? `${pending.parent}/${trimmed}` : trimmed;
    setOperating(true);
    try {
      await api.createEntry(p, pendingKind);
      await load();
      if (pendingKind === "file") onOpen(p);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setOperating(false);
    }
  }

  const getClipboardItemsFromSelection = useCallback((): ClipboardItem[] => {
    const raw = selectedPathsRef.current.size > 0
      ? [...selectedPathsRef.current]
      : (lastClickedPathRef.current ? [lastClickedPathRef.current] : []);
    const pruned = pruneRedundantPaths(raw);
    const out: ClipboardItem[] = [];
    for (const p of pruned) {
      const n = findNode(p);
      if (n) out.push({ path: n.path, isDir: n.isDir });
    }
    return out;
  }, [findNode]);

  async function removePaths(paths: string[]) {
    const pruned = pruneRedundantPaths(paths);
    if (pruned.length === 0) return;
    const msg = pruned.length === 1
      ? `Delete ${pruned[0]}?`
      : `Delete ${pruned.length} items?\n${pruned.slice(0, 10).join("\n")}${pruned.length > 10 ? "\n…" : ""}`;
    if (!(await dlg.confirm({
      title: "Delete",
      message: msg,
      danger: true,
      confirmLabel: "Delete",
    }))) return;
    setOperating(true);
    try {
      const ordered = [...pruned].sort((a, b) => b.length - a.length);
      for (const p of ordered) {
        await api.deleteEntry(p);
      }
      onPathsDeleted?.(pruned);
      await load();
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        for (const p of pruned) next.delete(p);
        return next;
      });
    } catch (err) {
      void dlg.alert((err as Error).message);
    } finally {
      setOperating(false);
    }
  }

  async function startRename(node: Node, parentList: Node[], setParent: (n: Node[]) => void) {
    node.renaming = true;
    setParent([...parentList]);
  }

  async function finishRename(node: Node, newName: string, parentList: Node[], setParent: (n: Node[]) => void) {
    node.renaming = false;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === node.name) {
      setParent([...parentList]);
      return;
    }
    const parts = node.path.split("/");
    parts[parts.length - 1] = trimmed;
    const to = parts.join("/");
    setOperating(true);
    try {
      await api.rename(node.path, to);
      await load();
    } catch (err) {
      void dlg.alert((err as Error).message);
      setParent([...parentList]);
    } finally {
      setOperating(false);
    }
  }

  // Resolve the destination directory for a paste operation.
  // - dir node  → paste inside that directory
  // - file node → paste alongside the file (its parent directory)
  // - null      → paste at workspace root
  function pasteParentOf(node: Node | null): string {
    if (!node) return "";
    if (node.isDir) return node.path;
    const slash = node.path.lastIndexOf("/");
    return slash < 0 ? "" : node.path.slice(0, slash);
  }

  async function paste(target: Node | null) {
    const cb = clipboardRef.current;
    if (!cb?.items.length) return;
    const parent = pasteParentOf(target);
    setOperating(true);
    try {
      for (const item of cb.items) {
        const baseName = item.path.split("/").pop() || item.path;
        const dest = parent ? `${parent}/${baseName}` : baseName;
        if (item.isDir && (dest === item.path || dest.startsWith(`${item.path}/`))) {
          void dlg.alert(`Cannot paste folder ${item.path} into itself or a descendant.`);
          return;
        }
        if (cb.op === "cut") {
          if (dest === item.path) continue;
          await api.rename(item.path, dest);
        } else {
          await api.copyEntry(item.path, dest);
        }
      }
      if (cb.op === "cut") setClipboard(null);
      if (parent) await ensureExpanded(parent);
      await load();
    } catch (err) {
      void dlg.alert((err as Error).message);
    } finally {
      setOperating(false);
    }
  }

  function buildMenu(node: Node, parentList: Node[], setParent: (n: Node[]) => void): (MenuItem | MenuSeparator)[] {
    const bulk = pruneRedundantPaths([...selectedPaths]);
    const isMulti = bulk.length > 1;
    const items: (MenuItem | MenuSeparator)[] = [];

    if (!isMulti && node.isDir) {
      items.push({ label: "New File", onClick: () => void startNew("file", node.path) });
      items.push({ label: "New Folder", onClick: () => void startNew("dir", node.path) });
      items.push({ separator: true });
    } else if (!isMulti && !node.isDir) {
      items.push({ label: "Open", onClick: () => onOpen(node.path) });
      items.push({ separator: true });
    }

    const clipItems = bulk
      .map((p) => {
        const nn = findNode(p);
        return nn ? { path: nn.path, isDir: nn.isDir } : null;
      })
      .filter((x): x is ClipboardItem => x !== null);

    items.push({
      label: isMulti ? `Cut (${bulk.length})` : "Cut",
      shortcut: "⌘X",
      disabled: clipItems.length === 0,
      onClick: () => {
        if (clipItems.length) setClipboard({ items: clipItems, op: "cut" });
      },
    });
    items.push({
      label: isMulti ? `Copy (${bulk.length})` : "Copy",
      shortcut: "⌘C",
      disabled: clipItems.length === 0,
      onClick: () => {
        if (clipItems.length) setClipboard({ items: clipItems, op: "copy" });
      },
    });
    items.push({
      label: "Paste",
      shortcut: "⌘V",
      disabled: !clipboard?.items.length,
      onClick: () => void paste(node),
    });
    items.push({ separator: true });

    if (!isMulti) {
      items.push({ label: "Rename", shortcut: "F2", onClick: () => void startRename(node, parentList, setParent) });
    }

    items.push({
      label: isMulti ? `Copy ${bulk.length} absolute paths` : "Copy Path",
      onClick: () => writeClipboardText(bulk.map((p) => absolutePath(p)).join("\n")),
    });
    items.push({
      label: isMulti ? `Copy ${bulk.length} relative paths` : "Copy Relative Path",
      shortcut: isMulti ? undefined : "⌥⌘C",
      onClick: () => writeClipboardText(bulk.join("\n")),
    });
    if (onRevealInTerminal && !isMulti) {
      items.push({ label: "Reveal in Terminal", onClick: () => onRevealInTerminal(node.path) });
    }
    items.push({ separator: true });
    items.push({
      label: isMulti ? `Delete (${bulk.length})` : "Delete",
      danger: true,
      shortcut: "Del",
      onClick: () => void removePaths(bulk),
    });
    return items;
  }

  function buildRootMenu(): (MenuItem | MenuSeparator)[] {
    return [
      { label: "New File", onClick: () => void startNew("file", "") },
      { label: "New Folder", onClick: () => void startNew("dir", "") },
      { separator: true },
      { label: "Paste", shortcut: "⌘V", disabled: !clipboard?.items.length, onClick: () => void paste(null) },
      { separator: true },
      { label: "Refresh", onClick: () => void load() },
    ];
  }

  // Keyboard shortcuts: Ctrl/Cmd+C / X / V on the focused tree.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      // Don't hijack typing inside inputs/textareas/contenteditable areas.
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      const pasteTargetPath = lastClickedPathRef.current ?? selectedRef.current;
      const pasteTargetNode = pasteTargetPath ? findNode(pasteTargetPath) : null;
      const meta = e.metaKey || e.ctrlKey;
      const clipItems = getClipboardItemsFromSelection();

      if (meta && e.key.toLowerCase() === "c" && !e.shiftKey && !e.altKey) {
        if (!clipItems.length) return;
        e.preventDefault();
        setClipboard({ items: clipItems, op: "copy" });
      } else if (meta && e.key.toLowerCase() === "x" && !e.shiftKey && !e.altKey) {
        if (!clipItems.length) return;
        e.preventDefault();
        setClipboard({ items: clipItems, op: "cut" });
      } else if (meta && e.key.toLowerCase() === "v" && !e.shiftKey && !e.altKey) {
        if (!clipboardRef.current?.items.length) return;
        e.preventDefault();
        void paste(pasteTargetNode);
      } else if (e.key === "Escape" && clipboardRef.current?.op === "cut") {
        setClipboard(null);
      } else if (e.key === "Delete") {
        const toDel = pruneRedundantPaths([...selectedPathsRef.current]);
        if (!toDel.length) return;
        e.preventDefault();
        void removePaths(toDel);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `paste` and `findNode` are stable enough; deps kept minimal to avoid
    // re-binding the listener on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findNode, clipboard, getClipboardItemsFromSelection]);

  function handleRowClick(
    e: MouseEvent<HTMLDivElement>,
    n: Node,
    nodes: Node[],
    setParent: (next: Node[]) => void,
  ) {
    if (n.renaming) return;
    const path = n.path;
    const mod = e.ctrlKey || e.metaKey;

    if (e.shiftKey) {
      e.preventDefault();
      const flat = flattenVisibleNodes(root);
      const anchor = rangeAnchorPathRef.current ?? lastClickedPathRef.current ?? selected;
      const i0 = anchor ? flat.indexOf(anchor) : -1;
      const i1 = flat.indexOf(path);
      if (i0 >= 0 && i1 >= 0) {
        const lo = Math.min(i0, i1);
        const hi = Math.max(i0, i1);
        setSelectedPaths(new Set(flat.slice(lo, hi + 1)));
      } else {
        setSelectedPaths(new Set([path]));
      }
      lastClickedPathRef.current = path;
      return;
    }

    if (mod) {
      e.preventDefault();
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      rangeAnchorPathRef.current = path;
      lastClickedPathRef.current = path;
      return;
    }

    rangeAnchorPathRef.current = path;
    lastClickedPathRef.current = path;
    setSelectedPaths(new Set([path]));
    void expand(n, nodes, setParent);
  }

  function NewRow({ kind, onCancel, onSubmit }: { kind: "file" | "dir"; onCancel: () => void; onSubmit: (v: string) => void }) {
    return (
      <div className={`tree-row ${kind === "dir" ? "dir" : "file"} new`}>
        <span className="chev">{kind === "dir" ? <ChevronExpand expanded={false} size={13} /> : null}</span>
        <span className="icon"><FileIcon name="" isDir={kind === "dir"} /></span>
        <input
          className="rename"
          autoFocus
          placeholder={kind === "dir" ? "folder name" : "file name"}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit((e.target as HTMLInputElement).value);
            else if (e.key === "Escape") onCancel();
          }}
          onBlur={(e) => {
            const v = e.target.value;
            if (v.trim()) onSubmit(v);
            else onCancel();
          }}
        />
      </div>
    );
  }

  function render(nodes: Node[], setParent: (n: Node[]) => void, parentPath: string = ""): JSX.Element[] {
    const out: JSX.Element[] = [];
    for (const n of nodes) {
      out.push(
        <div key={n.path}>
          <div
            className={`tree-row ${n.isDir ? "dir" : "file"} ${selectedPaths.has(n.path) ? "selected" : ""} ${selected === n.path ? "active" : ""} ${clipboard?.op === "cut" && clipboard.items.some((i) => i.path === n.path) ? "cut" : ""}`}
            onClick={(e) => handleRowClick(e, n, nodes, setParent)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (!selectedPaths.has(n.path)) {
                setSelectedPaths(new Set([n.path]));
                rangeAnchorPathRef.current = n.path;
                lastClickedPathRef.current = n.path;
              }
              setCtx({ x: e.clientX, y: e.clientY, node: n });
            }}
            title={n.path}
            draggable={!n.isDir && !n.renaming}
            onDragStart={(e) => {
              if (n.isDir) return;
              e.dataTransfer.setData("application/x-ba-file", n.path);
              e.dataTransfer.setData("text/plain", `@${n.path}`);
              e.dataTransfer.effectAllowed = "copy";
            }}
          >
            <span className="chev">{n.isDir ? <ChevronExpand expanded={!!n.expanded} size={13} /> : null}</span>
            <span className="icon"><FileIcon name={n.name} isDir={n.isDir} expanded={n.expanded} /></span>
            {n.renaming ? (
              <input
                className="rename"
                autoFocus
                defaultValue={n.name}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void finishRename(n, (e.target as HTMLInputElement).value, nodes, setParent);
                  else if (e.key === "Escape") { n.renaming = false; setParent([...nodes]); }
                }}
                onBlur={(e) => void finishRename(n, e.target.value, nodes, setParent)}
              />
            ) : (
              <span className="name">{n.name}</span>
            )}
          </div>
          {n.isDir && n.expanded && n.children && (
            <div className="tree-children">
              {render(n.children, (c) => { n.children = c; setParent([...nodes]); }, n.path)}
            </div>
          )}
        </div>,
      );
    }
    if (pending && pending.parent === parentPath) {
      out.push(
        <NewRow
          key="__new__"
          kind={pending.kind}
          onCancel={() => setPending(null)}
          onSubmit={(v) => void commitNew(v)}
        />,
      );
    }
    return out;
  }

  return (
    <div ref={explorerRootRef} className={`file-tree-root${operating ? " operating" : ""}`}>
      <div className="sidebar-header">
        <span>Explorer</span>
        <div className="sidebar-actions">
          {(operating || (busy && root.length > 0)) && <span className="explorer-spinner" title="Working…" />}
          <button title="New file (root)" onClick={() => void startNew("file", "")} disabled={operating}><IconPlus size={13} /></button>
          <button title="New folder (root)" onClick={() => void startNew("dir", "")} disabled={operating}><IconFolderOpen size={13} /></button>
          <button title="Refresh" onClick={load} disabled={busy || operating}><IconRefreshCw size={13} /></button>
        </div>
      </div>
      {error && <div style={{ padding: "4px 12px", color: "var(--bad)", fontSize: 11 }}>{error}</div>}
      <div
        className="tree"
        onContextMenu={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, node: null }); } }}
      >
        {busy && root.length === 0 ? (
          <div className="tree-loading">
            <span className="explorer-spinner" aria-hidden />
            <span>Loading workspace…</span>
          </div>
        ) : (
          render(root, setRoot)
        )}
      </div>
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={ctx.node ? buildMenu(ctx.node, root, setRoot) : buildRootMenu()}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  );
}
