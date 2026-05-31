import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type FileEntry } from "../lib/api";
import {
  formatSelectElToken,
  selectElKeyFromIndex,
  type BrowserElementRef,
} from "../lib/browserElementRefs.js";
import {
  createSelectElChipElement,
  SELECT_EL_TOOLTIP_HIDE_MS,
  SelectElChipTooltipPanel,
  syncSelectElChipDom,
  type SelectElChipTipState,
} from "./SelectElChip.js";
import { selectElTooltipRows } from "../lib/browserElementRefs.js";
import { FileIcon } from "./FileIcon";

const TOKEN_SPLIT_RE = /(\{\{select el \d+\}\})/gi;
const TOKEN_TEST_RE = /^\{\{select el \d+\}\}$/i;

interface SlashCommand {
  name: string;
  desc: string;
  hint?: string;
}

interface Props {
  value: string;
  valueVersion?: number;
  selectElRefs: ReadonlyMap<string, BrowserElementRef>;
  selectElRefsVersion?: number;
  onChange: (v: string) => void;
  /** Sync React `task` state after structural edits (e.g. chip removed). */
  onCommit?: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
  refreshKey?: number;
  slashCommands?: SlashCommand[];
  onSlashCommand?: (name: string) => boolean | void;
  onRemoveSelectEl?: (key: string) => void;
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

function serializeEditable(root: HTMLElement): string {
  let out = "";
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
    } else if (node instanceof HTMLElement) {
      const key = node.dataset.selectEl;
      if (key) {
        const n = key.replace(/^select el /i, "");
        out += formatSelectElToken(Number(n));
      } else {
        out += node.textContent ?? "";
      }
    }
  }
  return out;
}

function renderValueToEditable(
  root: HTMLElement,
  value: string,
  refs: ReadonlyMap<string, BrowserElementRef>,
): void {
  root.innerHTML = "";
  if (!value) return;
  const parts = value.split(TOKEN_SPLIT_RE);
  for (const part of parts) {
    if (!part) continue;
    if (TOKEN_TEST_RE.test(part)) {
      const n = part.match(/\d+/)?.[0] ?? "1";
      const key = selectElKeyFromIndex(n);
      const ref = refs.get(key);
      const label = ref?.tagLabel ?? `<el>`;
      root.appendChild(
        createSelectElChipElement(key, label, {
          screenshotDataUrl: ref?.screenshotDataUrl,
        }),
      );
      continue;
    }
    root.appendChild(document.createTextNode(part));
  }
}

function placeCaretAtEnd(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function removeAdjacentChip(root: HTMLElement, direction: "before" | "after"): boolean {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  const { startContainer, startOffset } = range;
  if (!root.contains(startContainer)) return false;

  let target: ChildNode | null = null;
  if (startContainer === root) {
    target = direction === "before" ? root.childNodes[startOffset - 1] : root.childNodes[startOffset];
  } else if (startContainer.nodeType === Node.TEXT_NODE) {
    const text = startContainer as Text;
    if (direction === "before" && startOffset === 0) {
      target = text.previousSibling;
    } else if (direction === "after" && startOffset === (text.textContent?.length ?? 0)) {
      target = text.nextSibling;
    }
  }
  if (target instanceof HTMLElement && target.dataset.selectEl) {
    target.remove();
    return true;
  }
  return false;
}

export function ComposerEditable({
  value,
  valueVersion,
  selectElRefs,
  selectElRefsVersion,
  onChange,
  onCommit,
  onSubmit,
  disabled,
  placeholder,
  refreshKey,
  slashCommands,
  onSlashCommand,
  onRemoveSelectEl,
}: Props) {
  const [files, setFiles] = useState<FlatItem[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashActive, setSlashActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const editRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onRemoveSelectElRef = useRef(onRemoveSelectEl);
  onRemoveSelectElRef.current = onRemoveSelectEl;
  const syncingRef = useRef(false);
  const [chipTip, setChipTip] = useState<SelectElChipTipState | null>(null);
  const chipTipHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelChipTipHide = useCallback(() => {
    if (chipTipHideTimer.current) clearTimeout(chipTipHideTimer.current);
    chipTipHideTimer.current = null;
  }, []);

  const scheduleChipTipHide = useCallback(() => {
    cancelChipTipHide();
    chipTipHideTimer.current = setTimeout(() => setChipTip(null), SELECT_EL_TOOLTIP_HIDE_MS);
  }, [cancelChipTipHide]);

  const filesLoadedRef = useRef(false);
  const loadingRef = useRef(false);

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

  const lastRefreshRef = useRef(0);
  useEffect(() => {
    if (refreshKey === undefined) return;
    if (refreshKey !== lastRefreshRef.current) filesLoadedRef.current = false;
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

  const emitChange = useCallback(() => {
    const root = editRef.current;
    if (!root || syncingRef.current) return;
    const v = serializeEditable(root);
    onChangeRef.current(v);
    const pos = getCaretTextOffset(root);
    const before = v.slice(0, pos);
    const slashMatch = /^\/([\w-]*)$/.exec(v.trim());
    if (slashMatch && (slashCommands?.length ?? 0) > 0) {
      setSlashQuery(slashMatch[1]);
      setSlashOpen(true);
      setSlashActive(0);
      if (open) setOpen(false);
      return;
    }
    if (slashOpen) setSlashOpen(false);
    const m = /(?:^|\s)@([\w/.\-]*)$/.exec(before);
    if (m) {
      setQuery(m[1]);
      setOpen(true);
      setActive(0);
      loadFilesIfNeeded();
    } else if (open) {
      setOpen(false);
    }
  }, [open, slashOpen, slashCommands, loadFilesIfNeeded]);

  function getCaretTextOffset(root: HTMLElement): number {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return serializeEditable(root).length;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer)) return serializeEditable(root).length;
    let offset = 0;
    let found = false;
    const walk = (node: Node): boolean => {
      for (const child of node.childNodes) {
        if (found) return true;
        if (child === range.startContainer) {
          if (child.nodeType === Node.TEXT_NODE) {
            offset += range.startOffset;
          }
          found = true;
          return true;
        }
        if (child.contains(range.startContainer)) {
          if (walk(child)) return true;
        } else if (child instanceof HTMLElement && child.dataset.selectEl) {
          const n = child.dataset.selectEl.replace(/^select el /i, "");
          offset += formatSelectElToken(Number(n)).length;
        } else if (child.nodeType === Node.TEXT_NODE) {
          offset += (child.textContent?.length ?? 0);
        }
      }
      return false;
    };
    walk(root);
    return offset;
  }

  useEffect(() => {
    const root = editRef.current;
    if (!root) return;
    const current = serializeEditable(root);
    if (current === value) return;
    syncingRef.current = true;
    renderValueToEditable(root, value, selectElRefs);
    placeCaretAtEnd(root);
    syncingRef.current = false;
  }, [value, valueVersion, selectElRefs]);

  useEffect(() => {
    const root = editRef.current;
    if (!root) return;
    for (const chip of root.querySelectorAll<HTMLElement>("[data-select-el]")) {
      const key = chip.dataset.selectEl;
      if (!key) continue;
      const ref = selectElRefs.get(key);
      if (ref) syncSelectElChipDom(chip, ref);
    }
  }, [selectElRefsVersion, selectElRefs]);

  useEffect(() => {
    const root = editRef.current;
    if (!root) return;

    const onOver = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.closest(".composer-select-el-chip-remove")) {
        cancelChipTipHide();
        setChipTip(null);
        return;
      }
      const chip = target.closest(".composer-select-el-chip[data-select-el]");
      if (!chip || !(chip instanceof HTMLElement) || !root.contains(chip)) {
        return;
      }
      const key = chip.dataset.selectEl;
      if (!key) return;
      const ref = selectElRefs.get(key);
      if (!ref) return;
      cancelChipTipHide();
      setChipTip({
        rows: selectElTooltipRows({
          tagLabel: ref.tagLabel,
          path: ref.path,
          url: ref.url,
          screenshotDataUrl: ref.screenshotDataUrl,
          attributes: ref.attributes,
          textContent: ref.textContent,
          rect: ref.rect,
          computedStyles: ref.computedStyles,
        }),
        screenshotDataUrl: ref.screenshotDataUrl,
        anchor: chip.getBoundingClientRect(),
        anchorEl: chip,
      });
    };

    const onOut = (e: MouseEvent) => {
      const rel = e.relatedTarget as HTMLElement | null;
      if (rel?.closest(".select-el-chip-tooltip")) {
        cancelChipTipHide();
        return;
      }
      const fromChip = (e.target as HTMLElement).closest(".composer-select-el-chip[data-select-el]");
      const toChip = rel?.closest(".composer-select-el-chip[data-select-el]");
      if (fromChip && toChip && fromChip === toChip) return;
      if (rel && fromChip?.contains(rel)) return;
      if (!fromChip) return;
      scheduleChipTipHide();
    };

    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseout", onOut);
    return () => {
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mouseout", onOut);
    };
  }, [selectElRefs, selectElRefsVersion, cancelChipTipHide, scheduleChipTipHide]);

  useEffect(() => () => cancelChipTipHide(), [cancelChipTipHide]);

  useEffect(() => {
    const root = editRef.current;
    if (!root) return;
    const onRemoveClick = (e: Event) => {
      const btn = (e.target as HTMLElement).closest(".composer-select-el-chip-remove");
      if (!btn || !root.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      const chip = btn.closest("[data-select-el]") as HTMLElement | null;
      if (!chip) return;
      const key = chip.dataset.selectEl;
      chip.remove();
      if (key) onRemoveSelectElRef.current?.(key);
      setChipTip(null);
      const v = serializeEditable(root);
      onChangeRef.current(v);
      onCommitRef.current?.(v);
    };
    root.addEventListener("click", onRemoveClick, true);
    return () => root.removeEventListener("click", onRemoveClick, true);
  }, []);

  function pickSlash(cmd: SlashCommand) {
    setSlashOpen(false);
    const handled = onSlashCommand?.(cmd.name);
    const root = editRef.current;
    if (!root) return;
    if (handled === true) {
      root.innerHTML = "";
      onChangeRef.current("");
    } else if (handled === false) {
      renderValueToEditable(root, `/${cmd.name} `, selectElRefs);
      onChangeRef.current(`/${cmd.name} `);
    }
    requestAnimationFrame(() => root.focus());
  }

  function pick(item: FlatItem) {
    const root = editRef.current;
    if (!root) return;
    const v = serializeEditable(root);
    const pos = getCaretTextOffset(root);
    const before = v.slice(0, pos);
    const after = v.slice(pos);
    const replaced = before.replace(/(?:^|\s)@([\w/.\-]*)$/, (m) => {
      const lead = m.startsWith("@") ? "" : m[0];
      return `${lead}@${item.path} `;
    });
    const next = replaced + after;
    syncingRef.current = true;
    renderValueToEditable(root, next, selectElRefs);
    placeCaretAtEnd(root);
    syncingRef.current = false;
    onChangeRef.current(next);
    setOpen(false);
    requestAnimationFrame(() => root.focus());
  }

  function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Backspace") {
      const root = editRef.current;
      if (root && removeAdjacentChip(root, "before")) {
        e.preventDefault();
        emitChange();
        return;
      }
    }
    if (slashOpen && slashMatches.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashActive((a) => (a + 1) % slashMatches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashActive((a) => (a - 1 + slashMatches.length) % slashMatches.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(slashMatches[slashActive]); return; }
      if (e.key === "Escape") { setSlashOpen(false); return; }
    }
    if (open && matches.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % matches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + matches.length) % matches.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[active]); return; }
      if (e.key === "Escape") { setOpen(false); return; }
    }
    const composing = (e.nativeEvent as { isComposing?: boolean })?.isComposing;
    if (e.key === "Enter" && !e.shiftKey && !composing) {
      e.preventDefault();
      if (!disabled) onSubmitRef.current();
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
    emitChange();
  }

  return (
    <>
      {slashOpen && slashMatches.length > 0 && (
        <div className="mention-dropdown slash-dropdown">
          {slashMatches.map((c, i) => (
            <div
              key={c.name}
              className={`mention-item slash-item ${i === slashActive ? "active" : ""}`}
              onMouseDown={(ev) => { ev.preventDefault(); pickSlash(c); }}
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
                onMouseDown={(ev) => { ev.preventDefault(); pick(m); }}
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
      <div
        ref={editRef}
        className="composer-editable"
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder ?? "Describe a coding task… use @ to reference files"}
        onInput={() => emitChange()}
        onKeyDown={onKey}
        onPaste={onPaste}
      />
      {chipTip && (
        <SelectElChipTooltipPanel
          rows={chipTip.rows}
          anchor={chipTip.anchor}
          screenshotDataUrl={chipTip.screenshotDataUrl}
          anchorEl={chipTip.anchorEl}
          onHoverEnter={cancelChipTipHide}
          onHoverLeave={scheduleChipTipHide}
        />
      )}
    </>
  );
}
