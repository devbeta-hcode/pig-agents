/**
 * Multi sub-agent orchestrator (Phase 1).
 *
 * Runs N research/analysis sub-agents concurrently against the SAME workspace,
 * bounded by a small worker pool, and aggregates their findings into a single
 * summary the parent agent can synthesise from.
 *
 * v1 contract (see docs/parallel-subagents-design.md):
 *  - Sub-agents are READ-ONLY (see {@link SUBAGENT_READONLY_TOOLS}); the parent
 *    remains the only writer. This sidesteps diff races, approval-modal storms,
 *    and the single embedded-browser contention.
 *  - No nested fan-out: sub-agents are not given the spawn tool.
 *  - Aborting the parent's signal aborts every in-flight sub-agent.
 */

import { runAgent, type AgentEvent } from "./runner.js";
import { runWithWorkspace } from "../utils/workspace.js";
import { cancelAllForRun } from "../utils/approvals.js";

/** Tools a read-only sub-agent may call. Mirrors the research/analysis subset. */
export const SUBAGENT_READONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_files",
  "search_code",
  "find_symbol",
  "find_references",
  "semantic_search",
  "glob",
  "codebase_map",
]);

/** Role brief appended to each sub-agent's system prompt. */
export const SUBAGENT_SYSTEM_HINT =
  `You are a READ-ONLY research sub-agent in a parallel fan-out. Investigate ONLY your assigned subtask. ` +
  `You can read_file, list_files, search_code, find_symbol, find_references, semantic_search, glob, codebase_map — ` +
  `you CANNOT write files, run commands, browse, or spawn further sub-agents (those tools will be rejected). ` +
  `Do not attempt them. When done, emit FINAL with a concise, concrete findings report (file:line references, ` +
  `specific observations) that the parent agent can act on. Keep it focused and factual — no code dumps.`;

export interface SubAgentSpec {
  /** Stable, short id used to namespace events and label results (e.g. "1"). */
  id: string;
  /** The research/analysis instruction for this sub-agent. */
  task: string;
}

export interface SubAgentResult {
  id: string;
  task: string;
  ok: boolean;
  /** FINAL text when ok; empty when failed. */
  result: string;
  iterations: number;
  error?: string;
}

export type SubAgentEvent =
  | { type: "subagent_start"; id: string; task: string }
  | { type: "subagent_event"; id: string; event: AgentEvent }
  | { type: "subagent_done"; id: string; ok: boolean; result: string };

export interface RunSubAgentsContext {
  /** Parent run id — child run ids are derived as `${parentRunId}:sub:${id}`. */
  parentRunId: string;
  /** Workspace every sub-agent runs against (shared; AsyncLocalStorage-scoped). */
  workspace: string;
  /** Parent abort signal — forwarded to every child so one stop cancels all. */
  signal?: AbortSignal;
  /** Max concurrent sub-agents (defaults to SUBAGENT_CONCURRENCY env / 4). */
  concurrency?: number;
  /** Per-sub-agent iteration ceiling (default 12). */
  maxIterationsPerSub?: number;
  /** Sink for namespaced progress events (start / per-event / done). */
  emit?: (e: SubAgentEvent) => void;
}

/** Default concurrency from env, clamped to [1, 8]. */
function readConcurrency(): number {
  const n = Number(process.env.SUBAGENT_CONCURRENCY || 4);
  return Math.max(1, Math.min(Number.isFinite(n) ? n : 4, 8));
}

/**
 * Run every spec through a read-only sub-agent, at most `concurrency` at a
 * time. Never rejects: a failing sub-agent becomes `{ ok:false, error }` so one
 * bad subtask cannot abort the batch. Results preserve input order.
 */
export async function runSubAgents(
  specs: SubAgentSpec[],
  ctx: RunSubAgentsContext,
): Promise<SubAgentResult[]> {
  const concurrency = Math.max(1, Math.min(ctx.concurrency ?? readConcurrency(), 8));
  const maxIterationsPerSub = Math.max(1, ctx.maxIterationsPerSub ?? 12);
  const results: SubAgentResult[] = new Array(specs.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= specs.length) return;
      if (ctx.signal?.aborted) {
        results[i] = { id: specs[i].id, task: specs[i].task, ok: false, result: "", iterations: 0, error: "aborted" };
        continue;
      }
      const spec = specs[i];
      const subRunId = `${ctx.parentRunId}:sub:${spec.id}`;
      ctx.emit?.({ type: "subagent_start", id: spec.id, task: spec.task });
      try {
        const r = await runWithWorkspace(ctx.workspace, () =>
          runAgent({
            task: spec.task,
            mode: "agent",
            runId: subRunId,
            signal: ctx.signal,
            allowedTools: new Set(SUBAGENT_READONLY_TOOLS),
            maxIterations: maxIterationsPerSub,
            skipCheckpoint: true,
            systemHint: SUBAGENT_SYSTEM_HINT,
            onEvent: (event) => ctx.emit?.({ type: "subagent_event", id: spec.id, event }),
          }),
        );
        results[i] = { id: spec.id, task: spec.task, ok: true, result: r.result, iterations: r.iterations };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Drop any approval this child was parked on (belt-and-suspenders; the
        // signal already rejects them when the parent aborts).
        try { cancelAllForRun(subRunId, "subagent failed"); } catch { /* noop */ }
        results[i] = { id: spec.id, task: spec.task, ok: false, result: "", iterations: 0, error: msg };
      }
      ctx.emit?.({
        type: "subagent_done",
        id: spec.id,
        ok: results[i].ok,
        result: results[i].ok ? results[i].result : (results[i].error ?? "failed"),
      });
    }
  };

  const poolSize = Math.min(concurrency, specs.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}

/**
 * Fold sub-agent results into one labelled block for the parent's next
 * OBSERVATION. Failed sub-agents are surfaced (not hidden) so the parent can
 * decide whether to retry or proceed.
 */
export function aggregateSubAgentResults(results: SubAgentResult[]): string {
  if (results.length === 0) return "No sub-agents ran.";
  return results
    .map((r) =>
      r.ok
        ? `[sub:${r.id} ok · ${r.iterations} iter] ${r.task}\n${r.result.trim() || "(no findings reported)"}`
        : `[sub:${r.id} FAIL] ${r.task}\n${r.error ?? "failed"}`,
    )
    .join("\n\n---\n\n");
}
