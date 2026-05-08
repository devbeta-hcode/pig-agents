/**
 * Browser API routes:
 *   GET  /api/browser/status    — playwright installed? browser started?
 *   POST /api/browser/install   — kick off `npx playwright install chromium`
 *   POST /api/browser/start     — launch chromium
 *   POST /api/browser/stop      — kill chromium
 *   POST /api/browser/navigate  — { url }
 *   POST /api/browser/back
 *   POST /api/browser/forward
 *   POST /api/browser/reload
 *   POST /api/browser/click     — { x, y } → returns ElementInfo
 *   POST /api/browser/element   — { x, y } → returns ElementInfo (no click)
 *   POST /api/browser/eval      — { js }
 *
 * WebSocket /browser/ws  — push { type:"frame"|"navigate"|"status"|... }
 */

import { Router } from "express";
import { browserSession } from "../browser/session.js";

export const browserRouter = Router();

// ── status ──────────────────────────────────────────────────────────────────
browserRouter.get("/browser/status", async (_req, res) => {
  const installed = await browserSession.isPlaywrightReady();
  res.json({
    installed,
    running: browserSession.isStarted(),
    url: browserSession.currentUrl(),
  });
});

// ── install ──────────────────────────────────────────────────────────────────
browserRouter.post("/browser/install", (_req, res) => {
  // Fire-and-forget; progress comes via WebSocket events.
  browserSession.installPlaywright();
  res.json({ ok: true, message: "Install started. Watch WebSocket for progress." });
});

// ── start / stop ─────────────────────────────────────────────────────────────
browserRouter.post("/browser/start", async (_req, res) => {
  try {
    await browserSession.start();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

browserRouter.post("/browser/stop", async (_req, res) => {
  await browserSession.stop();
  res.json({ ok: true });
});

// ── navigation ────────────────────────────────────────────────────────────────
browserRouter.post("/browser/navigate", async (req, res) => {
  const { url } = req.body as { url?: string };
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    await browserSession.navigate(url);
    res.json({ ok: true, url: browserSession.currentUrl() });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

browserRouter.post("/browser/back", async (_req, res) => {
  await browserSession.goBack();
  res.json({ ok: true });
});

browserRouter.post("/browser/forward", async (_req, res) => {
  await browserSession.goForward();
  res.json({ ok: true });
});

browserRouter.post("/browser/reload", async (_req, res) => {
  await browserSession.reload();
  res.json({ ok: true });
});

// ── element inspection ────────────────────────────────────────────────────────
browserRouter.post("/browser/click", async (req, res) => {
  const { x, y } = req.body as { x?: number; y?: number };
  if (x == null || y == null) return res.status(400).json({ error: "x and y required" });
  try {
    const el = await browserSession.clickAt(x, y);
    res.json({ ok: true, element: el });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

browserRouter.post("/browser/element", async (req, res) => {
  const { x, y } = req.body as { x?: number; y?: number };
  if (x == null || y == null) return res.status(400).json({ error: "x and y required" });
  try {
    const el = await browserSession.getElementAt(x, y);
    res.json({ ok: true, element: el });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── eval ──────────────────────────────────────────────────────────────────────
browserRouter.post("/browser/eval", async (req, res) => {
  const { js } = req.body as { js?: string };
  if (!js) return res.status(400).json({ error: "js required" });
  try {
    const result = await browserSession.evalScript(js);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── keyboard & scroll ─────────────────────────────────────────────────────────
browserRouter.post("/browser/type", async (req, res) => {
  const { text } = req.body as { text?: string };
  if (!text) return res.status(400).json({ error: "text required" });
  try {
    await browserSession.typeText(text);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

browserRouter.post("/browser/key", async (req, res) => {
  const { key } = req.body as { key?: string };
  if (!key) return res.status(400).json({ error: "key required" });
  try {
    await browserSession.keyPress(key);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

browserRouter.post("/browser/scroll", async (req, res) => {
  const { x, y, deltaX, deltaY } = req.body as { x?: number; y?: number; deltaX?: number; deltaY?: number };
  if (x == null || y == null) return res.status(400).json({ error: "x and y required" });
  try {
    await browserSession.scroll(x, y, deltaX ?? 0, deltaY ?? 0);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

browserRouter.post("/browser/hover", async (req, res) => {
  const { x, y } = req.body as { x?: number; y?: number };
  if (x == null || y == null) return res.status(400).json({ error: "x and y required" });
  try {
    const label = await browserSession.hover(x, y);
    res.json({ ok: true, label });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

browserRouter.get("/browser/screenshot", async (_req, res) => {
  try {
    const data = await browserSession.takeScreenshot();
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

browserRouter.post("/browser/inspect", async (req, res) => {
  const { x, y } = req.body as { x?: number; y?: number };
  if (x == null || y == null) return res.status(400).json({ error: "x and y required" });
  try {
    const result = await browserSession.inspectElement(x, y);
    if (!result) return res.json({ ok: false, error: "No element found at this position" });
    res.json({ ok: true, element: result.element, screenshot: result.screenshot });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});
