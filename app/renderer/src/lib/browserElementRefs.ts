/** Inline browser element picks in chat (`{{select el 1}}`), Cursor-style. */

export type BrowserElementRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export type BrowserElementPickDetail = {
  path: string;
  outerHTML: string;
  url: string;
  screenshotDataUrl?: string;
  attributes?: Record<string, string>;
  textContent?: string;
  rect?: BrowserElementRect;
  computedStyles?: Record<string, string>;
};

/** Fields used for hover tooltip on select-el chips. */
export type SelectElTooltipSource = {
  tagLabel?: string;
  path?: string;
  url?: string;
  screenshotDataUrl?: string;
  attributes?: Record<string, string>;
  textContent?: string;
  rect?: BrowserElementRect;
  computedStyles?: Record<string, string>;
};

export type BrowserElementRef = BrowserElementPickDetail & {
  /** Map key, e.g. `select el 1` */
  key: string;
  /** Short label for inline chip, e.g. `<div>`, `<h3>`. */
  tagLabel: string;
};

/** Display label from inspect path (`div#id.foo > h3` → `<h3>`). */
export function tagLabelFromPath(path: string): string {
  const leaf = path.split(" > ").pop()?.trim() || path;
  const m = leaf.match(/^([a-z][\w-]*)/i);
  return m ? `<${m[1].toLowerCase()}>` : "<element>";
}

const TOOLTIP_ATTR_ORDER = [
  "id",
  "class",
  "name",
  "type",
  "href",
  "src",
  "role",
  "aria-label",
  "placeholder",
  "value",
  "title",
  "alt",
  "for",
  "data-testid",
];

/** Rows for the select-el chip hover tooltip (DevTools-style). */
export function selectElTooltipRows(
  src: SelectElTooltipSource,
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const tag = src.tagLabel ?? tagLabelFromPath(src.path ?? "");
  rows.push({ label: "Element", value: tag });

  if (src.path) rows.push({ label: "Selector", value: src.path });

  const attrs = src.attributes ?? {};
  const shown = new Set<string>();
  for (const key of TOOLTIP_ATTR_ORDER) {
    const v = attrs[key];
    if (v == null || v === "") continue;
    shown.add(key);
    rows.push({ label: key, value: v.length > 120 ? `${v.slice(0, 117)}…` : v });
  }
  for (const [key, v] of Object.entries(attrs)) {
    if (shown.has(key) || !v) continue;
    if (key.startsWith("on")) continue;
    rows.push({
      label: key,
      value: v.length > 80 ? `${v.slice(0, 77)}…` : v,
    });
    if (rows.length > 14) break;
  }

  if (src.rect) {
    const { width, height } = src.rect;
    rows.push({
      label: "Size",
      value: `${Math.round(width)} × ${Math.round(height)} px`,
    });
  }

  const cs = src.computedStyles;
  if (cs) {
    const styleBits: string[] = [];
    if (cs.color) styleBits.push(`color: ${cs.color}`);
    if (cs.background || cs.backgroundColor) {
      styleBits.push(`background: ${cs.background ?? cs.backgroundColor}`);
    }
    if (cs.fontSize) styleBits.push(`font-size: ${cs.fontSize}`);
    if (styleBits.length) rows.push({ label: "Style", value: styleBits.join(" · ") });
  }

  const text = (src.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text) {
    rows.push({
      label: "Text",
      value: text.length > 100 ? `${text.slice(0, 97)}…` : text,
    });
  }

  if (src.url) rows.push({ label: "Page", value: src.url });
  return rows;
}

export const BROWSER_ELEMENT_PICK_EVENT = "pig:browser-element-pick";

const TOKEN_RE = /\{\{select el (\d+)\}\}/gi;

export function formatSelectElToken(n: number): string {
  return `{{select el ${n}}}`;
}

export function selectElKeyFromIndex(n: number | string): string {
  return `select el ${n}`;
}

/** Unique keys referenced in composer text, in order of appearance. */
export function extractSelectElKeys(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(TOKEN_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const key = selectElKeyFromIndex(m[1]);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

export function removeSelectElKey(text: string, key: string): string {
  const n = key.replace(/^select el /i, "");
  const re = new RegExp(`(^|\\s)\\{\\{select el ${n}\\}\\}\\s?`, "gi");
  return text.replace(re, (_m, lead) => (lead === "" ? "" : lead)).replace(/\s{2,}/g, " ").trim();
}

/** Expand tokens to HTML context for the agent (not shown in the composer). */
export function expandSelectElsForAgent(
  text: string,
  refs: ReadonlyMap<string, BrowserElementRef>,
): string {
  return text.replace(new RegExp(TOKEN_RE.source, "gi"), (_full, n: string) => {
    const key = selectElKeyFromIndex(n);
    const ref = refs.get(key);
    if (!ref) return _full;
    const html = ref.outerHTML.slice(0, 800);
    return [
      "",
      `[Browser element ${key}: \`${ref.path}\` @ ${ref.url || "(unknown)"}]`,
      "```html",
      html,
      "```",
      "",
    ].join("\n");
  });
}

export function stripSelectElTokens(text: string): string {
  return text.replace(new RegExp(TOKEN_RE.source, "gi"), " ").replace(/\s{2,}/g, " ").trim();
}
