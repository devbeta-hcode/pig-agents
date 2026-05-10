/**
 * BrowserSession — wraps a Playwright Chromium instance and exposes:
 *   - CDP screencast (JPEG frames pushed over WebSocket)
 *   - navigate / click / eval / getElement actions
 *   - playwright install check + one-shot install via child_process
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { logger } from "../utils/logger.js";

// Lazy-import playwright so the server starts fine even if it's not installed.
let playwrightAvailable: boolean | null = null;

async function checkPlaywright(): Promise<boolean> {
  if (playwrightAvailable !== null) return playwrightAvailable;
  try {
    await import("playwright");
    playwrightAvailable = true;
  } catch {
    playwrightAvailable = false;
  }
  return playwrightAvailable;
}

interface ScreencastFrame {
  data: string; // base64 JPEG
  timestamp: number;
}

interface ElementInfo {
  outerHTML: string;
  path: string;
  attributes: Record<string, string>;
  textContent: string;
  rect: { top: number; left: number; width: number; height: number };
  computedStyles: Record<string, string>;
}

type BrowserEvent =
  | { type: "frame"; data: string; timestamp: number }
  | { type: "navigate"; url: string; title: string }
  | { type: "status"; status: "idle" | "loading" | "error"; message?: string }
  | { type: "install_progress"; line: string }
  | { type: "install_done"; success: boolean; message: string };

export class BrowserSession extends EventEmitter {
  private browser: import("playwright").Browser | null = null;
  private page: import("playwright").Page | null = null;
  private cdp: import("playwright").CDPSession | null = null;
  private started = false;
  private screencastActive = false;

  // -------------------------------------------------------------------------
  async isPlaywrightReady(): Promise<boolean> {
    return checkPlaywright();
  }

  // -------------------------------------------------------------------------
  /** Install chromium browser binary.  Streams progress lines via events. */
  installPlaywright(): void {
    const proc = spawn("npx", ["playwright", "install", "chromium", "--with-deps"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env: { ...process.env },
    });

    proc.stdout.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) this.emit("event", { type: "install_progress", line } satisfies BrowserEvent);
    });
    proc.stderr.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) this.emit("event", { type: "install_progress", line } satisfies BrowserEvent);
    });
    proc.on("close", (code) => {
      playwrightAvailable = null; // reset cache
      const success = code === 0;
      this.emit("event", {
        type: "install_done",
        success,
        message: success ? "Playwright installed successfully." : `Install failed (exit ${code}).`,
      } satisfies BrowserEvent);
    });
  }

  // -------------------------------------------------------------------------
  async start(): Promise<void> {
    if (this.started) return;
    if (!(await checkPlaywright())) {
      throw new Error("Playwright not installed. Call installPlaywright() first.");
    }
    const { chromium } = await import("playwright");
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const ctx = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    });
    this.page = await ctx.newPage();
    this.cdp = await ctx.newCDPSession(this.page);
    this.started = true;

    // Relay navigation events
    this.page.on("framenavigated", (frame) => {
      if (frame !== this.page!.mainFrame()) return;
      this.emit("event", {
        type: "navigate",
        url: frame.url(),
        title: "",
      } satisfies BrowserEvent);
    });
    this.page.on("load", async () => {
      try {
        const title = await this.page!.title();
        this.emit("event", { type: "navigate", url: this.page!.url(), title } satisfies BrowserEvent);
        this.emit("event", { type: "status", status: "idle" } satisfies BrowserEvent);
      } catch { /* page closing */ }
    });

    logger.info("[browser] Chromium started");
    await this.startScreencast();
  }

  async stop(): Promise<void> {
    try { await this.cdp?.detach(); } catch { /* noop */ }
    try { await this.browser?.close(); } catch { /* noop */ }
    this.cdp = null;
    this.page = null;
    this.browser = null;
    this.started = false;
    this.screencastActive = false;
    logger.info("[browser] Chromium stopped");
  }

  // -------------------------------------------------------------------------
  private async startScreencast(): Promise<void> {
    if (!this.cdp || this.screencastActive) return;
    this.screencastActive = true;

    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 75,
      maxWidth: 1280,
      maxHeight: 800,
    });

    this.cdp.on("Page.screencastFrame", async ({ data, sessionId, metadata }) => {
      this.emit("event", {
        type: "frame",
        data,                          // base64 JPEG
        timestamp: metadata.timestamp ?? Date.now(),
      } satisfies BrowserEvent);
      // ack so Chrome sends the next frame
      try { await this.cdp?.send("Page.screencastFrameAck", { sessionId }); } catch { /* noop */ }
    });
  }

  // -------------------------------------------------------------------------
  async navigate(url: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    this.emit("event", { type: "status", status: "loading" } satisfies BrowserEvent);
    // Ensure URL has a scheme
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    await this.page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  async goBack(): Promise<void> {
    await this.page?.goBack({ waitUntil: "domcontentloaded" });
  }

  async goForward(): Promise<void> {
    await this.page?.goForward({ waitUntil: "domcontentloaded" });
  }

  async reload(): Promise<void> {
    await this.page?.reload({ waitUntil: "domcontentloaded" });
  }

  currentUrl(): string {
    return this.page?.url() ?? "";
  }

  // -------------------------------------------------------------------------
  /** Click at viewport coords (x, y). Returns the element under cursor. */
  async clickAt(x: number, y: number): Promise<ElementInfo | null> {
    if (!this.page) throw new Error("Browser not started");
    const info = await this.getElementAt(x, y);
    await this.page.mouse.click(x, y);
    return info;
  }

  async getElementAt(x: number, y: number): Promise<ElementInfo | null> {
    if (!this.page) return null;
    try {
      // Use raw string evaluation to avoid Playwright fn-serialization issues
      const info = await this.page.evaluate(`(function() {
        var ax = ${x}, ay = ${y};
        var all = document.elementsFromPoint(ax, ay);
        var el = null;
        for (var i = 0; i < all.length; i++) {
          var t = all[i].tagName;
          if (t !== 'HTML' && t !== 'BODY') { el = all[i]; break; }
        }
        if (!el && all.length > 0) el = all[0];
        if (!el) return null;

        function buildPath(e) {
          if (!e.parentElement) return e.tagName.toLowerCase();
          var sib = Array.from(e.parentElement.children).filter(function(c) { return c.tagName === e.tagName; });
          var idx = sib.indexOf(e);
          var tag = e.tagName.toLowerCase();
          var id = e.id ? '#' + e.id : '';
          var cls = Array.from(e.classList).slice(0, 2).map(function(c) { return '.' + c; }).join('');
          var sfx = sib.length > 1 ? ':nth-of-type(' + (idx + 1) + ')' : '';
          return buildPath(e.parentElement) + ' > ' + tag + id + cls + sfx;
        }

        var attrs = {};
        Array.from(el.attributes).forEach(function(a) { attrs[a.name] = a.value; });

        var rect = el.getBoundingClientRect();
        var style = window.getComputedStyle(el);
        var TRACKED = ['color','background-color','font-size','font-family',
          'padding','margin','border','display','flex-direction',
          'width','height','position','z-index'];
        var computedStyles = {};
        TRACKED.forEach(function(p) { computedStyles[p] = style.getPropertyValue(p); });

        return {
          outerHTML: el.outerHTML.slice(0, 2000),
          path: buildPath(el),
          attributes: attrs,
          textContent: (el.textContent || '').trim().slice(0, 500),
          rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          computedStyles: computedStyles,
        };
      })()`);
      return info as ElementInfo | null;
    } catch (err) {
      logger.warn("[browser] getElementAt failed:", err);
      return null;
    }
  }

  async typeText(text: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.page.keyboard.type(text);
  }

  async keyPress(key: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.page.keyboard.press(key);
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.page.mouse.move(x, y);
    await this.page.mouse.wheel(deltaX, deltaY);
  }

  async hover(x: number, y: number): Promise<string | null> {
    if (!this.page) return null;
    try {
      return await this.page.evaluate(
        ({ x, y }: { x: number; y: number }) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return null;
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : "";
          const cls = Array.from(el.classList).slice(0, 2).map((c) => `.${c}`).join("");
          const role = el.getAttribute("aria-label") || el.getAttribute("title") || "";
          return `${tag}${id}${cls}${role ? ` — ${role}` : ""}`;
        },
        { x, y },
      );
    } catch {
      return null;
    }
  }

  async takeScreenshot(): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    const buf = await this.page.screenshot({ type: "png", fullPage: false });
    return buf.toString("base64");
  }

  /** Inspect element at (x,y): returns element info + cropped screenshot of its bounding rect */
  async inspectElement(x: number, y: number): Promise<{ element: ElementInfo; screenshot: string } | null> {
    if (!this.page) throw new Error("Browser not started");
    const info = await this.getElementAt(x, y);
    if (!info) return null;
    const { top, left, width, height } = info.rect;
    // Clamp clip strictly inside viewport (1280×800)
    const cx = Math.max(0, Math.round(left));
    const cy = Math.max(0, Math.round(top));
    const cw = Math.min(1280 - cx, Math.max(1, Math.round(width)));
    const ch = Math.min(800 - cy, Math.max(1, Math.round(height)));
    let screenshot = "";
    if (cw > 0 && ch > 0) {
      try {
        const buf = await this.page.screenshot({ type: "png", clip: { x: cx, y: cy, width: cw, height: ch } });
        screenshot = buf.toString("base64");
      } catch {
        // fallback: full viewport screenshot
        try {
          const buf = await this.page.screenshot({ type: "png", fullPage: false });
          screenshot = buf.toString("base64");
        } catch { /* non-fatal */ }
      }
    }
    return { element: info, screenshot };
  }

  async evalScript(js: string): Promise<unknown> {
    if (!this.page) throw new Error("Browser not started");
    return this.page.evaluate(js);
  }

  // -------------------------------------------------------------------------
  // Helpers used by the agent's `browser_*` tools. They share the same page
  // as the BrowserPanel so the user can watch what the agent is doing live.

  /** Lazy-launch on first agent use so the LLM doesn't have to remember to
   *  call a separate "start" tool. */
  async ensureStarted(): Promise<void> {
    if (this.started) return;
    if (!(await checkPlaywright())) {
      throw new Error(
        "Playwright is not installed. Open the Browser panel and click Install, or run `npx playwright install chromium` once.",
      );
    }
    await this.start();
  }

  /** Current page title (best-effort). */
  async getTitle(): Promise<string> {
    if (!this.page) return "";
    try { return await this.page.title(); } catch { return ""; }
  }

  /** Visible text of the page (or a selector subtree). HTML is stripped, runs
   *  of whitespace are collapsed, and the result is capped to keep the model
   *  context small. */
  async getPageText(selector?: string, maxChars = 12_000): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    const raw = await this.page.evaluate(
      ({ sel }: { sel: string | null }) => {
        const root = sel ? document.querySelector(sel) : document.body;
        if (!root) return "";
        // innerText respects layout (no <script>/<style> noise) and matches
        // what a human user would see.
        return (root as HTMLElement).innerText || root.textContent || "";
      },
      { sel: selector ?? null },
    );
    const collapsed = String(raw).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (collapsed.length <= maxChars) return collapsed;
    return `${collapsed.slice(0, maxChars)}\n\n…[truncated, original ${collapsed.length} chars]`;
  }

  /** Outer HTML of the page (or a selector). Capped. */
  async getPageHTML(selector?: string, maxChars = 20_000): Promise<string> {
    if (!this.page) throw new Error("Browser not started");
    const raw = await this.page.evaluate(
      ({ sel }: { sel: string | null }) => {
        const root = sel ? document.querySelector(sel) : document.documentElement;
        if (!root) return "";
        return (root as Element).outerHTML;
      },
      { sel: selector ?? null },
    );
    const html = String(raw);
    if (html.length <= maxChars) return html;
    return `${html.slice(0, maxChars)}\n<!-- truncated, original ${html.length} chars -->`;
  }

  /** Click the first element matching a CSS selector. */
  async clickSelector(selector: string, timeoutMs = 8_000): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.page.click(selector, { timeout: timeoutMs });
  }

  /** Fill an `<input>` / `<textarea>` matching a selector. */
  async fillSelector(selector: string, value: string, timeoutMs = 8_000): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.page.fill(selector, value, { timeout: timeoutMs });
  }

  /** Wait for a selector to appear / become visible. */
  async waitForSelector(
    selector: string,
    state: "attached" | "visible" | "hidden" = "visible",
    timeoutMs = 10_000,
  ): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    await this.page.waitForSelector(selector, { state, timeout: timeoutMs });
  }

  isStarted(): boolean { return this.started; }
}

// Singleton
export const browserSession = new BrowserSession();
