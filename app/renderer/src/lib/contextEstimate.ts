import type { SettingsPayload } from "./api";
import { api } from "./api";
import { composeAgentTaskWithHistory, type ChatSession, type ChatTurn } from "./sessions";

export function formatContextTokens(tokens: number): string {
  if (tokens >= 10_000) return `${(tokens / 1000).toFixed(1)}K`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}

export interface ContextSegment {
  id: string;
  label: string;
  tokens: number;
  chars?: number;
  color: string;
}

export interface ContextUsage {
  segments: ContextSegment[];
  totalTokens: number;
  inputTokensMeasured?: number;
  completionTokens?: number;
  limitTokens: number;
  percent: number;
  source: "measured" | "api" | "preview";
  trimmed?: boolean;
}

/** @deprecated alias */
export type ContextEstimate = ContextUsage;

export function snapshotToContextUsage(snap: {
  segments: ContextSegment[];
  inputTokens: number;
  inputTokensMeasured?: number;
  completionTokensApi?: number;
  limitTokens: number;
  percent: number;
  source: "measured" | "api" | "preview";
  trimmed?: boolean;
}): ContextUsage {
  return {
    segments: snap.segments,
    totalTokens: snap.inputTokens,
    inputTokensMeasured: snap.inputTokensMeasured,
    completionTokens: snap.completionTokensApi,
    limitTokens: snap.limitTokens,
    percent: snap.percent,
    source: snap.source,
    trimmed: snap.trimmed,
  };
}

export function contextUsageFromEvent(ev: Record<string, unknown>): ContextUsage | null {
  if (ev.type !== "context_usage") return null;
  const segments = Array.isArray(ev.segments) ? (ev.segments as ContextSegment[]) : [];
  const inputTokens = Number(ev.inputTokens) || 0;
  const limitTokens = Number(ev.limitTokens) || 128_000;
  const percent = Number(ev.percent) || Math.min(100, Math.round((inputTokens / limitTokens) * 100));
  const source = ev.source === "api" || ev.source === "preview" ? ev.source : "measured";
  return snapshotToContextUsage({
    segments,
    inputTokens,
    inputTokensMeasured: Number(ev.inputTokensMeasured) || undefined,
    completionTokensApi: Number(ev.completionTokensApi) || undefined,
    limitTokens,
    percent,
    source,
    trimmed: Boolean(ev.trimmed),
  });
}

export async function fetchContextPreview(opts: {
  session: ChatSession;
  taskDraft: string;
  mode: "ask" | "agent";
}): Promise<ContextUsage | null> {
  const { session, taskDraft, mode } = opts;
  const priorTurns = session.turns.filter((t) => t.status !== "running");
  const task =
    mode === "agent"
      ? composeAgentTaskWithHistory(priorTurns, taskDraft.trim())
      : taskDraft.trim();
  if (!task.trim()) return null;
  try {
    const snap = (await api.contextPreview(task, mode)) as {
      segments: ContextSegment[];
      inputTokens: number;
      inputTokensMeasured: number;
      completionTokensApi?: number;
      limitTokens: number;
      percent: number;
      source: "measured" | "api" | "preview";
      trimmed: boolean;
    };
    return snapshotToContextUsage(snap);
  } catch {
    return null;
  }
}

export function latestContextFromTurn(turn: ChatTurn | undefined): ContextUsage | null {
  if (!turn) return null;
  for (let i = turn.events.length - 1; i >= 0; i--) {
    const ev = turn.events[i] as Record<string, unknown>;
    const usage = contextUsageFromEvent(ev);
    if (usage) return usage;
  }
  return null;
}

/** @deprecated Use fetchContextPreview or context events instead. */
export function estimateContextUsage(_opts: {
  session: ChatSession;
  taskDraft: string;
  mode: "ask" | "agent";
  llmSettings?: SettingsPayload | null;
}): ContextUsage {
  return {
    segments: [],
    totalTokens: 0,
    limitTokens: 128_000,
    percent: 0,
    source: "preview",
  };
}
