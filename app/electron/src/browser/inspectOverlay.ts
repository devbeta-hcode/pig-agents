/** In-page inspect overlay (BrowserView has no preload — results via console.log). */

export const INSPECT_OVERLAY_SCRIPT = `
(function() {
  if (window.__pigInspectCleanup) {
    window.__pigInspectCleanup();
  }
  window.__pigInspectActive = true;
  const HIGHLIGHT_ID = "pig-inspect-highlight-box";
  const LABEL_ID = "pig-inspect-highlight-label";
  const STYLE_ID = "pig-inspect-style";

  function isPigNode(el) {
    if (!el || !(el instanceof Element)) return true;
    if (el.id === HIGHLIGHT_ID || el.id === LABEL_ID || el.id === STYLE_ID) return true;
    if (el.closest && el.closest("[data-pig-inspect]")) return true;
    return false;
  }

  function elementUnderPointer(x, y) {
    const stack = document.elementsFromPoint(x, y);
    for (const node of stack) {
      if (isPigNode(node)) continue;
      if (node instanceof Element) return node;
    }
    return null;
  }

  function removeHighlight() {
    document.getElementById(HIGHLIGHT_ID)?.remove();
    document.getElementById(LABEL_ID)?.remove();
  }

  function ensureHighlight() {
    let box = document.getElementById(HIGHLIGHT_ID);
    let label = document.getElementById(LABEL_ID);
    if (!box) {
      box = document.createElement("div");
      box.id = HIGHLIGHT_ID;
      box.setAttribute("data-pig-inspect", "1");
      box.style.cssText =
        "position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;" +
        "border:2px solid #1a73e8;background:rgba(26,115,232,0.18);border-radius:1px;";
      document.documentElement.appendChild(box);
    }
    if (!label) {
      label = document.createElement("div");
      label.id = LABEL_ID;
      label.setAttribute("data-pig-inspect", "1");
      label.style.cssText =
        "position:fixed;pointer-events:none;z-index:2147483647;" +
        "font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;color:#fff;" +
        "background:#1a73e8;padding:2px 6px;border-radius:2px 2px 0 0;" +
        "white-space:nowrap;max-width:min(420px,90vw);overflow:hidden;text-overflow:ellipsis;" +
        "box-shadow:0 1px 4px rgba(0,0,0,0.35);";
      document.documentElement.appendChild(label);
    }
    return { box, label };
  }

  function updateHighlight(el) {
    if (!el) {
      removeHighlight();
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) {
      removeHighlight();
      return;
    }
    const { box, label } = ensureHighlight();
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    const tag = el.tagName.toLowerCase();
    const id = el.id ? "#" + el.id : "";
    const cls =
      el.classList && el.classList.length
        ? "." + Array.from(el.classList).slice(0, 3).join(".")
        : "";
    label.textContent = tag + id + cls + "  " + Math.round(r.width) + " × " + Math.round(r.height);
    const labelH = 20;
    const top = r.top > labelH + 4 ? r.top - labelH : r.bottom + 2;
    label.style.left = Math.max(0, r.left) + "px";
    label.style.top = top + "px";
  }

  function buildPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) seg += "#" + cur.id;
      else if (cur.className && typeof cur.className === "string") {
        const c = cur.className.trim().split(/\\s+/).slice(0, 2).map((x) => "." + x).join("");
        if (c) seg += c;
      }
      parts.unshift(seg);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function pick(el) {
    if (!el || !(el instanceof Element)) return;
    const rect = el.getBoundingClientRect();
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    const cs = getComputedStyle(el);
    const payload = {
      outerHTML: (el.outerHTML || "").slice(0, 2000),
      path: buildPath(el),
      attributes: attrs,
      textContent: (el.textContent || "").slice(0, 500),
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      computedStyles: { color: cs.color, background: cs.backgroundColor, fontSize: cs.fontSize },
    };
    console.log("__PIG_INSPECT_PICK__" + JSON.stringify(payload));
  }

  function cleanup() {
    window.__pigInspectActive = false;
    document.documentElement.classList.remove("pig-inspect-mode");
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    document.getElementById(STYLE_ID)?.remove();
    removeHighlight();
    window.__pigInspectCleanup = null;
  }
  window.__pigInspectCleanup = cleanup;

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      console.log("__PIG_INSPECT_CANCEL__");
      cleanup();
    }
  }

  function onMove(e) {
    updateHighlight(elementUnderPointer(e.clientX, e.clientY));
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = elementUnderPointer(e.clientX, e.clientY);
    if (el) {
      pick(el);
      removeHighlight();
    }
  }

  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute("data-pig-inspect", "1");
    style.textContent =
      "html.pig-inspect-mode, html.pig-inspect-mode * { cursor: crosshair !important; }";
    document.documentElement.appendChild(style);
  }
  document.documentElement.classList.add("pig-inspect-mode");
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
})();
`;

export const INSPECT_OVERLAY_STOP_SCRIPT = `
(() => {
  if (typeof window.__pigInspectCleanup === "function") {
    window.__pigInspectCleanup();
  } else {
    window.__pigInspectActive = false;
    document.documentElement.classList.remove("pig-inspect-mode");
    document.getElementById("pig-inspect-highlight-box")?.remove();
    document.getElementById("pig-inspect-highlight-label")?.remove();
    document.getElementById("pig-inspect-style")?.remove();
  }
})();
`;

export const INSPECT_PICK_PREFIX = "__PIG_INSPECT_PICK__";
export const INSPECT_CANCEL_MSG = "__PIG_INSPECT_CANCEL__";
