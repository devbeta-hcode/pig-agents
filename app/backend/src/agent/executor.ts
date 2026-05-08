import { listFiles, readFile, writeFile, searchCode, buildCodebaseMapSummary, globFiles } from "../tools/file.js";
import { runSmartCommand } from "../tools/smartCommand.js";
import { applyPatches, patchApplyErrorCode, validateWritePatchPayload, type PatchResult } from "../tools/patch.js";
import { autoValidate, summarizeValidation, type ValidationReport } from "../validation/validator.js";
import { startAgentCommand } from "./commandLog.js";
import { getWorkspace } from "../utils/workspace.js";
import { decide as policyDecide, trust as policyTrust } from "../utils/policy.js";
import { newAskId, waitForApproval, type ApprovalAnswer } from "../utils/approvals.js";

export interface ToolOutcome {
  ok: boolean;
  summary: string;
  data?: unknown;
  diffs?: string[];
}

/**
 * Optional context the runner can pass to each tool call. Today only
 * `run_command` consumes this (for the policy gate); other tools ignore it.
 *
 * - `emit`: fire structured events out to the SSE stream so the UI can
 *   surface the policy modal in real time.
 * - `runId`: links pending approvals back to a specific run so they can
 *   be cancelled atomically when the run is aborted.
 */
export interface ToolContext {
  runId?: string;
  /** ReAct iteration (for command_chunk SSE tagging). */
  iteration?: number;
  emit?: (event: { type: string; [k: string]: unknown }) => void;
}

export async function executeTool(
  type: string,
  input: Record<string, unknown>,
  ctx: ToolContext = {},
): Promise<ToolOutcome> {
  try {
    switch (type) {
      case "read_file": {
        const p = String(input.path || "");
        if (!p) return { ok: false, summary: "read_file: missing 'path'" };
        const content = await readFile(p);
        // Adaptive truncation: shorter for large files
        const maxLen = content.length > 10000 ? 4000 : content.length > 5000 ? 6000 : 8000;
        const truncated = content.length > maxLen ? content.slice(0, maxLen) + `\n…[+${Math.floor((content.length-maxLen)/1000)}k chars]` : content;
        return { ok: true, summary: `${p} (${content.length}c):\n${truncated}`, data: content };
      }
      case "list_files": {
        const dir = String(input.dir ?? ".");
        const items = await listFiles(dir);
        const lines = items.map((i) => `${i.isDir ? "d" : "-"} ${i.path}`);
        return { ok: true, summary: `${dir}/:\n${lines.join("\n").slice(0, 3000)}`, data: items };
      }
      case "search_code": {
        const q = String(input.query || "");
        if (!q) return { ok: false, summary: "search_code: missing 'query'" };
        const hits = await searchCode(q, 30);
        const lines = hits.slice(0, 20).map((h) => `${h.file}:${h.line}: ${h.text.slice(0,80)}`);
        return { ok: true, summary: `"${q}" (${hits.length} hits):\n${lines.join("\n")}`, data: hits };
      }
      case "codebase_map": {
        const maxDepth = Math.min(10, Math.max(1, Number(input.max_depth ?? input.depth ?? 5)));
        const summary = await buildCodebaseMapSummary({ maxDepth });
        return { ok: true, summary: summary.slice(0, 10000), data: { maxDepth } };
      }
      case "run_command": {
        const requestedCmd = String(input.cmd || "");
        if (!requestedCmd) return { ok: false, summary: "run_command: missing 'cmd'" };

        // ── Policy gate ────────────────────────────────────────────────────
        // Three outcomes: hard-deny, auto-allow, ask-the-user. Asking blocks
        // the runner on a Promise that resolves when the frontend POSTs an
        // answer to /agent/approvals/:askId.
        const decision = await policyDecide(requestedCmd);
        let cmd = requestedCmd;

        if (decision.decision === "deny") {
          ctx.emit?.({
            type: "policy_decision",
            decision: "deny",
            cmd: requestedCmd,
            matched: decision.matched,
            reason: "auto-blocked by deny-list",
          });
          return {
            ok: false,
            summary:
              `run_command BLOCKED by policy.\n` +
              `Command: ${requestedCmd}\n` +
              `Matched deny pattern: \`${decision.matched}\`\n\n` +
              `If you genuinely need this, edit .pig-agents/policy.json or ask the user to ` +
              `whitelist a safer pattern. Do NOT try to bypass with quoting tricks.`,
          };
        }

        if (decision.decision === "ask") {
          const askId = newAskId();
          ctx.emit?.({
            type: "policy_ask",
            askId,
            cmd: requestedCmd,
            suggestedAllow: decision.suggestedAllow,
          });
          let ans: ApprovalAnswer;
          try {
            ans = await waitForApproval(askId, requestedCmd, { runId: ctx.runId });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.emit?.({ type: "policy_decision", decision: "deny", cmd: requestedCmd, reason: msg });
            return { ok: false, summary: `run_command not approved: ${msg}` };
          }

          if (ans.decision === "deny") {
            ctx.emit?.({ type: "policy_decision", decision: "deny", cmd: requestedCmd, reason: "user denied" });
            return { ok: false, summary: "run_command denied by user." };
          }

          // The user may have edited the command before approving — respect that.
          if (typeof ans.editedCmd === "string" && ans.editedCmd.trim()) {
            cmd = ans.editedCmd.trim();
          }

          if (ans.decision === "allow_always") {
            try { await policyTrust(decision.suggestedAllow); } catch { /* best-effort */ }
          }

          ctx.emit?.({
            type: "policy_decision",
            decision: ans.decision,
            cmd,
            originalCmd: requestedCmd === cmd ? undefined : requestedCmd,
          });
        } else {
          // auto-allowed — emit a quiet decision event for the trace UI
          ctx.emit?.({
            type: "policy_decision",
            decision: "allow_auto",
            cmd: requestedCmd,
            matched: decision.matched,
          });
        }

        const startedAt = Date.now();
        const iter = ctx.iteration ?? 0;
        // Open a live terminal slot before the command starts so the UI can
        // display streaming output in the Terminals panel in real time.
        const cmdHandle = startAgentCommand(cmd, getWorkspace());
        let qOut = "";
        let qErr = "";
        let streamFlush: ReturnType<typeof setTimeout> | undefined;
        const flushCommandStream = () => {
          streamFlush = undefined;
          if (qOut) {
            ctx.emit?.({ type: "command_chunk", iteration: iter, stream: "stdout", text: qOut });
            cmdHandle.appendChunk("stdout", qOut);
            qOut = "";
          }
          if (qErr) {
            ctx.emit?.({ type: "command_chunk", iteration: iter, stream: "stderr", text: qErr });
            cmdHandle.appendChunk("stderr", qErr);
            qErr = "";
          }
        };
        const scheduleStreamFlush = () => {
          if (streamFlush === undefined) {
            streamFlush = setTimeout(flushCommandStream, 75);
          }
        };
        let r;
        try {
          r = await runSmartCommand(cmd, {
            cwd: getWorkspace(),
            onStreamChunk: (stream, text) => {
              if (stream === "out") qOut += text;
              else qErr += text;
              scheduleStreamFlush();
            },
          });
        } finally {
          if (streamFlush !== undefined) clearTimeout(streamFlush);
          flushCommandStream();
        }
        const finishedAt = Date.now();
        
        // Complete the live terminal slot and push to the finished ring.
        cmdHandle.complete({
          cmd: r.cmd,
          cwd: getWorkspace(),
          startedAt,
          finishedAt,
          durationMs: r.durationMs,
          exitCode: r.exitCode ?? (r.mode === "background" ? 0 : 1),
          stdout: r.stdout,
          stderr: r.stderr,
          truncated: r.truncated,
        });

        // Build output summary based on result mode
        let out = `$ ${r.cmd}\n`;
        let hints = "";

        switch (r.mode) {
          case "completed":
            out += `exit=${r.exitCode}`;
            if (r.stdout.trim()) out += `\nout: ${r.stdout.slice(-2000).trim()}`;
            if (r.stderr.trim()) out += `\nerr: ${r.stderr.slice(-1000).trim()}`;
            if (r.exitCode !== 0) {
              hints = `\n[!] Failed. Diagnose error, don't repeat same command.`;
            }
            break;

          case "background":
            out += `[BG] PID:${r.pid}`;
            if (r.readySignal) out += ` ready:"${r.readySignal}"`;
            if (r.stdout.trim()) out += `\n${r.stdout.slice(-1000).trim()}`;
            hints = `\n[!] Server ready. Continue with next step now!`;
            break;

          case "failed":
            out += `[FAIL]`;
            if (r.stdout.trim()) out += `\nout: ${r.stdout.slice(-1500).trim()}`;
            if (r.stderr.trim()) out += `\nerr: ${r.stderr.slice(-1500).trim()}`;
            // Compact error hints
            const combined = r.stdout + r.stderr;
            if (/EADDRINUSE|address already in use/i.test(combined)) hints += `\n[!] Port in use. Kill process or use different port.`;
            else if (/command not found/i.test(combined)) hints += `\n[!] Command not found. Install it.`;
            else if (/ENOENT|no such file/i.test(combined)) hints += `\n[!] File not found. Check path.`;
            else if (/module not found/i.test(combined)) hints += `\n[!] Missing module. Run npm/pip install.`;
            else hints += `\n[!] Failed. ${r.hint || 'Check error above.'}`;
            break;

          case "timeout":
            out += `[TIMEOUT ${r.durationMs}ms]`;
            if (r.stdout.trim()) out += `\n${r.stdout.slice(-1500).trim()}`;
            hints =
              `\n[!] Timed out — do NOT repeat the same command in the next turn unless you verified workspace state ` +
              `(list_files / read_file / lockfile). Re-running blindly wastes tokens. ${r.hint ? `\n${r.hint}` : ""}`;
            break;
        }

        // ENOSPC hint
        if (/\bENOSPC\b|inotify/i.test(r.stderr)) {
          hints += `\n[!] ENOSPC: file-watcher limit. Raise fs.inotify.max_user_watches.`;
        }

        out += hints;
        
        // Determine success: completed with exit 0, or background mode (server started)
        const ok = r.mode === "completed" ? r.exitCode === 0 : r.mode === "background";
        return { ok, summary: out, data: r };
      }
      case "write_patch": {
        const raw = String(input.patches ?? input.patch ?? "");
        const path = typeof input.path === "string" ? input.path : undefined;
        if (!raw) return { ok: false, summary: "[WP_INPUT] write_patch: missing 'patches'." };
        const pathTrim = path?.trim();
        const formatErr = validateWritePatchPayload(raw, pathTrim);
        if (formatErr) return { ok: false, summary: `[${formatErr.code}] ${formatErr.message}` };
        const results: PatchResult[] = await applyPatches(raw, path);
        if (results.length === 0) {
          return {
            ok: false,
            summary:
              "[WP_PARSE_NONE] No SEARCH/REPLACE blocks could be parsed. Use FILE: path then SEARCH/REPLACE/END, or pass path + body starting with SEARCH.",
          };
        }

        const ok = results.every((r) => r.applied);
        const lines = results.map((r) => {
          if (r.applied) return `OK ${r.path}`;
          const code = patchApplyErrorCode(r.error);
          const oneLine = (r.error ?? "unknown").replace(/\s+/g, " ").trim();
          return `FAIL [${code}] ${r.path} — ${oneLine}`;
        });
        let validation: ValidationReport = { ran: [], ok: true };
        if (ok) validation = await autoValidate();
        const valSummary = ok ? `\n${summarizeValidation(validation)}` : "";
        return {
          ok: ok && validation.ok,
          summary: `write_patch results:\n${lines.join("\n")}${valSummary}`,
          data: results,
          diffs: results.filter((r) => r.applied).map((r) => r.diff),
        };
      }
      case "create_file": {
        const p = String(input.path || "");
        const content = String(input.content ?? "");
        if (!p) return { ok: false, summary: "create_file: missing 'path'" };
        await writeFile(p, content);
        return { ok: true, summary: `Created ${p} (${content.length} chars)` };
      }
      case "glob": {
        const pattern = String(input.pattern || "");
        if (!pattern) return { ok: false, summary: "glob: missing 'pattern'" };
        const matches = await globFiles(pattern);
        return {
          ok: true,
          summary: `glob "${pattern}" → ${matches.length} matches:\n${matches.slice(0, 200).join("\n")}`,
          data: matches,
        };
      }
      default:
        return { ok: false, summary: `Unknown tool: ${type}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: `${type} error: ${msg}` };
  }
}
