import { useEffect } from "react";
import { pig } from "./pig.js";

/** Returns true when the event target is a text field (skip zoom shortcuts there). */
function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

/**
 * Global UI zoom: Ctrl/Cmd + +/−/0 and Ctrl/Cmd + wheel.
 * Level is persisted in main (electron-store) and restored on launch.
 */
export function useUiZoomShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (isTextInputTarget(e.target)) return;

      const k = e.key;
      if (k === "=" || k === "+" || k === "Add") {
        e.preventDefault();
        void pig.zoomStep(10);
      } else if (k === "-" || k === "_" || k === "Subtract") {
        e.preventDefault();
        void pig.zoomStep(-10);
      } else if (k === "0" || k === "Digit0") {
        e.preventDefault();
        void pig.zoomSet(100);
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (isTextInputTarget(e.target)) return;
      e.preventDefault();
      void pig.zoomStep(e.deltaY < 0 ? 10 : -10);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onWheel);
    };
  }, []);
}
