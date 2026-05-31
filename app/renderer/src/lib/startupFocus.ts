import { useEffect } from "react";

/** Shell UI that must never steal focus on app launch (Electron focuses first tabbable). */
const CHROME_SELECTOR =
  ".titlebar, .window-controls, .activity, .statusbar, .workspace-manager";

/**
 * Blur chrome / xterm helper and move focus to `body` so no button shows a focus ring.
 * Safe to call repeatedly during the first ~600ms after load.
 */
export function releaseInitialFocus(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el !== document.body) {
    const isChrome =
      el.closest(CHROME_SELECTOR) != null ||
      el.classList.contains("xterm-helper-textarea");
    const isDialog = el.closest('[role="dialog"], .modal, .ant-modal-wrap') != null;
    if (isChrome && !isDialog) el.blur();
  }
  if (document.body.tabIndex < 0) document.body.tabIndex = -1;
  document.body.focus({ preventScroll: true });
}

/** Run on mount — catches late layout / xterm / panel focus shifts. */
export function useReleaseInitialFocus(): void {
  useEffect(() => {
    releaseInitialFocus();
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(releaseInitialFocus),
    );
    const timers = [0, 50, 150, 350, 600].map((ms) =>
      setTimeout(releaseInitialFocus, ms),
    );
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
    };
  }, []);
}
