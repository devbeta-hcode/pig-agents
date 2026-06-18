export type AgentStep =
  | { kind: "action"; thought: string; type: string; input: Record<string, unknown> }
  | { kind: "multi_action"; thought: string; actions: Array<{ type: string; input: Record<string, unknown> }> }
  | { kind: "final"; thought: string; result: string }
  | { kind: "error"; raw: string; error: string };

import { actionScheduleKey } from "./actionKey.js";
import { extractBlock, normalizeAgentMarkers } from "./agentFormat.js";
import {
  extractCompleteXmlTools,
  nthToolBlockComplete,
  nthToolBlockRaw,
  peekStreamingToolName,
  toolBlockCount,
} from "./xmlTools.js";

/** True when every FILE: block in a write_patch payload has a closing END line. */
export function writePatchPayloadLooksComplete(patches: string): boolean {
  const t = patches.replace(/\r\n/g, "\n").trim();
  if (!t) return false;
  if (!/^FILE:/m.test(t)) return /\nREPLACE\n[\s\S]*\nEND\s*$/m.test(t) || /\nREPLACE\n/.test(t);
  const parts = t.split(/(?=^FILE:)/m).filter((p) => p.trim().startsWith("FILE:"));
  if (parts.length === 0) return false;
  return parts.every((seg) => /\nEND\s*$/m.test(seg.trim()) || /\nEND\n/.test(seg));
}

function pushActionWhenComplete(
  actions: Array<{ type: string; input: Record<string, unknown> }>,
  act: { type: string; input: Record<string, unknown> },
): void {
  if (act.type === "write_patch") {
    const patches = act.input.patches;
    if (typeof patches !== "string" || !writePatchPayloadLooksComplete(patches)) return;
  }
  actions.push(act);
}

/** While streaming, surface write_patch/create_file in the UI trace. */
export function detectStreamingToolPayload(buf: string): { tool: string } | null {
  const normalized = normalizeAgentMarkers(buf);
  const n = toolBlockCount(normalized);
  if (n === 0) return null;
  for (let i = n - 1; i >= 0; i--) {
    if (nthToolBlockComplete(normalized, i)) continue;
    const block = nthToolBlockRaw(normalized, i) ?? "";
    const name = peekStreamingToolName(block);
    if (name === "write_patch" || name === "create_file") return { tool: name };
    return null;
  }
  return null;
}

/** Extract all complete `<tool>` blocks (streaming + post-stream). */
export function extractAllActions(
  text: string,
): Array<{ type: string; input: Record<string, unknown> }> {
  const normalized = normalizeAgentMarkers(text);
  const actions: Array<{ type: string; input: Record<string, unknown> }> = [];
  for (const t of extractCompleteXmlTools(normalized)) {
    pushActionWhenComplete(actions, { type: t.type, input: t.input });
  }
  const seen = new Set<string>();
  const deduped: Array<{ type: string; input: Record<string, unknown> }> = [];
  for (const act of actions) {
    const key = actionScheduleKey(act.type, act.input);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(act);
  }
  return deduped;
}

function looksLikeCompleteAnswer(text: string): boolean {
  const lower = text.toLowerCase();
  const answerPatterns = [
    /^(yes|no|ok|sure|certainly|of course|definitely)/i,
    /^(the|this|that|it|i|we|you|here)/i,
    /^(đây|đó|vâng|không|được|có|là|tôi)/i,
    /^[\d.\-*]/,
  ];
  if (answerPatterns.some((p) => p.test(text.trim().slice(0, 30)))) {
    if (/(let me|i('ll| will| need to| should)|cần|phải|để)/i.test(lower)) return false;
    return true;
  }
  const completionIndicators = [
    "done", "complete", "finished", "success",
    "hoàn thành", "xong", "thành công", "đã",
    "here's", "here is", "đây là",
  ];
  return completionIndicators.some((ind) => lower.includes(ind));
}

export function parseAgentResponse(raw: string): AgentStep {
  const text = normalizeAgentMarkers(raw).trim();
  const thought = extractBlock(text, "THOUGHT") ?? "";

  const allActions = extractAllActions(text);
  if (allActions.length > 1) {
    return { kind: "multi_action", thought, actions: allActions };
  }
  if (allActions.length === 1) {
    return { kind: "action", thought, type: allActions[0].type, input: allActions[0].input };
  }

  const final = extractBlock(text, "FINAL");
  if (final !== null) {
    return { kind: "final", thought, result: final };
  }

  if (looksLikeCompleteAnswer(text) && !/<tool\s/i.test(text)) {
    const lower = text.toLowerCase();
    const wantsAction =
      /(let me|i('ll| will| need to| should| want to)|first|next|now|cần|phải|để|trước|tiếp)/i.test(lower) &&
      /(read|write|check|create|run|search|list|đọc|viết|kiểm tra|tạo|chạy|tìm)/i.test(lower);
    if (!wantsAction) {
      return { kind: "final", thought: "", result: text };
    }
  }

  return {
    kind: "error",
    raw,
    error: "Could not parse response — expected THOUGHT + <tool> or THOUGHT + FINAL",
  };
}

/** @deprecated Use normalizeAgentMarkers — kept for Chat.tsx import compatibility during sync. */
export function normalizeReActBoundaries(text: string): string {
  return normalizeAgentMarkers(text);
}

export { peekStreamingToolName, toolBlockCount, nthToolBlockComplete } from "./xmlTools.js";
