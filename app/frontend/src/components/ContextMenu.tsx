import { useEffect, useRef, type ReactNode } from "react";

export interface MenuItem {
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  separator?: never;
}
export interface MenuSeparator {
  separator: true;
  label?: never;
  onClick?: never;
}

interface Props {
  x: number;
  y: number;
  items: (MenuItem | MenuSeparator)[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // adjust to stay inside viewport
  const w = 220, h = items.length * 30 + 8;
  const left = Math.min(x, window.innerWidth - w - 8);
  const top = Math.min(y, window.innerHeight - h - 8);

  return (
    <div className="ctx-menu" ref={ref} style={{ left, top }}>
      {items.map((it, i) => {
        if ("separator" in it && it.separator) return <div key={i} className="sep" />;
        const m = it as MenuItem;
        return (
          <div
            key={i}
            className={`item ${m.disabled ? "disabled" : ""}`}
            style={m.danger && !m.disabled ? { color: "var(--bad)" } : undefined}
            onClick={() => { if (m.disabled) return; m.onClick(); onClose(); }}
          >
            <span>{m.label}</span>
            {m.shortcut && <span className="shortcut">{m.shortcut}</span>}
          </div>
        );
      })}
    </div>
  );
}
