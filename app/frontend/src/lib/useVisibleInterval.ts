import { useEffect, useRef } from "react";

/**
 * setInterval that automatically pauses while the tab is hidden and refires
 * once the user returns. Background polling otherwise piles up wasted work
 * (CPU, network, React commits) that competes with whatever the user is
 * trying to do, e.g. it makes the chat stream feel laggy when polling timers
 * land on the same frame as a token batch.
 *
 * Behaviour:
 *  - Disabled when `enabled === false`.
 *  - Skips the tick when `document.visibilityState === "hidden"`.
 *  - On `visibilitychange → visible` immediately refires once so freshly
 *    focused tabs don't show stale data.
 *
 * Pass `runImmediately` to also fire once when the effect starts.
 */
export function useVisibleInterval(
  fn: () => void,
  delayMs: number,
  enabled: boolean = true,
  runImmediately: boolean = false,
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;

    const safeFire = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try { fnRef.current(); } catch { /* swallow — pollers shouldn't crash hosts */ }
    };

    if (runImmediately) safeFire();

    const id = window.setInterval(safeFire, delayMs);
    const onVis = () => { if (document.visibilityState === "visible") safeFire(); };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [delayMs, enabled, runImmediately]);
}
