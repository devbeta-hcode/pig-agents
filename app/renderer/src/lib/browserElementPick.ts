import type { BrowserElementPickDetail } from "./browserElementRefs.js";
import { BROWSER_ELEMENT_PICK_EVENT } from "./browserElementRefs.js";

export function dispatchBrowserElementPick(detail: BrowserElementPickDetail): void {
  window.dispatchEvent(new CustomEvent(BROWSER_ELEMENT_PICK_EVENT, { detail }));
}
