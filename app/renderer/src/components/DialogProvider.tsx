import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ConfirmOptions = {
  title?: string;
  message: string;
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
};

export type PromptOptions = {
  title?: string;
  message?: string;
  defaultValue?: string;
};

export type UnsavedChangesOptions = {
  fileName: string;
};

/** Save / discard / cancel — matches common IDE close-tab flow. */
export type UnsavedChangesChoice = "save" | "discard" | "cancel";

type DialogState =
  | null
  | {
      kind: "alert";
      title?: string;
      message: string;
      resolve: () => void;
    }
  | {
      kind: "confirm";
      title?: string;
      message: string;
      danger?: boolean;
      confirmLabel?: string;
      cancelLabel?: string;
      resolve: (v: boolean) => void;
    }
  | {
      kind: "prompt";
      title?: string;
      message?: string;
      defaultValue: string;
      resolve: (v: string | null) => void;
    }
  | {
      kind: "unsaved";
      fileName: string;
      resolve: (v: UnsavedChangesChoice) => void;
    };

export type DialogContextValue = {
  alert: (message: string, title?: string) => Promise<void>;
  confirm: (opts: string | ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
  unsavedChanges: (opts: UnsavedChangesOptions) => Promise<UnsavedChangesChoice>;
};

const DialogContext = createContext<DialogContextValue | null>(null);

export function useDialogs(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialogs must be used within DialogProvider");
  return ctx;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>(null);
  const promptInputRef = useRef<HTMLInputElement>(null);

  const alert = useCallback((message: string, title?: string) => {
    return new Promise<void>((resolve) => {
      setState({ kind: "alert", title, message, resolve });
    });
  }, []);

  const confirm = useCallback((opts: string | ConfirmOptions) => {
    const o = typeof opts === "string" ? { message: opts } : opts;
    return new Promise<boolean>((resolve) => {
      setState({
        kind: "confirm",
        title: o.title,
        message: o.message,
        danger: o.danger,
        confirmLabel: o.confirmLabel,
        cancelLabel: o.cancelLabel,
        resolve,
      });
    });
  }, []);

  const promptDialog = useCallback((opts: PromptOptions) => {
    return new Promise<string | null>((resolve) => {
      setState({
        kind: "prompt",
        title: opts.title,
        message: opts.message,
        defaultValue: opts.defaultValue ?? "",
        resolve,
      });
    });
  }, []);

  const unsavedChanges = useCallback((opts: UnsavedChangesOptions) => {
    return new Promise<UnsavedChangesChoice>((resolve) => {
      setState({ kind: "unsaved", fileName: opts.fileName, resolve });
    });
  }, []);

  const close = useCallback(() => setState(null), []);

  useEffect(() => {
    if (state?.kind !== "prompt") return;
    const t = window.setTimeout(() => promptInputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (state.kind === "confirm") {
        state.resolve(false);
        close();
      } else if (state.kind === "prompt") {
        state.resolve(null);
        close();
      } else if (state.kind === "unsaved") {
        state.resolve("cancel");
        close();
      } else {
        state.resolve();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, close]);

  function backdropMouseDown(e: React.MouseEvent) {
    if (e.target !== e.currentTarget) return;
    if (!state) return;
    if (state.kind === "confirm") {
      state.resolve(false);
      close();
    } else if (state.kind === "prompt") {
      state.resolve(null);
      close();
    } else if (state.kind === "unsaved") {
      state.resolve("cancel");
      close();
    } else {
      state.resolve();
      close();
    }
  }

  const ctx = useMemo<DialogContextValue>(
    () => ({ alert, confirm, prompt: promptDialog, unsavedChanges }),
    [alert, confirm, promptDialog, unsavedChanges],
  );

  return (
    <DialogContext.Provider value={ctx}>
      {children}
      {state && (
        <div
          className="modal-backdrop dialog-backdrop"
          role="presentation"
          onMouseDown={backdropMouseDown}
        >
          <div
            className="modal dialog-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span id="dialog-title">
                {state.kind === "alert" && (state.title ?? "Notice")}
                {state.kind === "confirm" && (state.title ?? "Confirm")}
                {state.kind === "prompt" && (state.title ?? "Input")}
                {state.kind === "unsaved" && "Unsaved changes"}
              </span>
              <button
                type="button"
                className="close"
                aria-label="Close"
                onClick={() => {
                  if (state.kind === "confirm") {
                    state.resolve(false);
                  } else if (state.kind === "prompt") {
                    state.resolve(null);
                  } else if (state.kind === "unsaved") {
                    state.resolve("cancel");
                  } else {
                    state.resolve();
                  }
                  close();
                }}
              >
                ×
              </button>
            </div>
            <div className="modal-body dialog-body">
              {state.kind === "prompt" ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = promptInputRef.current?.value ?? "";
                    state.resolve(v);
                    close();
                  }}
                >
                  {state.message && (
                    <p className="dialog-message">{state.message}</p>
                  )}
                  <input
                    ref={promptInputRef}
                    key={state.defaultValue}
                    className="dialog-prompt-input"
                    type="text"
                    defaultValue={state.defaultValue}
                    autoComplete="off"
                  />
                  <div className="modal-footer dialog-footer-inline">
                    <button
                      type="button"
                      onClick={() => {
                        state.resolve(null);
                        close();
                      }}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="primary">
                      OK
                    </button>
                  </div>
                </form>
              ) : state.kind === "unsaved" ? (
                <>
                  <p className="dialog-message">
                    Do you want to save the changes you made to{" "}
                    <strong>{state.fileName}</strong>?
                  </p>
                  <div className="modal-footer dialog-footer-unsaved">
                    <button
                      type="button"
                      className="primary"
                      autoFocus
                      onClick={() => {
                        state.resolve("save");
                        close();
                      }}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        state.resolve("discard");
                        close();
                      }}
                    >
                      Don&apos;t Save
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        state.resolve("cancel");
                        close();
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="dialog-message">{state.message}</p>
                  <div className="modal-footer">
                    {state.kind === "confirm" && (
                      <button
                        type="button"
                        onClick={() => {
                          state.resolve(false);
                          close();
                        }}
                      >
                        {state.cancelLabel ?? "Cancel"}
                      </button>
                    )}
                    <button
                      type="button"
                      className={state.kind === "confirm" && state.danger ? "danger" : "primary"}
                      autoFocus
                      onClick={() => {
                        if (state.kind === "confirm") {
                          state.resolve(true);
                        } else {
                          state.resolve();
                        }
                        close();
                      }}
                    >
                      {state.kind === "confirm"
                        ? state.confirmLabel ?? "OK"
                        : "OK"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
}
