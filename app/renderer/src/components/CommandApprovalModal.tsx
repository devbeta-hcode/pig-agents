import { useEffect, useRef, useState } from "react";
import { IconZap } from "./Icons";
import { IconAlertTriangle } from "./Icons";

export interface PendingApproval {
  askId: string;
  cmd: string;
  /** Coarse pattern the backend suggests for "Allow always" (e.g. `git push *`). */
  suggestedAllow: string;
  /** "command" (default) | "web_fetch" | "web_search" | "browser" — drives the modal copy. */
  kind?: "command" | "web_fetch" | "web_search" | "browser" | "delete_path";
}

interface Props {
  pending: PendingApproval | null;
  onAnswer: (askId: string, decision: "allow_once" | "allow_always" | "deny", editedCmd?: string) => void;
  /**
   * Optional escape hatch: flips the global "auto-approve every command
   * (except deny-list)" switch on, then answers the current prompt with
   * "allow once" using the (possibly edited) command. Hidden when not
   * provided so this stays a power-user feature.
   */
  onAutoApproveAll?: (askId: string, editedCmd?: string) => void;
  /**
   * Optional: flips the per-workspace "auto-allow web tools" toggle on,
   * then answers the current prompt with allow-once. Only meaningful for
   * `web_fetch` / `web_search` / `browser` kinds. Hidden when not provided.
   */
  onAutoApproveWeb?: (askId: string, editedCmd?: string) => void;
  /** Flips auto-allow delete_path in Settings, then allow-once for this ask. */
  onAutoApproveDelete?: (askId: string, editedCmd?: string) => void;
}

/**
 * Modal that pops whenever the agent emits a `policy_ask` event. The agent
 * is *blocked* on a backend Promise while this is open, so we keep the UI
 * focused — no escape hatch to dismiss without answering, just three clear
 * actions and an optional edit field for the "trust but tweak" case.
 *
 * Keyboard: Enter = Allow once, Cmd/Ctrl+Enter = Allow always, Esc = Deny.
 * Mirrors common terminal prompts so muscle memory does the right thing.
 */
export function CommandApprovalModal({
  pending,
  onAnswer,
  onAutoApproveAll,
  onAutoApproveWeb,
  onAutoApproveDelete,
}: Props) {
  const [edited, setEdited] = useState("");
  const [trustPattern, setTrustPattern] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset state whenever a new approval arrives so we don't show stale text
  // from the previous prompt.
  useEffect(() => {
    if (pending) {
      setEdited(pending.cmd);
      setTrustPattern(pending.suggestedAllow);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [pending?.askId]);

  useEffect(() => {
    if (!pending) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onAnswer(pending!.askId, "deny");
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onAnswer(pending!.askId, "allow_always", edited.trim() || undefined);
      } else if (e.key === "Enter" && document.activeElement?.tagName !== "INPUT") {
        // Enter from a button/elsewhere → "Allow once". When focus is in the
        // edit input we let Enter act as a normal submit (wired separately
        // on the input below).
        e.preventDefault();
        onAnswer(pending!.askId, "allow_once", edited.trim() || undefined);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending?.askId, edited, onAnswer]);

  if (!pending) return null;

  const cmdChanged = edited.trim() !== pending.cmd.trim();
  const recursiveDelete =
    /\brd\s+(\/s\s+)?\/q\b/i.test(edited) ||
    /\brmdir\s+(\/s\s+)?\/q\b/i.test(edited) ||
    /\bRemove-Item\b[^\n;|&]*-Recurse/i.test(edited) ||
    /\brm\s+-[a-z]*f[a-z]*\b/i.test(edited);
  const kind = pending.kind ?? "command";
  const isWeb = kind === "web_fetch" || kind === "web_search" || kind === "browser";
  const isDelete = kind === "delete_path";
  const title = kind === "delete_path"
    ? "Agent wants to delete a path"
    : kind === "web_fetch"
      ? "Agent wants to fetch a URL"
      : kind === "web_search"
        ? "Agent wants to run a web search"
        : kind === "browser"
          ? "Agent wants to drive the browser"
          : "Agent wants to run a command";
  const fieldLabel = kind === "delete_path"
    ? "Path (workspace-relative)"
    : kind === "web_fetch"
      ? "URL"
      : kind === "web_search"
        ? "Query"
        : kind === "browser"
          ? "URL"
          : "Command";
  const hint = kind === "delete_path"
    ? "Permanent delete — not Recycle Bin. Only paths inside the workspace are allowed (no *, **, .., or D:\\…). Enable \"Auto-allow deletes\" in Settings to skip this prompt."
    : kind === "web_fetch"
      ? "The agent will fetch this URL and read its plaintext. Loopback / private IPs are blocked at the tool layer regardless. Enable \"Auto-allow web tools\" in Settings to skip this prompt."
      : kind === "web_search"
        ? "The agent will run this DuckDuckGo HTML search and read the result list (no clicks). Enable \"Auto-allow web tools\" in Settings to skip this prompt."
        : kind === "browser"
          ? "The agent will drive the embedded Electron browser (visible in the Browser panel). Enable \"Auto-allow web tools\" in Settings to skip this prompt."
          : "This command isn’t on your allow-list yet. Review it carefully before letting the agent run it.";

  return (
    <div className="modal-backdrop policy-modal-backdrop">
      <div className="modal policy-modal" role="dialog" aria-modal="true" aria-labelledby="policy-modal-title">
        <div className="modal-header">
          <div id="policy-modal-title" className="modal-title">
            <span className="policy-modal-icon"><IconAlertTriangle size={13} /></span> {title}
          </div>
        </div>
        <div className="modal-body">
          <div className="policy-modal-hint">
            {hint}
          </div>
          {recursiveDelete && (
            <div
              className="policy-modal-hint"
              style={{ color: "var(--danger, #c53030)", fontWeight: 600, marginTop: 8 }}
              role="alert"
            >
              Permanent delete (rd/rmdir/Remove-Item -Recurse). Not Recycle Bin — can wipe folders outside the
              workspace. Newer builds block this in run_command; use file-tree Delete instead.
            </div>
          )}
          <div className="policy-modal-cmd-label">{fieldLabel}</div>
          <input
            ref={inputRef}
            className="policy-modal-cmd"
            value={edited}
            onChange={(e) => setEdited(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onAnswer(pending.askId, "allow_once", edited.trim() || undefined);
              }
            }}
            spellCheck={false}
            autoComplete="off"
          />
          {cmdChanged && (
            <div className="policy-modal-edited-note">
              Edited from: <code>{pending.cmd}</code>
            </div>
          )}
          {!isWeb && !isDelete && (
            <div className="policy-modal-trust">
              <label>
                <span className="policy-modal-trust-label">“Allow always” pattern</span>
                <input
                  className="policy-modal-trust-input"
                  value={trustPattern}
                  onChange={(e) => setTrustPattern(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <div className="policy-modal-trust-hint">
                Used only when you click <b>Allow always</b>. <code>*</code> is a wildcard. Edit it to be as specific as you’re comfortable with.
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer policy-modal-footer">
          <button
            className="policy-modal-deny"
            onClick={() => onAnswer(pending.askId, "deny")}
            title="Esc"
          >
            Deny
          </button>
          {onAutoApproveAll && !isWeb && !isDelete && (
            <button
              className="policy-modal-yolo"
              onClick={() => onAutoApproveAll(pending.askId, edited.trim() || undefined)}
              title="Run this and auto-approve every future command (deny-list still applies)"
            >
              <IconZap size={13} style={{ marginRight: 4 }} />Auto-approve all
            </button>
          )}
          <div className="policy-modal-spacer" />
          <button
            className="policy-modal-allow-once"
            onClick={() => onAnswer(pending.askId, "allow_once", edited.trim() || undefined)}
            title="Enter"
          >
            Allow once
          </button>
          {!isWeb && !isDelete && (
            <button
              className="policy-modal-allow-always"
              onClick={() => onAnswer(pending.askId, "allow_always", edited.trim() || undefined)}
              title="Cmd/Ctrl+Enter"
            >
              Allow always
            </button>
          )}
          {isDelete && (
            <button
              className="policy-modal-allow-always"
              onClick={() => onAnswer(pending.askId, "allow_always", edited.trim() || undefined)}
              title="Trust this path pattern for future deletes"
            >
              Allow always (this path)
            </button>
          )}
          {isDelete && onAutoApproveDelete && (
            <button
              className="policy-modal-allow-always"
              onClick={() => onAutoApproveDelete(pending.askId, edited.trim() || undefined)}
              title="Allow this delete and auto-approve all future delete_path calls"
            >
              <IconZap size={13} style={{ marginRight: 4 }} />Always allow deletes
            </button>
          )}
          {isWeb && onAutoApproveWeb && (
            <button
              className="policy-modal-allow-always"
              onClick={() => onAutoApproveWeb(pending.askId, edited.trim() || undefined)}
              title="Allow this and auto-approve all future web_fetch / web_search / browser calls (toggle in Settings)"
            >
              <IconZap size={13} style={{ marginRight: 4 }} />Always allow web
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
