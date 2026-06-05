import { useEffect, useState } from "react";
import { api, type AgentCommandRun } from "../lib/api";
import { pig } from "../lib/pig.js";
import { IconCopy, IconAlertTriangle } from "./Icons";

interface Props {
  runId: string;
}

/**
 * Read-only viewer for a captured agent `run_command` execution. Renders the
 * full stdout/stderr exactly as bash printed it, plus a small status footer.
 *
 * We intentionally avoid spinning up an xterm.js instance for these — the data
 * is static and pre-captured, and a plain `<pre>` is faster, copy-friendly,
 * and lets the user select text without tripping xterm's mouse handlers.
 */
export function AgentTerminalView({ runId }: Props) {
  const [run, setRun] = useState<AgentCommandRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRun(null);
    setError(null);
    api.getAgentCommand(runId)
      .then((r) => { if (!cancelled) setRun(r); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [runId]);

  if (error) {
    return <div className="agent-term-empty"><IconAlertTriangle size={13} style={{ marginRight: 4 }} />Failed to load: {error}</div>;
  }
  if (!run) {
    return <div className="agent-term-empty">Loading…</div>;
  }

  const ok = run.exitCode === 0;
  const startedAt = new Date(run.startedAt).toLocaleTimeString();
  const dur = run.durationMs >= 1000
    ? `${(run.durationMs / 1000).toFixed(2)}s`
    : `${run.durationMs}ms`;

  return (
    <div className="agent-term">
      <div className="agent-term-header">
        <span className="agent-term-prompt">$</span>
        <span className="agent-term-cmd" title={run.cmd}>{run.cmd}</span>
        <span className={`agent-term-exit ${ok ? "ok" : "fail"}`}>
          exit {run.exitCode}
        </span>
        <span className="agent-term-meta">{dur} · {startedAt}</span>
        <button
          className="agent-term-copy"
          title="Copy output"
          onClick={() => {
            const text = formatRun(run);
            pig.clipboardWrite(text).catch(() => { /* noop */ });
          }}
        >
          <IconCopy size={13} />
        </button>
      </div>
      <div className="agent-term-cwd">cwd: {run.cwd}</div>
      <pre className="agent-term-output">
        {run.stdout}
        {run.stderr && (
          <>
            {run.stdout ? "\n" : ""}
            <span className="agent-term-stderr">{run.stderr}</span>
          </>
        )}
        {run.truncated && <span className="agent-term-truncated">{"\n[output truncated]"}</span>}
      </pre>
    </div>
  );
}

function formatRun(r: AgentCommandRun): string {
  const lines: string[] = [];
  lines.push(`$ ${r.cmd}`);
  lines.push(`# cwd: ${r.cwd}`);
  lines.push(`# exit ${r.exitCode} · ${r.durationMs}ms`);
  if (r.stdout) lines.push(r.stdout);
  if (r.stderr) lines.push("--- stderr ---", r.stderr);
  return lines.join("\n");
}
