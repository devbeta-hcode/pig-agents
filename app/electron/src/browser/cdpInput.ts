/**
 * Playwright-style pointer/keyboard input via Chrome DevTools Protocol.
 * No Playwright dependency — uses Electron webContents.debugger.
 */
import type { WebContents } from "electron";
import { logger as log } from "@pig-agents/core";

const CDP_VERSION = "1.3";
/** Delay between keystrokes — similar to Playwright keyboard.type({ delay }). */
const KEY_DELAY_MS = 28;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function attachCdp(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) throw new Error("Browser guest destroyed");
  if (contents.debugger.isAttached()) return;
  await contents.debugger.attach(CDP_VERSION);
}

export function detachCdp(contents: WebContents | null | undefined): void {
  if (!contents || contents.isDestroyed()) return;
  if (!contents.debugger.isAttached()) return;
  try {
    contents.debugger.detach();
  } catch {
    /* noop */
  }
}

async function cdpCommand(
  contents: WebContents,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  await attachCdp(contents);
  return contents.debugger.sendCommand(method, params);
}

/** Move → press → release (same CDP sequence Playwright uses). */
export async function cdpPointerClick(contents: WebContents, x: number, y: number): Promise<void> {
  contents.focus();
  const cx = Math.round(x);
  const cy = Math.round(y);
  await cdpCommand(contents, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: cx,
    y: cy,
    button: "none",
    clickCount: 0,
  });
  await sleep(80);
  await cdpCommand(contents, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: cx,
    y: cy,
    button: "left",
    clickCount: 1,
  });
  await sleep(80);
  await cdpCommand(contents, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: cx,
    y: cy,
    button: "left",
    clickCount: 1,
  });
}

/** Fallback when DevTools already holds the debugger session. */
export async function osPointerClick(contents: WebContents, x: number, y: number): Promise<void> {
  contents.focus();
  const cx = Math.round(x);
  const cy = Math.round(y);
  contents.sendInputEvent({ type: "mouseMove", x: cx, y: cy });
  await sleep(40);
  contents.sendInputEvent({ type: "mouseDown", x: cx, y: cy, button: "left", clickCount: 1 });
  await sleep(60);
  contents.sendInputEvent({ type: "mouseUp", x: cx, y: cy, button: "left", clickCount: 1 });
}

export async function pointerClick(contents: WebContents, x: number, y: number): Promise<void> {
  try {
    await cdpPointerClick(contents, x, y);
  } catch (err) {
    log.warn("CDP pointer click failed, using sendInputEvent", err);
    await osPointerClick(contents, x, y);
  }
}

/** Hover briefly before click — closer to human / Playwright pointer behavior. */
export async function pointerClickWithHover(contents: WebContents, x: number, y: number): Promise<void> {
  contents.focus();
  const cx = Math.round(x);
  const cy = Math.round(y);
  try {
    await cdpCommand(contents, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: cx,
      y: cy,
      button: "none",
      clickCount: 0,
    });
    await sleep(120);
    await cdpPointerClick(contents, x, y);
  } catch (err) {
    log.warn("CDP hover+click failed, using sendInputEvent", err);
    contents.sendInputEvent({ type: "mouseMove", x: cx, y: cy });
    await sleep(120);
    await osPointerClick(contents, x, y);
  }
}

/** CDP key payload for one printable character (Playwright-compatible fields). */
function keyPayloadForChar(ch: string): Record<string, unknown> {
  if (ch === "\n") {
    return {
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: "\r",
    };
  }
  if (ch === "\t") {
    return {
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
      text: "\t",
    };
  }
  if (ch === " ") {
    return {
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
      nativeVirtualKeyCode: 32,
      text: " ",
    };
  }
  const base: Record<string, unknown> = {
    key: ch,
    text: ch,
    unmodifiedText: ch,
  };
  if (ch.length === 1 && /[a-zA-Z]/.test(ch)) {
    base.code = `Key${ch.toUpperCase()}`;
    base.windowsVirtualKeyCode = ch.toUpperCase().charCodeAt(0);
    base.nativeVirtualKeyCode = base.windowsVirtualKeyCode;
    return base;
  }
  if (ch.length === 1 && /[0-9]/.test(ch)) {
    base.code = `Digit${ch}`;
    base.windowsVirtualKeyCode = ch.charCodeAt(0);
    base.nativeVirtualKeyCode = base.windowsVirtualKeyCode;
    return base;
  }
  if (ch.length === 1) {
    const vk = ch.charCodeAt(0);
    if (vk >= 32) {
      base.windowsVirtualKeyCode = vk;
      base.nativeVirtualKeyCode = vk;
    }
  }
  return base;
}

async function dispatchCharKey(contents: WebContents, ch: string): Promise<void> {
  const payload = keyPayloadForChar(ch);
  await contents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...payload });
  await contents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...payload });
}

/** Type text one key at a time — not insertText / not JS .value. */
export async function cdpTypeText(
  contents: WebContents,
  text: string,
  delayMs = KEY_DELAY_MS,
): Promise<void> {
  await attachCdp(contents);
  for (const ch of text) {
    await dispatchCharKey(contents, ch);
    if (delayMs > 0) await sleep(delayMs);
  }
}

const MOD_CTRL = 2;

export async function cdpSelectAll(contents: WebContents): Promise<void> {
  await attachCdp(contents);
  const base = {
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: MOD_CTRL,
  };
  await contents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await contents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

export async function cdpKeyTap(contents: WebContents, key: string): Promise<void> {
  await attachCdp(contents);
  const special: Record<string, Record<string, unknown>> = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
    Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
  };
  const payload = special[key] ?? { key, code: key };
  await contents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...payload });
  await contents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...payload });
}

async function osTypeText(contents: WebContents, text: string, delayMs: number): Promise<void> {
  contents.focus();
  for (const ch of text) {
    contents.sendInputEvent({ type: "char", keyCode: ch });
    if (delayMs > 0) await sleep(delayMs);
  }
}

/** Click field → select all → type each key (replaces selection like a human). */
export async function fillViaPointer(
  contents: WebContents,
  x: number,
  y: number,
  value: string,
): Promise<void> {
  await pointerClick(contents, x, y);
  await sleep(50);
  try {
    await cdpSelectAll(contents);
    await sleep(30);
    await cdpTypeText(contents, value);
  } catch (err) {
    log.warn("CDP fill failed, typing via sendInputEvent", err);
    await osTypeText(contents, value, KEY_DELAY_MS);
  }
}

export async function typeViaCdp(contents: WebContents, text: string): Promise<void> {
  try {
    await cdpTypeText(contents, text);
  } catch (err) {
    log.warn("CDP type failed, using sendInputEvent", err);
    await osTypeText(contents, text, KEY_DELAY_MS);
  }
}

export async function keyViaCdp(contents: WebContents, key: string): Promise<void> {
  try {
    await cdpKeyTap(contents, key);
  } catch (err) {
    contents.sendInputEvent({ type: "keyDown", keyCode: key });
    contents.sendInputEvent({ type: "keyUp", keyCode: key });
  }
}
