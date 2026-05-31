import { useEffect, useState } from "react";
import { pig } from "../lib/pig.js";

/** Windows-style minimize / maximize / close (VS Code–like custom title bar). */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void pig.windowIsMaximized().then(setMaximized);
    return pig.onWindowMaximized(setMaximized);
  }, []);

  return (
    <div className="window-controls" role="group" aria-label="Window">
      <button
        type="button"
        tabIndex={-1}
        className="window-controls__btn"
        title="Minimize"
        aria-label="Minimize"
        onClick={() => void pig.windowMinimize()}
      >
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
          <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        tabIndex={-1}
        className="window-controls__btn"
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => void pig.windowMaximize()}
      >
        {maximized ? (
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
            <rect x="2.5" y="0.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
            <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
            <rect x="1" y="1" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button
        type="button"
        tabIndex={-1}
        className="window-controls__btn window-controls__btn--close"
        title="Close"
        aria-label="Close"
        onClick={() => void pig.windowClose()}
      >
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
          <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
    </div>
  );
}
