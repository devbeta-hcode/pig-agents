/**
 * In-page selector resolution + DOM helpers for embedded browser automation.
 * Injected via executeJavaScript — no Playwright dependency.
 */

export interface ResolvedElement {
  x: number;
  y: number;
  tag: string;
  method: string;
}

export interface ResolveFailure {
  error: string;
  hints: string;
}

/** Shared helpers installed once per eval — must be valid inside an async IIFE. */
export const BROWSER_DOM_HELPERS = `
function pigNorm(s) {
  return String(s || "").replace(/\\s+/g, " ").trim();
}

function pigIsVisible(el) {
  if (!el || !(el instanceof Element)) return false;
  const st = getComputedStyle(el);
  if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
  if (st.pointerEvents === "none") return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  if (r.bottom < 0 || r.right < 0 || r.top > innerHeight + 2 || r.left > innerWidth + 2) return false;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const topEl = document.elementFromPoint(cx, cy);
  if (!topEl) return true;
  return el === topEl || el.contains(topEl) || topEl.contains(el);
}

function pigCenter(el) {
  try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch {}
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, tag: el.tagName.toLowerCase() };
}

function pigWalkAllRoots(fn) {
  const seen = new Set();
  function walk(root) {
    if (!root || seen.has(root)) return null;
    seen.add(root);
    const hit = fn(root);
    if (hit) return hit;
    const nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const node of nodes) {
      if (node.shadowRoot) {
        const inner = walk(node.shadowRoot);
        if (inner) return inner;
      }
    }
    return null;
  }
  return walk(document);
}

function pigQueryCss(sel) {
  try {
    const direct = document.querySelector(sel);
    if (direct && pigIsVisible(direct)) return direct;
  } catch {}
  return pigWalkAllRoots((root) => {
    try {
      const el = root.querySelector(sel);
      if (el && pigIsVisible(el)) return el;
    } catch {}
    return null;
  });
}

function pigByText(text, exact) {
  const want = pigNorm(text).toLowerCase();
  if (!want) return null;
  const hits = [];
  pigWalkAllRoots((root) => {
    const nodes = root.querySelectorAll(
      "button,a,[role=button],[role=link],input[type=submit],input[type=button],label,summary,[role=tab],[role=menuitem]"
    );
    for (const el of nodes) {
      if (!pigIsVisible(el)) continue;
      const t = pigNorm(el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").toLowerCase();
      if (!t) continue;
      if (exact ? t === want : t.includes(want)) hits.push(el);
    }
    return null;
  });
  hits.sort((a, b) => pigNorm(a.textContent || "").length - pigNorm(b.textContent || "").length);
  return hits[0] || null;
}

function pigByPlaceholder(text) {
  const want = pigNorm(text).toLowerCase();
  return pigWalkAllRoots((root) => {
    for (const el of root.querySelectorAll("input,textarea,[contenteditable=true],[role=textbox],[role=searchbox]")) {
      if (!pigIsVisible(el)) continue;
      const ph = pigNorm(el.getAttribute("placeholder") || "").toLowerCase();
      const aria = pigNorm(el.getAttribute("aria-label") || "").toLowerCase();
      const name = pigNorm(el.getAttribute("name") || "").toLowerCase();
      if (ph.includes(want) || aria.includes(want) || name.includes(want)) return el;
    }
    return null;
  });
}

function pigByAria(label) {
  const want = pigNorm(label).toLowerCase();
  return pigWalkAllRoots((root) => {
    for (const el of root.querySelectorAll("[aria-label],[aria-labelledby]")) {
      if (!pigIsVisible(el)) continue;
      const aria = pigNorm(el.getAttribute("aria-label") || "").toLowerCase();
      if (aria.includes(want)) return el;
    }
    return null;
  });
}

function pigByRole(role, name) {
  const wantRole = pigNorm(role).toLowerCase();
  const wantName = name ? pigNorm(name).toLowerCase() : "";
  return pigWalkAllRoots((root) => {
    for (const el of root.querySelectorAll("[role]")) {
      if (!pigIsVisible(el)) continue;
      const r = pigNorm(el.getAttribute("role") || "").toLowerCase();
      if (r !== wantRole) continue;
      if (!wantName) return el;
      const label = pigNorm(el.getAttribute("aria-label") || el.textContent || "").toLowerCase();
      if (label.includes(wantName)) return el;
    }
    return null;
  });
}

function pigResolveSelector(selector) {
  const sel = String(selector || "").trim();
  if (!sel) return null;
  let el = null;
  let method = "css";

  if (sel.startsWith("text=")) {
    const rest = sel.slice(5).trim();
    if (rest.startsWith("/") && rest.length > 2) {
      const last = rest.lastIndexOf("/");
      if (last > 0) {
        const pattern = rest.slice(1, last);
        const flags = rest.slice(last + 1) || "i";
        let re;
        try { re = new RegExp(pattern, flags); } catch { re = null; }
        if (re) {
          el = pigWalkAllRoots((root) => {
            for (const node of root.querySelectorAll("button,a,[role=button],label,span,div,p")) {
              if (!pigIsVisible(node)) continue;
              const t = pigNorm(node.textContent || node.getAttribute("aria-label") || "");
              if (re.test(t)) return node;
            }
            return null;
          });
          method = "text-regex";
        }
      }
    } else {
      el = pigByText(rest, false) || pigByText(rest, true);
      method = "text";
    }
  } else if (sel.startsWith("placeholder=")) {
    el = pigByPlaceholder(sel.slice(12).trim());
    method = "placeholder";
  } else if (sel.startsWith("aria=")) {
    el = pigByAria(sel.slice(5).trim());
    method = "aria";
  } else if (sel.startsWith("role=")) {
    const body = sel.slice(5).trim();
    const m = body.match(/^([^\\[]+)(?:\\[name=(["']?)([^"\\]]+)\\2\\])?$/i);
    if (m) el = pigByRole(m[1].trim(), m[3] || "");
    method = "role";
  } else if (sel.startsWith("name=")) {
    el = pigQueryCss('[name="' + sel.slice(5).trim().replace(/"/g, '\\\\"') + '"]');
    method = "name";
  } else {
    el = pigQueryCss(sel);
    method = "css";
  }

  if (!el) return null;
  return { ...pigCenter(el), method, el };
}

function pigDomClick(el) {
  if (!el) return false;
  try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch {}
  try { el.focus({ preventScroll: true }); } catch {}
  const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
  el.dispatchEvent(new MouseEvent("pointerover", opts));
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new MouseEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new MouseEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  if (typeof el.click === "function") el.click();
  return true;
}

function pigSetFieldValue(el, value) {
  if (!el) return false;
  try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch {}
  try { el.focus({ preventScroll: true }); } catch {}
  const v = String(value ?? "");
  if (el.isContentEditable) {
    el.textContent = v;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: v, inputType: "insertText" }));
    return true;
  }
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") {
    const proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  if (el.getAttribute("role") === "textbox" || el.getAttribute("role") === "searchbox") {
    el.textContent = v;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: v, inputType: "insertText" }));
    return true;
  }
  return false;
}

function pigReadFieldValue(el) {
  if (!el) return "";
  if (el.isContentEditable) return pigNorm(el.textContent || "");
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return String(el.value ?? "");
  return pigNorm(el.textContent || "");
}

function pigListInteractiveHints(max = 12) {
  const items = [];
  pigWalkAllRoots((root) => {
    for (const el of root.querySelectorAll(
      "input,textarea,button,a,[role=button],[role=link],[role=textbox],[role=searchbox],select,summary"
    )) {
      if (!pigIsVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const id = el.id ? "#" + el.id : "";
      const name = el.getAttribute("name");
      const aria = el.getAttribute("aria-label");
      const ph = el.getAttribute("placeholder");
      const text = pigNorm(el.textContent || "").slice(0, 40);
      let hint = tag + id;
      if (name) hint += '[name="' + name + '"]';
      if (aria) hint += ' aria="' + aria + '"';
      if (ph) hint += ' placeholder="' + ph + '"';
      if (text) hint += ' text="' + text + '"';
      items.push(hint);
      if (items.length >= max) return el;
    }
    return null;
  });
  return items.slice(0, max).join("\\n");
}
`;

export function buildResolveScript(selector: string): string {
  const sel = JSON.stringify(selector);
  return `(async () => {
    ${BROWSER_DOM_HELPERS}
    const resolved = pigResolveSelector(${sel});
    if (!resolved?.el) {
      return { ok: false, error: "selector not found: " + ${sel}, hints: pigListInteractiveHints() };
    }
    const { el, x, y, tag, method } = resolved;
    return { ok: true, x, y, tag, method };
  })()`;
}

export function buildWaitResolveScript(selector: string, timeoutMs: number): string {
  const sel = JSON.stringify(selector);
  return `(async () => {
    ${BROWSER_DOM_HELPERS}
    const deadline = Date.now() + ${Math.max(500, timeoutMs)};
    while (Date.now() < deadline) {
      const resolved = pigResolveSelector(${sel});
      if (resolved?.el) {
        const { el, x, y, tag, method } = resolved;
        return { ok: true, x, y, tag, method, elRef: true };
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    return { ok: false, error: "selector not found: " + ${sel}, hints: pigListInteractiveHints() };
  })()`;
}

export function buildClickScript(selector: string): string {
  const sel = JSON.stringify(selector);
  return `(async () => {
    ${BROWSER_DOM_HELPERS}
    const resolved = pigResolveSelector(${sel});
    if (!resolved?.el) {
      return { ok: false, error: "selector not found: " + ${sel}, hints: pigListInteractiveHints() };
    }
    pigDomClick(resolved.el);
    return { ok: true, x: resolved.x, y: resolved.y, method: resolved.method, via: "dom" };
  })()`;
}

export function buildFillScript(selector: string, value: string): string {
  const sel = JSON.stringify(selector);
  const val = JSON.stringify(value);
  return `(async () => {
    ${BROWSER_DOM_HELPERS}
    const resolved = pigResolveSelector(${sel});
    if (!resolved?.el) {
      return { ok: false, error: "selector not found: " + ${sel}, hints: pigListInteractiveHints() };
    }
    const el = resolved.el;
    if (!pigSetFieldValue(el, ${val})) {
      return { ok: false, error: "element is not fillable: " + resolved.tag, hints: pigListInteractiveHints() };
    }
    const readBack = pigReadFieldValue(el);
    const want = String(${val});
    const matched = readBack === want || readBack.includes(want) || want.includes(readBack);
    return { ok: matched, x: resolved.x, y: resolved.y, method: resolved.method, via: "dom", readBack };
  })()`;
}

export function buildWaitForScript(selector: string, state: string, timeoutMs: number): string {
  const sel = JSON.stringify(selector);
  const st = JSON.stringify(state);
  return `(async () => {
    ${BROWSER_DOM_HELPERS}
    const deadline = Date.now() + ${Math.max(500, timeoutMs)};
    const wantHidden = ${st} === "hidden";
    const wantAttached = ${st} === "attached";
    while (Date.now() < deadline) {
      const resolved = pigResolveSelector(${sel});
      if (wantHidden && !resolved) return { ok: true };
      if (wantAttached && resolved) return { ok: true };
      if (!wantHidden && !wantAttached && resolved) return { ok: true };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { ok: false, error: "waitForSelector timeout (" + ${sel} + ", " + ${st} + ")", hints: pigListInteractiveHints() };
  })()`;
}

export function buildQuerySelectorScript(selector?: string, maxChars = 12_000): string {
  const sel = selector ? JSON.stringify(selector) : "null";
  return `(async () => {
    ${BROWSER_DOM_HELPERS}
    if (${sel}) {
      const el = pigQueryCss(${sel});
      if (!el) return "";
      return (el.innerText || el.textContent || "").slice(0, ${maxChars});
    }
    return (document.body?.innerText || document.body?.textContent || "").slice(0, ${maxChars});
  })()`;
}

export function buildQueryHtmlScript(selector?: string, maxChars = 20_000): string {
  const sel = selector ? JSON.stringify(selector) : "null";
  return `(async () => {
    ${BROWSER_DOM_HELPERS}
    if (${sel}) {
      const el = pigQueryCss(${sel});
      if (!el) return "";
      return (el.outerHTML || "").slice(0, ${maxChars});
    }
    return (document.documentElement?.outerHTML || "").slice(0, ${maxChars});
  })()`;
}

export type InPageActionResult =
  | { ok: true; x?: number; y?: number; method?: string; via?: string; readBack?: string }
  | { ok: false; error: string; hints?: string };

export function formatSelectorError(result: InPageActionResult): string {
  if (result.ok) return "";
  let msg = result.error;
  if (result.hints) msg += "\\n\\nVisible controls on page:\\n" + result.hints;
  return msg;
}

/** Chrome desktop UA — reduces bot friction vs default Electron UA. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
