import { useEffect, useState } from "react";
import { pig } from "./pig.js";

// Native BrowserView is an OS-level overlay: it always paints above the HTML
// renderer inside its bounds and cannot be layered with CSS z-index. For
// full-screen HTML surfaces (modals) we zero the whole view. The browser's own
// dropdown is handled differently — `measureBrowserHost` carves just the
// overlapping column so the page stays visible (see browserBounds.ts).
const MODAL_SELECTOR =
  ".modal-backdrop, .chat-browser-backdrop, [data-suppress-browser-overlay]";

function countBlockingOverlays(): number {
  return document.querySelectorAll(MODAL_SELECTOR).length;
}

/**
 * BrowserView is clipped to the browser tab host (see measureBrowserHost).
 * Zero bounds when the browser tab is inactive, a modal needs the full HTML
 * layer, or a browser dropdown is open (native view cannot sit under HTML).
 */
export function useBrowserOverlayGuard(browserTabActive: boolean): void {
  const [modalOpen, setModalOpen] = useState(() => countBlockingOverlays() > 0);

  useEffect(() => {
    const check = () => setModalOpen(countBlockingOverlays() > 0);
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true });
    check();
    return () => mo.disconnect();
  }, []);

  const suppress = !browserTabActive || modalOpen;

  useEffect(() => {
    void pig.browserSetOverlaySuppressed(suppress);
  }, [suppress]);

  useEffect(() => {
    void pig.browserSetTabActive(browserTabActive);
  }, [browserTabActive]);
}
