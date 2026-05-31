/**
 * Lightweight web tools for the agent: `web_fetch` (single URL) and
 * `web_search` (DuckDuckGo HTML scrape).
 *
 * Design choices:
 *   - No third-party libs / no API keys. Both use Node 20's `fetch` and a
 *     hand-rolled HTML stripper. Keeps this tool useful with zero setup.
 *   - DuckDuckGo's `html.duckduckgo.com` is the public no-JS endpoint
 *     (still served as of 2026); it can rate-limit aggressively, so each
 *     call uses a realistic User-Agent and a hard timeout.
 *   - Output is capped (default 12 KB body, 8 results) so a single call
 *     can't blow the model's context window or the SSE buffer.
 *   - Only HTTP(S) URLs are followed. `file://`, `gopher://`, IP-literals
 *     pointing at link-local / loopback ranges, and similar SSRF vectors
 *     are rejected before the fetch fires.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_BODY_CAP = 12_000;
const DEFAULT_SEARCH_RESULTS = 8;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36 PigAgents/0.1";

export interface WebFetchResult {
  ok: boolean;
  url: string;
  finalUrl?: string;
  status?: number;
  contentType?: string;
  /** Plain text extracted from the response (HTML stripped if applicable). */
  text?: string;
  /** True if `text` was truncated to the cap. */
  truncated?: boolean;
  bytes?: number;
  error?: string;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  ok: boolean;
  query: string;
  hits: WebSearchHit[];
  error?: string;
}

/** Reject obvious SSRF / non-HTTP targets before the fetch call. */
function validateUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol ${url.protocol}` };
  }
  const host = url.hostname.toLowerCase();
  // Block obvious local/internal targets so a hijacked agent can't read the
  // metadata service or scan the user's LAN. This is a coarse filter, not a
  // full SSRF defense — pair with network egress controls in production.
  const blocked = [
    /^localhost$/, /^0\.0\.0\.0$/, /^127\./, /^10\./, /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./,           // link-local + EC2/GCE metadata
    /\.local$/, /\.internal$/, /\.localhost$/,
  ];
  if (blocked.some((re) => re.test(host))) {
    return { ok: false, reason: `blocked host: ${host}` };
  }
  return { ok: true, url };
}

/**
 * Strip HTML to readable plaintext. Doesn't try to be a full readability
 * implementation — just removes <script>/<style>/<nav>/<header>/<footer>,
 * collapses tags to spaces, and decodes the most common entities.
 */
function htmlToText(html: string): string {
  let s = html;
  // Drop boilerplate blocks entirely (including their content).
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  // Convert block-level closes/breaks to newlines so paragraphs survive.
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|pre|blockquote)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Drop remaining tags.
  s = s.replace(/<[^>]+>/g, " ");
  // Decode the entities that show up everywhere.
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)));
  // Collapse whitespace but preserve paragraph breaks.
  s = s.replace(/[ \t\f\v]+/g, " ");
  s = s.replace(/\n[ \t]+/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

async function fetchWithTimeout(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; timeoutMs?: number; body?: string } = {},
): Promise<{ res: Response; text: string; bytes: number; truncated: boolean }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...opts.headers,
      },
      body: opts.body,
      signal: ctl.signal,
      // Don't follow redirects to disallowed hosts: re-validate after.
      redirect: "follow",
    });
    // Cap bytes early — guard against gigantic pages.
    const reader = res.body?.getReader();
    if (!reader) return { res, text: "", bytes: 0, truncated: false };
    const HARD_CAP_BYTES = 4 * 1024 * 1024;
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= HARD_CAP_BYTES) {
          truncated = true;
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }
      }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const text = buf.toString("utf8");
    return { res, text, bytes: total, truncated };
  } finally {
    clearTimeout(timer);
  }
}

export async function webFetch(
  rawUrl: string,
  opts: { maxChars?: number; timeoutMs?: number } = {},
): Promise<WebFetchResult> {
  const v = validateUrl(rawUrl);
  if (!v.ok) return { ok: false, url: rawUrl, error: v.reason };

  try {
    const { res, text, bytes, truncated: bytesCapped } = await fetchWithTimeout(v.url.toString(), {
      timeoutMs: opts.timeoutMs,
    });
    // Re-validate the final URL after redirects.
    const v2 = validateUrl(res.url);
    if (!v2.ok) {
      return { ok: false, url: rawUrl, finalUrl: res.url, error: `redirect ${v2.reason}` };
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    let body: string;
    if (ct.includes("html") || ct.includes("xml")) body = htmlToText(text);
    else body = text;

    const cap = opts.maxChars ?? DEFAULT_BODY_CAP;
    const truncated = body.length > cap || bytesCapped;
    if (body.length > cap) body = body.slice(0, cap);

    return {
      ok: res.ok,
      url: rawUrl,
      finalUrl: res.url,
      status: res.status,
      contentType: ct || undefined,
      text: body,
      truncated,
      bytes,
    };
  } catch (err) {
    return { ok: false, url: rawUrl, error: (err as Error).message };
  }
}

/**
 * Parse the DDG HTML SERP. The markup uses `.result__a` for the title link,
 * `.result__url` for the displayed URL, `.result__snippet` for the snippet.
 * Real result hrefs are wrapped in `/l/?uddg=<encoded>` so we unwrap.
 */
function parseDuckDuckGoHtml(html: string): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  // Split by `<div class="result` so each "block" contains exactly one hit.
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const titleMatch = block.match(
      /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    const snippetMatch = block.match(
      /<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
    ) ?? block.match(/<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

    if (!titleMatch) continue;
    let href = titleMatch[1];
    // Unwrap /l/?uddg=<encoded>
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try { href = decodeURIComponent(uddg[1]); } catch { /* keep raw */ }
    }
    if (href.startsWith("//")) href = "https:" + href;
    const title = htmlToText(titleMatch[2]);
    const snippet = snippetMatch ? htmlToText(snippetMatch[1]) : "";
    if (!title || !href.startsWith("http")) continue;
    hits.push({ title, url: href, snippet });
  }
  return hits;
}

export async function webSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number } = {},
): Promise<WebSearchResult> {
  const q = query.trim();
  if (!q) return { ok: false, query, hits: [], error: "empty query" };

  // The HTML endpoint returns plain markup with no JS gates.
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  try {
    const { text } = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `q=${encodeURIComponent(q)}`,
      timeoutMs: opts.timeoutMs,
    });
    const cap = opts.maxResults ?? DEFAULT_SEARCH_RESULTS;
    const hits = parseDuckDuckGoHtml(text).slice(0, cap);
    if (hits.length === 0) {
      // DDG sometimes returns a captcha / "no results" page — surface that.
      const isCaptcha = /captcha|anomaly/i.test(text);
      return {
        ok: false,
        query: q,
        hits: [],
        error: isCaptcha ? "DuckDuckGo blocked the request (captcha)" : "no results",
      };
    }
    return { ok: true, query: q, hits };
  } catch (err) {
    return { ok: false, query: q, hits: [], error: (err as Error).message };
  }
}
