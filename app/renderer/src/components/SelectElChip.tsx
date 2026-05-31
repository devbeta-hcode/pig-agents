import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  selectElTooltipRows,
  type BrowserElementRef,
  type SelectElTooltipSource,
} from "../lib/browserElementRefs.js";

export function SelectElChipIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2.5" y="2.5" width="7.5" height="7.5" rx="1" />
      <path d="M9.5 9.5 13 13" />
      <path d="m11.2 11.2 2.3-2.3-1.2-1.2-2.3 2.3z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SelectElChipLabel({ label }: { label: string }) {
  return <span className="composer-select-el-chip-label">{label}</span>;
}

function SelectElChipMedia({
  screenshotDataUrl,
}: {
  screenshotDataUrl?: string;
}) {
  if (screenshotDataUrl) {
    return (
      <img
        className="composer-select-el-chip-thumb"
        src={screenshotDataUrl}
        alt=""
        draggable={false}
      />
    );
  }
  return (
    <span className="composer-select-el-chip-icon" aria-hidden>
      <SelectElChipIcon size={12} />
    </span>
  );
}

function SelectElChipRemoveButton({ onRemove }: { onRemove: (e: ReactMouseEvent) => void }) {
  return (
    <button
      type="button"
      className="composer-select-el-chip-remove"
      aria-label="Remove element"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRemove}
    >
      ×
    </button>
  );
}

export type SelectElChipTipState = {
  rows: { label: string; value: string }[];
  anchor: DOMRect;
  screenshotDataUrl?: string;
  /** Live chip node — remeasure on scroll/resize. */
  anchorEl?: HTMLElement | null;
};

type TooltipFixedPos = {
  left: number;
  maxWidth: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

function chatColumnRect(anchorEl: HTMLElement | null | undefined): DOMRect {
  const chat = anchorEl?.closest(".chat");
  if (chat instanceof HTMLElement) return chat.getBoundingClientRect();
  return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
}

/** Delay before hide so the pointer can cross the chip→tooltip gap. */
export const SELECT_EL_TOOLTIP_HIDE_MS = 200;

/** Fixed viewport coords — escapes `.chat { overflow: hidden }` clipping. */
function computeTooltipFixed(
  anchor: DOMRect,
  chatR: DOMRect,
  tw: number,
): TooltipFixedPos {
  const gap = 4;
  const margin = 10;
  const maxWidth = Math.max(180, Math.min(360, chatR.width - margin * 2));
  const boxW = Math.min(tw, maxWidth);
  let left = anchor.right - boxW;
  left = Math.max(chatR.left + margin, Math.min(left, chatR.right - boxW - margin));

  const spaceAbove = anchor.top - margin;
  const spaceBelow = window.innerHeight - anchor.bottom - margin;

  if (spaceAbove >= spaceBelow || anchor.top > window.innerHeight * 0.45) {
    return {
      left,
      bottom: window.innerHeight - anchor.top + gap,
      maxWidth,
      maxHeight: Math.max(80, Math.min(320, spaceAbove - gap)),
    };
  }

  return {
    left,
    top: anchor.bottom + gap,
    maxWidth,
    maxHeight: Math.max(80, Math.min(320, spaceBelow - gap)),
  };
}

export function SelectElChipTooltipPanel({
  rows,
  anchor,
  screenshotDataUrl,
  anchorEl,
  onHoverEnter,
  onHoverLeave,
}: SelectElChipTipState & {
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<TooltipFixedPos | null>(null);

  const remeasure = useCallback(() => {
    const el = panelRef.current;
    if (!el) return;
    const chip =
      anchorEl && document.body.contains(anchorEl) ? anchorEl.getBoundingClientRect() : anchor;
    const { width } = el.getBoundingClientRect();
    setPos(computeTooltipFixed(chip, chatColumnRect(anchorEl), width));
  }, [anchor, anchorEl]);

  useLayoutEffect(() => {
    remeasure();
  }, [remeasure, rows, screenshotDataUrl]);

  useLayoutEffect(() => {
    const onLayout = () => remeasure();
    window.addEventListener("resize", onLayout);
    window.addEventListener("scroll", onLayout, true);
    return () => {
      window.removeEventListener("resize", onLayout);
      window.removeEventListener("scroll", onLayout, true);
    };
  }, [remeasure]);

  if (rows.length === 0 && !screenshotDataUrl) return null;

  const style = pos
    ? {
        position: "fixed" as const,
        left: pos.left,
        ...(pos.bottom != null ? { bottom: pos.bottom, top: "auto" as const } : { top: pos.top, bottom: "auto" as const }),
        maxWidth: pos.maxWidth,
        maxHeight: pos.maxHeight,
        overflowY: "auto" as const,
      }
    : {
        position: "fixed" as const,
        left: -9999,
        top: -9999,
        maxWidth: 360,
        visibility: "hidden" as const,
      };

  return createPortal(
    <div
      ref={panelRef}
      className={`select-el-chip-tooltip${pos ? " select-el-chip-tooltip--placed" : ""}`}
      style={style}
      role="tooltip"
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
    >
      {screenshotDataUrl ? (
        <div className="select-el-chip-tooltip-preview">
          <img
            src={screenshotDataUrl}
            alt=""
            draggable={false}
            onLoad={remeasure}
          />
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div className="select-el-chip-tooltip-rows">
          {rows.map((row) => (
            <div key={row.label} className="select-el-chip-tooltip-row">
              <span className="select-el-chip-tooltip-key">{row.label}</span>
              <span className="select-el-chip-tooltip-val">{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

function useSelectElChipTooltip(
  tooltip?: SelectElTooltipSource,
  screenshotDataUrl?: string,
) {
  const [tip, setTip] = useState<SelectElChipTipState | null>(null);
  const chipRef = useRef<HTMLSpanElement | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimerRef.current = setTimeout(() => setTip(null), SELECT_EL_TOOLTIP_HIDE_MS);
  }, [cancelHide]);

  const showTip = useCallback(() => {
    if (!tooltip || !chipRef.current) return;
    cancelHide();
    const chip = chipRef.current;
    const shot = screenshotDataUrl ?? tooltip.screenshotDataUrl;
    setTip({
      rows: selectElTooltipRows(tooltip),
      screenshotDataUrl: shot,
      anchor: chip.getBoundingClientRect(),
      anchorEl: chip,
    });
  }, [tooltip, screenshotDataUrl, cancelHide]);

  useEffect(() => () => cancelHide(), [cancelHide]);

  return { chipRef, tip, showTip, scheduleHide, cancelHide };
}

/** Read-only chip for sent message bubbles (tooltip, no close). */
export function SelectElChipView({
  label,
  screenshotDataUrl,
  tooltip,
}: {
  label: string;
  screenshotDataUrl?: string;
  tooltip?: SelectElTooltipSource;
}) {
  const { chipRef, tip, showTip, scheduleHide, cancelHide } = useSelectElChipTooltip(tooltip, screenshotDataUrl);
  const hasThumb = Boolean(screenshotDataUrl);

  return (
    <>
      <span
        ref={chipRef}
        className={`composer-select-el-chip composer-select-el-chip--readonly${hasThumb ? " composer-select-el-chip--has-thumb" : ""}`}
        contentEditable={false}
        onMouseEnter={showTip}
        onMouseLeave={scheduleHide}
      >
        <span className="composer-select-el-chip-media" aria-hidden>
          <SelectElChipMedia screenshotDataUrl={screenshotDataUrl} />
        </span>
        <SelectElChipLabel label={label} />
      </span>
      {tip && (
        <SelectElChipTooltipPanel
          rows={tip.rows}
          anchor={tip.anchor}
          screenshotDataUrl={tip.screenshotDataUrl}
          anchorEl={tip.anchorEl}
          onHoverEnter={cancelHide}
          onHoverLeave={scheduleHide}
        />
      )}
    </>
  );
}

const TOKEN_SPLIT_RE = /(\{\{select el \d+\}\})/gi;
const TOKEN_TEST_RE = /^\{\{select el \d+\}\}$/i;

export function MessageBodyWithSelectEls({
  text,
  selectElMeta,
}: {
  text: string;
  selectElMeta?: {
    key: string;
    tagLabel: string;
    screenshotDataUrl?: string;
    path?: string;
    url?: string;
    attributes?: Record<string, string>;
    textContent?: string;
    rect?: { top: number; left: number; width: number; height: number };
    computedStyles?: Record<string, string>;
  }[];
}) {
  const metaByKey = new Map(selectElMeta?.map((m) => [m.key, m]));
  const parts = text.split(TOKEN_SPLIT_RE);
  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null;
        if (TOKEN_TEST_RE.test(part)) {
          const n = part.match(/\d+/)?.[0] ?? "1";
          const key = `select el ${n}`;
          const meta = metaByKey.get(key);
          const label = meta?.tagLabel ?? `<el>`;
          const tooltip: SelectElTooltipSource | undefined = meta
            ? {
                tagLabel: meta.tagLabel,
                path: meta.path,
                url: meta.url,
                screenshotDataUrl: meta.screenshotDataUrl,
                attributes: meta.attributes,
                textContent: meta.textContent,
                rect: meta.rect,
                computedStyles: meta.computedStyles,
              }
            : undefined;
          return (
            <SelectElChipView
              key={`${key}-${i}`}
              label={label}
              screenshotDataUrl={meta?.screenshotDataUrl}
              tooltip={tooltip}
            />
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

const CHIP_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="7.5" height="7.5" rx="1"/><path d="M9.5 9.5 13 13"/><path d="m11.2 11.2 2.3-2.3-1.2-1.2-2.3 2.3z" fill="currentColor" stroke="none"/></svg>`;

function appendChipMedia(parent: HTMLElement, screenshotDataUrl?: string): void {
  const media = document.createElement("span");
  media.className = "composer-select-el-chip-media";
  media.setAttribute("aria-hidden", "true");
  if (screenshotDataUrl) {
    const img = document.createElement("img");
    img.className = "composer-select-el-chip-thumb";
    img.src = screenshotDataUrl;
    img.alt = "";
    img.draggable = false;
    media.appendChild(img);
  } else {
    const icon = document.createElement("span");
    icon.className = "composer-select-el-chip-icon";
    icon.innerHTML = CHIP_ICON_SVG;
    media.append(icon);
  }
  parent.appendChild(media);
}

/** Update label + thumbnail on an existing contenteditable chip. */
export function syncSelectElChipDom(chip: HTMLElement, ref: BrowserElementRef): void {
  const labelEl = chip.querySelector(".composer-select-el-chip-label");
  if (labelEl) labelEl.textContent = ref.tagLabel;
  chip.classList.toggle("composer-select-el-chip--has-thumb", Boolean(ref.screenshotDataUrl));
  let media = chip.querySelector(".composer-select-el-chip-media");
  if (!media) {
    media = document.createElement("span");
    media.className = "composer-select-el-chip-media";
    media.setAttribute("aria-hidden", "true");
    chip.insertBefore(media, chip.firstChild);
  }
  media.innerHTML = "";
  if (ref.screenshotDataUrl) {
    const img = document.createElement("img");
    img.className = "composer-select-el-chip-thumb";
    img.src = ref.screenshotDataUrl;
    img.alt = "";
    img.draggable = false;
    media.appendChild(img);
  } else {
    const icon = document.createElement("span");
    icon.className = "composer-select-el-chip-icon";
    icon.innerHTML = CHIP_ICON_SVG;
    media.appendChild(icon);
  }
}

export function createSelectElChipElement(
  key: string,
  tagLabel: string,
  options?: { removable?: boolean; screenshotDataUrl?: string },
): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = "composer-select-el-chip";
  if (options?.screenshotDataUrl) {
    chip.classList.add("composer-select-el-chip--has-thumb");
  }
  chip.contentEditable = "false";
  chip.dataset.selectEl = key;

  appendChipMedia(chip, options?.screenshotDataUrl);

  const label = document.createElement("span");
  label.className = "composer-select-el-chip-label";
  label.textContent = tagLabel;
  chip.appendChild(label);

  if (options?.removable !== false) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "composer-select-el-chip-remove";
    btn.setAttribute("aria-label", "Remove element");
    btn.setAttribute("tabindex", "-1");
    btn.contentEditable = "false";
    btn.textContent = "×";
    chip.append(btn);
  }

  return chip;
}
