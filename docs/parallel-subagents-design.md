# Design — Multi Sub-Agent Parallel Execution

> Status: **Proposal (for review)** · Author: agent track · Target: `@pig-agents/core` + renderer
> Goal: let one task fan out into N concurrent sub-agents that run in parallel and have their
> results aggregated — a modern orchestrator/fan-out, not just per-tool parallelism.

---

## 1. What already exists (so we don't rebuild it)

| Capability | Where | Verdict |
|---|---|---|
| Concurrent background runs, each with its own `AbortController` + buffered events | `agent/sessionManager.ts` (`sessions` Map) | ✅ Reuse as the sub-agent runtime |
| Per-run workspace isolation via `AsyncLocalStorage` | `utils/workspace.ts` `runWithWorkspace` | ✅ Parallel-safe already |
| Per-run tool context (`readCache`, `writtenPaths`, `runId`) | `agent/executor.ts` `ToolContext` | ✅ Already isolated per run |
| Parallel **tool** dispatch within one iteration | `agent/runner.ts` `earlyScheduled` | ✅ Orthogonal; keep |
| Approvals keyed by `runId` | `utils/approvals.ts` | ✅ Parallel-safe; UX needs work |

**Implication:** we are *not* writing a new concurrency engine. We add an **orchestration layer**
on top of `runAgent` + the session manager.

## 2. Blockers / shared state to handle

| Shared singleton | Risk under parallel sub-agents | Mitigation |
|---|---|---|
| `browserSession` (one WebContentsView) | Two sub-agents calling `browser_*` corrupt each other's page | **Sub-agents get NO browser tools** in v1 (parent only). Later: a browser mutex / pooled views. |
| Approval modals (`run_command`, `delete_path`, `web_*`) | N concurrent modals = UX chaos | v1 sub-agents run **read/analyze-only** (no approval-gated tools). Writes/commands stay on the parent. |
| `commandLog` ring, embedding `mem`, symbol cache | Shared but workspace-scoped; reads safe (embedding now single-flight) | None needed for shared workspace. |
| Diff sidebar / checkpoints | Concurrent writers → interleaved diffs | v1: sub-agents don't write. Parent applies the synthesized patch. |

The cleanest **v1 contract**: sub-agents are **read-only research/analysis workers**
(`read_file`, `list_files`, `search_code`, `find_symbol`, `find_references`, `semantic_search`,
`glob`, `codebase_map`). The parent agent stays the only writer. This sidesteps every blocker
above while delivering the headline feature (parallel decomposition + synthesis).

## 3. Architecture

```text
        ┌────────────────────────── Parent agent run (existing runAgent) ──────────────────────────┐
        │  ReAct loop, full tool set (read/write/command/browser)                                   │
        │                                                                                           │
        │   THOUGHT … <tool name="spawn_subagents">                                                 │
        │     <subtasks>                                                                            │
        │       <task>Audit auth flow for bugs</task>                                               │
        │       <task>Map all IPC channels and their handlers</task>                                │
        │       <task>List every place getWorkspace() is mutated</task>                             │
        │     </subtasks>                                                                            │
        │   </tool>                                                                                  │
        └───────────────┬───────────────────────────────────────────────────────────────────────┘
                        │  executor dispatches the orchestrator
                        ▼
        ┌────────────── orchestrator (new: agent/orchestrator.ts) ──────────────┐
        │  Promise.all over subtasks, bounded by SUBAGENT_CONCURRENCY (default 4)│
        │  each subtask → runAgent({ mode:"subagent", runId: `${parent}:sub:i`}) │
        │  wrapped in runWithWorkspace(sameWs, …); read-only tool whitelist      │
        └───────┬─────────────┬─────────────┬───────────────────────────────────┘
                ▼             ▼             ▼
            sub-agent 1   sub-agent 2   sub-agent 3   (concurrent, isolated ToolContext)
                │             │             │
                └──────┬──────┴─────────────┘  each emits namespaced events → UI
                       ▼
        orchestrator collects {subtaskId, result, ok} → returns ONE ToolOutcome
                       ▼
        parent's next OBSERVATION = aggregated sub-agent findings → parent synthesizes / writes
```

### 3.1 New module: `agent/orchestrator.ts`

```ts
export interface SubAgentSpec { id: string; task: string; }
export interface SubAgentResult { id: string; ok: boolean; result: string; iterations: number; }

export async function runSubAgents(
  specs: SubAgentSpec[],
  ctx: { parentRunId: string; workspace: string; signal?: AbortSignal;
         emit: (e: SubAgentEvent) => void; concurrency?: number; },
): Promise<SubAgentResult[]>
```

- Bounded concurrency via a small semaphore (default `SUBAGENT_CONCURRENCY=4`, cap 8).
- Each spec → `runWithWorkspace(workspace, () => runAgent({ task, mode:"subagent",
  runId: `${parentRunId}:sub:${id}`, signal, onEvent: namespacedEmit }))`.
- `Promise.allSettled` so one failing sub-agent doesn't abort the batch; failures become
  `{ ok:false, result: errorMessage }`.
- Parent `signal` is forwarded → aborting the parent aborts all children (and `cancelAllForRun`
  per child runId, which now also rejects parked approvals via the new AbortSignal wiring).

### 3.2 New tool: `spawn_subagents`

- Registered in `executor.ts` switch + advertised in the agent prompt (`llm/prompt*.ts`).
- Input: `{ subtasks: string[] }` (parsed from `<task>` children, like `write_patch` FILE blocks).
- Caps: max `MAX_SUBAGENTS_PER_CALL` (default 6) subtasks per call; over-cap is sliced + logged,
  mirroring `MAX_ACTIONS_PER_ITERATION`.
- Returns a single `ToolOutcome` whose `summary` is the aggregated, labelled findings:
  ```
  [sub:1 ok] Audit auth flow … → <result>
  [sub:2 ok] Map IPC channels … → <result>
  [sub:3 FAIL] … → <error>
  ```
- `mode:"subagent"` = new lightweight variant of agent mode: read-only tool whitelist, lower
  `MAX_ITERATIONS` (default 12), no `spawn_subagents` (no nested fan-out in v1 → no runaway trees).

### 3.3 New AgentMode + tool whitelist

- `runner.ts` `AgentMode = "ask" | "agent" | "subagent"`.
- `executor.ts` gains a `ctx.allowedTools?: Set<string>`; when set, any tool outside it returns
  `{ ok:false, summary:"tool X not available to sub-agents" }`. Sub-agents pass the read-only set.

### 3.4 UI / event streaming

- New `AgentEvent` variants: `{ type:"subagent_start", id, task }`,
  `{ type:"subagent_event", id, event }`, `{ type:"subagent_done", id, ok, result }`.
- Renderer: a collapsible "Parallel work (N agents)" card under the parent turn, each sub-agent a
  row with its own live status + final. Reuses existing activity/observation rendering.
- `register.ts` already relays whatever `runAgent` emits; no IPC-shape change beyond the new
  event variants in `shared/ipc-types.ts`.

## 4. Concurrency, limits, safety

- `SUBAGENT_CONCURRENCY` (env, default 4, hard cap 8) — semaphore in the orchestrator.
- `MAX_SUBAGENTS_PER_CALL` (default 6).
- Nested fan-out disabled in v1 (sub-agents can't call `spawn_subagents`).
- Token budget: each sub-agent counts against the same LLM provider; document that fan-out
  multiplies token cost ~N×. Surface an aggregate token estimate in the UI card.
- Abort: parent abort → forward signal → all children abort + approvals rejected (already wired).

## 5. Rollout phases

| Phase | Deliverable | Exit criteria | Status |
|---|---|---|---|
| **P1** | `orchestrator.ts` + `runSubAgents` (read-only sub-agents, bounded concurrency) | Unit-level: 3 subtasks run concurrently, aggregate returns; abort cancels all | ✅ **Done** — concurrency/ordering/abort smoke tests pass |
| **P2** | `spawn_subagents` tool + read-only whitelist + sub-agent role hint + prompt docs | Parent fan-out → synthesis works end-to-end on a real task | ✅ **Done** (build green; parsing/cap/nesting guards tested). End-to-end needs a live LLM. |
| **P3** | Renderer "Parallel work" card + new event variants | Live per-sub-agent status visible; F5 replay intact | ✅ **Done** (build green; `collectSubAgents` unit-tested). |
| **P4** (later) | Browser mutex / write-capable sub-agents with diff-merge + approval queue | Sub-agents can write without diff corruption | ⏳ Later — needs its own design (parallel-write diff-merge is the risky part) |

### P3 surface (renderer)

- `lib/agentActivity.ts`: `collectSubAgents(events)` folds `subagent_*` into ordered per-agent views (status running/done/failed, task, live label from latest nested action/thought, result); `hasSubAgents(events)`.
- `components/AgentTraceRows.tsx`: `SubAgentsCard` + `SubAgentRow` (collapsible findings, spinner/✓/✕ status).
- `components/Chat.tsx`: `processSessionEvent` appends `subagent_start|done`, filters `subagent_event` (drops nested token/stream/context_usage); `traceSteps` includes `subagent_start` and hides the raw `spawn_subagents` action/observation rows (the card replaces them); card rendered once at the first `subagent_start`, live-updating as nested events stream.
- `lib/api.ts`: `AgentEvent` union extended with the three `subagent_*` types.
- `executor.ts`: stamps the parent iteration onto emitted `subagent_*` events so the card lands at the right timeline position.
- `styles/chat.css`: `.subagents-card` / `.subagent-row` (live pulse + spinner animations).

### Implemented surface (P1+P2)

- `agent/orchestrator.ts`: `runSubAgents(specs, ctx)`, `aggregateSubAgentResults`, `SUBAGENT_READONLY_TOOLS`, `SUBAGENT_SYSTEM_HINT`. Worker-pool bounded by `SUBAGENT_CONCURRENCY` (default 4, cap 8); never rejects; results preserve input order; parent `signal` forwarded to all children.
- `agent/executor.ts`: `spawn_subagents` case (parses `<subtasks>` one-per-line, strips `-`/`*`/`1.`/`TASK:` prefixes, caps at `MAX_SUBAGENTS_PER_CALL`=6); `ToolContext.allowedTools` enforcement (read-only confinement + nested-fan-out block).
- `agent/runner.ts`: `AgentRunOptions.allowedTools | maxIterations | skipCheckpoint | systemHint`.
- Events: `subagent_start | subagent_event | subagent_done` flow through the existing agent event stream (typed `unknown` over IPC; renderer consumes in P3).
- Env knobs: `SUBAGENT_CONCURRENCY` (1–8, default 4), `MAX_SUBAGENTS_PER_CALL` (default 6).

## 6. Open decisions (need owner input)

| # | Question | Decision |
|---|---|---|
| O1 | Sub-agents read-only in v1? | ✅ **Confirmed: Yes** — read/analyze-only; writes & commands stay on the parent |
| O2 | Default concurrency | ✅ **Confirmed: 4** (hard cap 8) |
| O3 | Allow nested fan-out? | **No** in v1 (pending) |
| O4 | Synthesis: parent LLM re-reads all sub-results, or an explicit "synthesize" sub-call? | **Parent re-reads** (one OBSERVATION) — pending |
| O5 | Should sub-agents share the parent's `readCache`? | **No** (isolation > token savings in v1) — pending |
```
