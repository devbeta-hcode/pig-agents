import {
  listFiles,
  readFile,
  writeFile,
  buildCodebaseMapSummary,
  globFiles,
  sliceFileLines,
  deleteAgentPath,
  normalizeAgentDeletePath,
} from "../tools/file.js";
import { searchCodeFast } from "../tools/ripgrepSearch.js";
import {
  buildSymbolIndex,
  findSymbols,
  findSymbolReferences,
  formatSymbolHits,
} from "../index/symbolIndex.js";
import { semanticSearch } from "../index/embeddingIndex.js";
import { runSmartCommand } from "../tools/smartCommand.js";
import {
  applyPatches,
  parsePatch,
  patchApplyErrorCode,
  validateWritePatchPayload,
  makeUnifiedDiff,
  type PatchResult,
} from "../tools/patch.js";
import { recordRunSnapshotFile } from "../utils/runSnapshots.js";
import { autoValidate, summarizeValidation, type ValidationReport } from "../validation/validator.js";
import { startAgentCommand } from "./commandLog.js";
import { getWorkspace } from "../utils/workspace.js";
import {
  decide as policyDecide,
  trust as policyTrust,
  loadPolicy as loadAgentPolicy,
  deletePathPolicyKey,
  matchedDeletePathPolicy,
} from "../utils/policy.js";
import { newAskId, waitForApproval, type ApprovalAnswer } from "../utils/approvals.js";
import { webFetch, webSearch } from "../tools/web.js";
import { browserSession } from "../browser/session.js";
import { externalBrowserLaunchHint } from "../tools/browserGuard.js";
import { preferAgentToolOverShellHint } from "../tools/commandProbeGuard.js";
import { rejectDestructiveShellCommand } from "../tools/destructiveShellGuard.js";

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
  /** Chat session — per-file snapshots stored under ~/.pig-agents/chats/.../snapshots/<chatId>/ */
  chatId?: string;
  /** ReAct iteration (for command_chunk SSE tagging). */
  iteration?: number;
  emit?: (event: { type: string; [k: string]: unknown }) => void;
  /** Per-run read_file cache to prevent duplicate file reads wasting tokens. */
  readCache?: Map<string, string>;
  /** Paths successfully written this run — blocks duplicate create_file. */
  writtenPaths?: Set<string>;
}

async function captureRunSnapshotBeforeWrite(
  ctx: ToolContext,
  relPath: string,
): Promise<{ before: string; createdFromAbsent: boolean }> {
  let before = "";
  let createdFromAbsent = false;
  try {
    before = await readFile(relPath);
  } catch {
    createdFromAbsent = true;
  }
  if (ctx.chatId && ctx.runId) {
    await recordRunSnapshotFile(ctx.chatId, ctx.runId, relPath, before, { createdFromAbsent });
  }
  return { before, createdFromAbsent };
}

/**
 * Strip stray write_patch sentinel markers (`END`, `EOF`, `END_OF_FILE`,
 * `END_PATCH`, `END_FILE`) that the model sometimes appends to a
 * `create_file` content payload after confusing it with the `write_patch`
 * SEARCH/REPLACE/END syntax. Without this guard the marker ends up at the
 * tail of `main.jsx` and the browser throws `Uncaught ReferenceError: END
 * is not defined`. Only strips the marker when it sits **alone** on the
 * very last line so legitimate code containing the word "END" mid-line is
 * left intact.
 */
function stripStrayPatchMarkers(content: string): string {
  if (!content) return content;
  // Up to two trailing sentinel-only lines (e.g. `END\n\n` or `END\nEOF\n`).
  return content.replace(/(?:\r?\n[ \t]*(?:END|EOF|END_OF_FILE|END_PATCH|END_FILE)[ \t]*){1,2}\s*$/i, "");
}

/**
 * Approval bridge for the `web_fetch` / `web_search` tools.
 *
 * Mirrors the `run_command` flow: emits a `policy_ask` event the frontend
 * uses to render the modal, then awaits the user's POST to
 * `/agent/approvals/:askId`. The `kind` field lets the modal pick a
 * URL-friendly title and skip the shell-pattern UI. If `autoApproveWeb` is
 * on in the workspace policy, we skip straight to allow.
 *
 * Returns the (possibly user-edited) URL/query, or a deny reason.
 */
async function gateWebApproval(
  ctx: ToolContext,
  kind: "web_fetch" | "web_search" | "browser",
  initial: string,
): Promise<{ ok: true; value: string } | { ok: false; reason: string }> {
  const policy = await loadAgentPolicy().catch(() => null);
  if (policy?.autoApproveWeb) {
    ctx.emit?.({ type: "policy_decision", decision: "allow_auto", cmd: initial, kind });
    return { ok: true, value: initial };
  }

  const askId = newAskId();
  ctx.emit?.({ type: "policy_ask", askId, cmd: initial, suggestedAllow: initial, kind });
  let ans: ApprovalAnswer;
  try {
    ans = await waitForApproval(askId, initial, { runId: ctx.runId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.emit?.({ type: "policy_decision", decision: "deny", cmd: initial, kind, reason: msg });
    return { ok: false, reason: `${kind} not approved: ${msg}` };
  }
  if (ans.decision === "deny") {
    ctx.emit?.({ type: "policy_decision", decision: "deny", cmd: initial, kind, reason: "user denied" });
    return { ok: false, reason: `${kind} denied by user.` };
  }
  const value = (typeof ans.editedCmd === "string" && ans.editedCmd.trim()) ? ans.editedCmd.trim() : initial;
  ctx.emit?.({
    type: "policy_decision",
    decision: ans.decision,
    cmd: value,
    kind,
    originalCmd: value === initial ? undefined : initial,
  });
  return { ok: true, value };
}

/**
 * Approval gate for `delete_path` — modal unless autoApproveDelete or path is trusted.
 */
async function gateDeleteApproval(
  ctx: ToolContext,
  relPath: string,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const policy = await loadAgentPolicy().catch(() => null);
  const suggested = deletePathPolicyKey(relPath);

  if (policy?.autoApproveDelete) {
    ctx.emit?.({ type: "policy_decision", decision: "allow_auto", cmd: relPath, kind: "delete_path" });
    return { ok: true, path: relPath };
  }

  if (policy && matchedDeletePathPolicy(relPath, policy)) {
    ctx.emit?.({
      type: "policy_decision",
      decision: "allow_auto",
      cmd: relPath,
      kind: "delete_path",
      matched: suggested,
    });
    return { ok: true, path: relPath };
  }

  const askId = newAskId();
  ctx.emit?.({
    type: "policy_ask",
    askId,
    cmd: relPath,
    suggestedAllow: suggested,
    kind: "delete_path",
  });
  let ans: ApprovalAnswer;
  try {
    ans = await waitForApproval(askId, relPath, { runId: ctx.runId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.emit?.({ type: "policy_decision", decision: "deny", cmd: relPath, kind: "delete_path", reason: msg });
    return { ok: false, reason: `delete_path not approved: ${msg}` };
  }
  if (ans.decision === "deny") {
    ctx.emit?.({ type: "policy_decision", decision: "deny", cmd: relPath, kind: "delete_path", reason: "user denied" });
    return { ok: false, reason: "delete_path denied by user." };
  }

  const edited = (typeof ans.editedCmd === "string" && ans.editedCmd.trim()) ? ans.editedCmd.trim() : relPath;
  let normalized: string;
  try {
    normalized = normalizeAgentDeletePath(edited);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.emit?.({ type: "policy_decision", decision: "deny", cmd: edited, kind: "delete_path", reason: msg });
    return { ok: false, reason: msg };
  }

  if (ans.decision === "allow_always") {
    try {
      await policyTrust(suggested);
    } catch { /* best-effort */ }
  }

  ctx.emit?.({
    type: "policy_decision",
    decision: ans.decision,
    cmd: normalized,
    kind: "delete_path",
    originalCmd: normalized === relPath ? undefined : relPath,
  });
  return { ok: true, path: normalized };
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
        const startLine = input.start_line != null ? Number(input.start_line) : undefined;
        const endLine = input.end_line != null ? Number(input.end_line) : undefined;
        const cacheKey =
          startLine != null || endLine != null
            ? `${p}:${startLine ?? ""}:${endLine ?? ""}`
            : p;
        if (ctx.readCache?.has(cacheKey)) {
          const cached = ctx.readCache.get(cacheKey)!;
          return { ok: true, summary: `${p} (cached):\n${cached}`, data: cached };
        }
        let content: string;
        try {
          content = await readFile(p);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // ENOENT: try to suggest the right path so the agent stops looping
          // on the same wrong filename. Match by basename across the tree.
          if (/ENOENT/i.test(msg)) {
            const base = p.split("/").pop() || p;
            let suggestions: string[] = [];
            try {
              const matches = await globFiles(`**/${base}`, 20);
              suggestions = matches.slice(0, 5);
              // If no exact basename match, try case-insensitive partial match
              if (suggestions.length === 0 && base.includes(".")) {
                const stem = base.split(".").slice(0, -1).join(".");
                const ext = base.split(".").pop();
                if (stem.length >= 3) {
                  const fuzzy = await globFiles(`**/*${stem}*.${ext}`, 20);
                  suggestions = fuzzy.slice(0, 5);
                }
              }
            } catch { /* best-effort */ }
            const hint = suggestions.length > 0
              ? `\n[!] File not found. Did you mean one of:\n${suggestions.map(s => `  - ${s}`).join("\n")}\nUse list_files <dir> to confirm before retrying.`
              : `\n[!] File not found and no similarly-named file exists. Use list_files or search_code to discover the correct path. Do NOT retry with the same path.`;
            return { ok: false, summary: `read_file error: ${msg}${hint}` };
          }
          return { ok: false, summary: `read_file error: ${msg}` };
        }
        const sliced = sliceFileLines(
          content,
          Number.isFinite(startLine) ? startLine : undefined,
          Number.isFinite(endLine) ? endLine : undefined,
        );
        const body = sliced.text;
        const maxLen = 6000;
        const truncated =
          body.length > maxLen
            ? body.slice(0, maxLen) + `\n…[+${Math.floor((body.length - maxLen) / 1000)}k chars]`
            : body;
        const header = `${p} lines ${sliced.from}-${sliced.to} of ${sliced.totalLines}`;
        const summary = `${header}:\n${truncated}`;
        ctx.readCache?.set(cacheKey, summary);
        return { ok: true, summary, data: body };
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
        const hits = await searchCodeFast(q, 24);
        const lines = hits.slice(0, 16).map((h) => `${h.file}:${h.line}: ${h.text.slice(0, 72)}`);
        const tail = hits.length > 16 ? `\n…+${hits.length - 16} more` : "";
        return {
          ok: true,
          summary: `"${q}" ${hits.length} hit(s):\n${lines.join("\n")}${tail}`,
          data: hits,
        };
      }
      case "find_symbol": {
        const name = String(input.name || "").trim();
        if (!name) return { ok: false, summary: "find_symbol: missing 'name'" };
        await buildSymbolIndex(false);
        const hits = findSymbols(name, 20);
        return {
          ok: true,
          summary: `symbol "${name}" (${hits.length}):\n${formatSymbolHits(hits)}`,
          data: hits,
        };
      }
      case "find_references": {
        const name = String(input.name || "").trim();
        if (!name) return { ok: false, summary: "find_references: missing 'name'" };
        const hits = await findSymbolReferences(name, 24);
        const lines = hits.slice(0, 18).map((h) => `${h.file}:${h.line}: ${h.text.slice(0, 72)}`);
        const tail = hits.length > 18 ? `\n…+${hits.length - 18} more` : "";
        return {
          ok: true,
          summary: `refs "${name}" (${hits.length}):\n${lines.join("\n")}${tail}`,
          data: hits,
        };
      }
      case "semantic_search": {
        const q = String(input.query || "").trim();
        if (!q) return { ok: false, summary: "semantic_search: missing 'query'" };
        if (process.env.LLM_DISABLE_SEMANTIC_INDEX === "1" || process.env.LLM_DISABLE_SEMANTIC_INDEX === "true") {
          return { ok: false, summary: "semantic_search disabled (LLM_DISABLE_SEMANTIC_INDEX=1). Use find_symbol or search_code." };
        }
        try {
          const topK = Math.min(16, Math.max(1, Number(input.top_k ?? 8)));
          const hits = await semanticSearch(q, topK);
          if (hits.length === 0) {
            return { ok: true, summary: `semantic_search "${q}": no matches (index empty or low similarity)` };
          }
          const lines = hits.map(
            (h) => `${h.path}:${h.line} (${h.score.toFixed(2)}) ${h.excerpt.split("\n").slice(0, 4).join(" ").slice(0, 120)}`,
          );
          return {
            ok: true,
            summary: `semantic "${q}" (${hits.length}) — read_file with start_line:\n${lines.join("\n")}`,
            data: hits,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, summary: `semantic_search failed: ${msg.slice(0, 500)}` };
        }
      }
      case "codebase_map": {
        const maxDepth = Math.min(10, Math.max(1, Number(input.max_depth ?? input.depth ?? 5)));
        const summary = await buildCodebaseMapSummary({ maxDepth });
        return { ok: true, summary: summary.slice(0, 10000), data: { maxDepth } };
      }
      case "run_command": {
        const requestedCmd = String(input.cmd || "");
        if (!requestedCmd) return { ok: false, summary: "run_command: missing 'cmd'" };

        const destructive = rejectDestructiveShellCommand(requestedCmd);
        if (destructive) {
          ctx.emit?.({
            type: "policy_decision",
            decision: "deny",
            cmd: requestedCmd,
            reason: destructive,
          });
          return { ok: false, summary: `run_command BLOCKED: ${destructive}` };
        }

        const browserHack = externalBrowserLaunchHint(requestedCmd);
        if (browserHack) {
          return { ok: false, summary: `run_command rejected: ${browserHack}` };
        }

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

        const destructiveFinal = rejectDestructiveShellCommand(cmd);
        if (destructiveFinal) {
          ctx.emit?.({
            type: "policy_decision",
            decision: "deny",
            cmd,
            reason: destructiveFinal,
          });
          return { ok: false, summary: `run_command BLOCKED: ${destructiveFinal}` };
        }

        const startedAt = Date.now();
        const iter = ctx.iteration ?? 0;
        // Open a live terminal slot before the command starts so the UI can
        // display streaming output in the Terminals panel in real time.
        const cmdHandle = startAgentCommand(cmd, getWorkspace());
        let r;
        try {
          r = await runSmartCommand(cmd, {
            cwd: getWorkspace(),
            forceLongRunning: input.background === true,
            onChildSpawn: (pid) => cmdHandle.setPid(pid),
            onStreamChunk: (stream, text) => {
              if (!text) return;
              const streamName = stream === "out" ? "stdout" : "stderr";
              ctx.emit?.({ type: "command_chunk", iteration: iter, stream: streamName, text });
              cmdHandle.appendChunk(streamName, text);
            },
          });
        } finally {
          /* stream flushed per chunk in onStreamChunk */
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
          pid: r.pid,
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

        const toolPreferHint = preferAgentToolOverShellHint(cmd);
        if (toolPreferHint) {
          ctx.emit?.({
            type: "log",
            level: "info",
            message: `run_command tip: ${toolPreferHint}`,
          });
          out += `\n[i] ${toolPreferHint}`;
        }

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
        if (ctx.chatId && ctx.runId) {
          const blocks = parsePatch(raw, pathTrim);
          for (const block of blocks) {
            await captureRunSnapshotBeforeWrite(ctx, block.path);
          }
        }
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
        // Invalidate read cache for patched files so subsequent reads get fresh content
        results.filter(r => r.applied).forEach(r => ctx.readCache?.delete(r.path));
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
      case "delete_path":
      case "delete_file": {
        const raw = String(input.path ?? input.file ?? "");
        if (!raw.trim()) return { ok: false, summary: "delete_path: missing 'path'" };
        try {
          normalizeAgentDeletePath(raw);
        } catch (err) {
          return { ok: false, summary: (err as Error).message };
        }
        const gate = await gateDeleteApproval(ctx, raw);
        if (!gate.ok) return { ok: false, summary: gate.reason };
        try {
          const { path: deleted, kind } = await deleteAgentPath(gate.path);
          return {
            ok: true,
            summary: `Deleted ${kind} ${deleted} (workspace-relative; user-approved delete_path).`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, summary: msg };
        }
      }
      case "create_file": {
        const p = String(input.path || "");
        const content = stripStrayPatchMarkers(String(input.content ?? ""));
        if (!p) return { ok: false, summary: "create_file: missing 'path'" };
        if (ctx.writtenPaths?.has(p)) {
          return {
            ok: true,
            summary: `Skipped duplicate create_file for ${p} (already written this run).`,
            diffs: [],
          };
        }
        // Capture pre-state so DiffViewer can render a row + revert can restore it.
        // Treat unreadable / non-existent as an empty file (mark the patch as a
        // create-from-absent so revert will delete the path instead of leaving
        // an empty stub on disk).
        const { before, createdFromAbsent } = await captureRunSnapshotBeforeWrite(ctx, p);
        await writeFile(p, content);
        ctx.writtenPaths?.add(p);
        ctx.readCache?.delete(p);
        const diff = makeUnifiedDiff(p, before, content, { markCreatedFromAbsent: createdFromAbsent });
        const diffs = diff ? [diff] : [];
        return { ok: true, summary: `Created ${p} (${content.length} chars)`, diffs };
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
      case "web_fetch": {
        const rawUrl = String(input.url || "").trim();
        if (!rawUrl) return { ok: false, summary: "web_fetch: missing 'url'" };

        // Approval gate: per-call modal unless `autoApproveWeb` is on.
        const approved = await gateWebApproval(ctx, "web_fetch", rawUrl);
        if (!approved.ok) return { ok: false, summary: approved.reason };
        const url = approved.value;

        const result = await webFetch(url, {
          maxChars: typeof input.maxChars === "number" ? input.maxChars : undefined,
          timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
        });
        if (!result.ok && !result.text) {
          return { ok: false, summary: `web_fetch failed: ${result.error ?? "unknown error"} (url=${url})` };
        }
        const headerLines = [
          `URL: ${result.finalUrl ?? url}`,
          result.status !== undefined ? `Status: ${result.status}` : null,
          result.contentType ? `Content-Type: ${result.contentType}` : null,
          result.truncated ? "Truncated: yes" : null,
        ].filter(Boolean).join("\n");
        const body = result.text ?? "";
        return {
          ok: result.ok,
          summary: `web_fetch ${url}\n${headerLines}\n\n${body}`,
          data: result,
        };
      }
      case "web_search": {
        const query = String(input.query || "").trim();
        if (!query) return { ok: false, summary: "web_search: missing 'query'" };

        const approved = await gateWebApproval(ctx, "web_search", query);
        if (!approved.ok) return { ok: false, summary: approved.reason };
        const q = approved.value;

        const result = await webSearch(q, {
          maxResults: typeof input.maxResults === "number" ? input.maxResults : undefined,
          timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
        });
        if (!result.ok || result.hits.length === 0) {
          return { ok: false, summary: `web_search failed: ${result.error ?? "no results"} (query=${q})` };
        }
        const lines = result.hits.map((h, i) =>
          `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`,
        );
        return {
          ok: true,
          summary: `web_search "${q}" → ${result.hits.length} result(s)\n${lines.join("\n\n")}`,
          data: result,
        };
      }
      case "browser_show": {
        await browserSession.ensureStarted();
        if (!browserSession.hasPageLoaded()) {
          try {
            await browserSession.navigate("about:blank");
          } catch {
            /* panel visible is enough */
          }
        }
        const url = browserSession.currentUrl();
        return {
          ok: true,
          summary:
            "Browser panel opened (embedded webview in the app — not Chrome/Edge). " +
            `Current URL: ${url || "about:blank"}. ` +
            'Use browser_navigate with {"url":"https://..."} to load a site.',
          data: { url, panelOpen: true },
        };
      }
      case "browser_navigate": {
        const rawUrl = String(input.url ?? "").trim();
        await browserSession.ensureStarted();
        if (!rawUrl || rawUrl === "about:blank") {
          if (!browserSession.hasPageLoaded()) {
            try {
              await browserSession.navigate("about:blank");
            } catch {
              /* noop */
            }
          }
          const url = browserSession.currentUrl();
          return {
            ok: true,
            summary:
              "Browser panel opened (embedded webview). " +
              `URL: ${url || "about:blank"}. Load a page with browser_navigate + a https URL.`,
            data: { url, panelOpen: true },
          };
        }
        const url = rawUrl;
        const approved = await gateWebApproval(ctx, "browser", url);
        if (!approved.ok) return { ok: false, summary: approved.reason };
        const targetUrl = approved.value.trim() || url;
        await browserSession.navigate(targetUrl);
        const finalUrl = browserSession.currentUrl();
        const title = await browserSession.getTitle();
        return {
          ok: true,
          summary: `browser_navigate → ${finalUrl}${title ? ` ("${title}")` : ""}`,
          data: { url: finalUrl, title },
        };
      }
      case "browser_get_text": {
        const sel = typeof input.selector === "string" && input.selector.trim() ? String(input.selector) : undefined;
        const cap = typeof input.maxChars === "number" ? Math.max(500, Math.min(50_000, input.maxChars)) : 12_000;
        await browserSession.ensureStarted();
        if (!browserSession.hasPageLoaded()) {
          return { ok: false, summary: "browser_get_text: no page loaded. Call browser_navigate first." };
        }
        const url = browserSession.currentUrl();
        const approved = await gateWebApproval(ctx, "browser", `read text from ${url}${sel ? ` (selector=${sel})` : ""}`);
        if (!approved.ok) return { ok: false, summary: approved.reason };
        const text = await browserSession.getPageText(sel, cap);
        return {
          ok: true,
          summary: `browser_get_text ${url}${sel ? ` (${sel})` : ""}\n\n${text || "(empty)"}`,
          data: { url, selector: sel, length: text.length },
        };
      }
      case "browser_get_html": {
        const sel = typeof input.selector === "string" && input.selector.trim() ? String(input.selector) : undefined;
        const cap = typeof input.maxChars === "number" ? Math.max(500, Math.min(60_000, input.maxChars)) : 20_000;
        await browserSession.ensureStarted();
        if (!browserSession.hasPageLoaded()) {
          return { ok: false, summary: "browser_get_html: no page loaded. Call browser_navigate first." };
        }
        const url = browserSession.currentUrl();
        const approved = await gateWebApproval(ctx, "browser", `read HTML from ${url}${sel ? ` (selector=${sel})` : ""}`);
        if (!approved.ok) return { ok: false, summary: approved.reason };
        const html = await browserSession.getPageHTML(sel, cap);
        return {
          ok: true,
          summary: `browser_get_html ${url}${sel ? ` (${sel})` : ""}\n\n${html || "(empty)"}`,
          data: { url, selector: sel, length: html.length },
        };
      }
      case "browser_click": {
        const sel = String(input.selector || "").trim();
        if (!sel) return { ok: false, summary: "browser_click: missing 'selector'" };
        await browserSession.ensureStarted();
        if (!browserSession.hasPageLoaded()) {
          return { ok: false, summary: "browser_click: no page loaded. Call browser_navigate first." };
        }
        const url = browserSession.currentUrl();
        const approved = await gateWebApproval(ctx, "browser", `click "${sel}" on ${url}`);
        if (!approved.ok) return { ok: false, summary: approved.reason };
        await browserSession.clickSelector(sel, typeof input.timeoutMs === "number" ? input.timeoutMs : undefined);
        return { ok: true, summary: `browser_click → ${sel}`, data: { selector: sel, url } };
      }
      case "browser_fill": {
        const sel = String(input.selector || "").trim();
        const value = String(input.value ?? "");
        if (!sel) return { ok: false, summary: "browser_fill: missing 'selector'" };
        await browserSession.ensureStarted();
        if (!browserSession.hasPageLoaded()) {
          return { ok: false, summary: "browser_fill: no page loaded. Call browser_navigate first." };
        }
        const url = browserSession.currentUrl();
        const preview = value.length > 60 ? `${value.slice(0, 60)}…` : value;
        const approved = await gateWebApproval(ctx, "browser", `fill ${sel} = "${preview}" on ${url}`);
        if (!approved.ok) return { ok: false, summary: approved.reason };
        await browserSession.fillSelector(sel, value, typeof input.timeoutMs === "number" ? input.timeoutMs : undefined);
        return { ok: true, summary: `browser_fill → ${sel}`, data: { selector: sel, length: value.length } };
      }
      case "browser_wait_for": {
        const sel = String(input.selector || "").trim();
        if (!sel) return { ok: false, summary: "browser_wait_for: missing 'selector'" };
        await browserSession.ensureStarted();
        if (!browserSession.hasPageLoaded()) {
          return { ok: false, summary: "browser_wait_for: no page loaded. Call browser_navigate first." };
        }
        const state = (input.state === "attached" || input.state === "hidden") ? input.state : "visible";
        const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : 10_000;
        try {
          await browserSession.waitForSelector(sel, state, timeoutMs);
          return { ok: true, summary: `browser_wait_for → ${sel} (${state})` };
        } catch (err) {
          return { ok: false, summary: `browser_wait_for timeout: ${(err as Error).message}` };
        }
      }
      case "browser_eval": {
        const js = String(input.js || "").trim();
        if (!js) return { ok: false, summary: "browser_eval: missing 'js'" };
        await browserSession.ensureStarted();
        if (!browserSession.hasPageLoaded()) {
          return { ok: false, summary: "browser_eval: no page loaded. Call browser_navigate first." };
        }
        const url = browserSession.currentUrl();
        const preview = js.length > 80 ? `${js.slice(0, 80)}…` : js;
        const approved = await gateWebApproval(ctx, "browser", `eval JS on ${url}: ${preview}`);
        if (!approved.ok) return { ok: false, summary: approved.reason };
        try {
          const result = await browserSession.evalScript(js);
          const out = (() => {
            try { return JSON.stringify(result, null, 2); } catch { return String(result); }
          })();
          const capped = out.length > 8_000 ? `${out.slice(0, 8_000)}\n…[truncated]` : out;
          return { ok: true, summary: `browser_eval →\n${capped}`, data: { result } };
        } catch (err) {
          return { ok: false, summary: `browser_eval error: ${(err as Error).message}` };
        }
      }
      default:
        return { ok: false, summary: `Unknown tool: ${type}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: `${type} error: ${msg}` };
  }
}
